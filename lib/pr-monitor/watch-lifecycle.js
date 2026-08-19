'use strict';

/**
 * PR-monitor lifecycle — auto-start the watch loop, detached and idempotent, on
 * `forge ship` success. This is what makes the monitor CONSTANT without an agent
 * having to remember to run it: the moment a PR exists, a background
 * `forge shepherd watch <pr>` begins keeping the journal warm, and any harness
 * re-attaches later with `forge shepherd events <pr> --since <seq>`.
 *
 * Contract (all guaranteed here): NEVER throws, NEVER blocks, NEVER fails ship.
 * The detached child is `unref`'d so it cannot keep the ship process alive, and
 * every branch is wrapped so a spawn/gh failure degrades to "not started" rather
 * than surfacing to the caller. Stop-on-merge belongs to the watch loop's
 * terminal pass, not here.
 *
 * @module pr-monitor/watch-lifecycle
 */

const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const watchOwner = require('./watch-owner');

const CANONICAL_REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

async function launchGateComplete(owner = watchOwner, ownerOptions = {}) {
  if (typeof owner?.readMigrationGate !== 'function') return false;
  try {
    const result = await owner.readMigrationGate({}, ownerOptions);
    return result?.ok === true && result.gate?.state === 'complete';
  } catch {
    return false;
  }
}

/** Absolute path to the forge CLI entrypoint (this file is lib/pr-monitor/). */
function forgeBin() {
  return path.join(__dirname, '..', '..', 'bin', 'forge.js');
}

/**
 * Parse a canonical `owner/repository` from an origin URL. Production launchers
 * supply the provider-resolved base repository; this remains a bounded utility
 * for diagnostics and compatibility callers.
 */
function defaultResolveSlug({ cwd, exec = execFileSync }) {
  try {
    const url = exec('git', ['remote', 'get-url', 'origin'], {
      cwd, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    }).trim();
    const match = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Start (or no-op) a detached `forge shepherd watch <pr>`.
 *
 * @param {object} opts
 * @param {string|number} opts.prNumber - the PR to watch.
 * @param {string} [opts.cwd] - repo root (default process.cwd()).
 * @param {Function} [opts.spawn] - child spawner (test injection).
 * @param {string} opts.repository - canonical provider base repository.
 * @param {object} [opts.reservation] - exact pre-reserved owner envelope.
 * @param {object} [opts.owner] - watcher owner API (test injection).
 * @param {object} [opts.ownerOptions] - Kernel driver and evidence verification.
 * @returns {Promise<{ started: boolean, pid?: number|null, reason?: string }>} — never throws.
 */
async function startPrWatcherDetached(opts = {}) {
  const { prNumber, cwd = process.cwd() } = opts;
  const spawnFn = opts.spawn || spawn;
  const owner = opts.owner || watchOwner;
  const controllerPid = opts.controllerPid ?? process.pid;
  const repository = typeof opts.repository === 'string' ? opts.repository.toLowerCase() : '';
  const pr = Number(prNumber);
  let reservation = null;
  try {
    if (!Number.isSafeInteger(pr) || pr <= 0) return { started: false, reason: 'no-pr' };
    if (!CANONICAL_REPOSITORY.test(repository)) return { started: false, reason: 'repository-unavailable' };
    if (!Number.isSafeInteger(controllerPid) || controllerPid <= 0
      || typeof owner.abortStarting !== 'function'
      || (opts.reservation == null && typeof owner.reserveStarting !== 'function')) {
      return { started: false, reason: 'authority-unavailable' };
    }
    if (!await launchGateComplete(owner, opts.ownerOptions || {})) {
      return { started: false, reason: 'migration-gate-incomplete' };
    }

    const identity = { repo: repository, pr };
    if (opts.reservation != null) {
      reservation = opts.reservation;
      const record = reservation?.record;
      const startedAt = typeof record?.startedAt === 'string' ? new Date(record.startedAt) : null;
      const exactReservation = reservation?.ok === true
        && record?.repo === repository
        && record?.pr === pr
        && record?.phase === 'starting'
        && record?.controllerPid === controllerPid
        && typeof record?.generation === 'string'
        && record.generation.length > 0
        && startedAt != null
        && !Number.isNaN(startedAt.getTime())
        && startedAt.toISOString() === record.startedAt;
      if (!exactReservation) return { started: false, reason: 'invalid-reservation' };
    } else {
      reservation = await owner.reserveStarting(identity, { controllerPid }, opts.ownerOptions || {});
      if (!reservation?.ok && reservation?.record?.phase === 'complete' && opts.providerEvidence
        && typeof owner.reserveReopened === 'function') {
        reservation = await owner.reserveReopened(identity, {
          generation: reservation.record.generation,
          expectedReceiptId: reservation.record.terminalReceiptId,
          controllerPid,
          providerEvidence: opts.providerEvidence,
        }, opts.ownerOptions || {});
      }
    }
    if (!reservation?.ok || !reservation.record) {
      return { started: false, reason: reservation?.reason || 'authority-unavailable' };
    }
    if (!await launchGateComplete(owner, opts.ownerOptions || {})) {
      if (opts.reservation == null) {
        await owner.abortStarting(identity, {
          generation: reservation.record.generation, controllerPid,
        }, opts.ownerOptions || {});
      }
      return { started: false, reason: 'migration-gate-incomplete' };
    }

    const child = spawnFn(
      process.execPath,
      [
        forgeBin(), 'shepherd', 'watch', String(pr),
        '--repo', repository,
        '--generation', reservation.record.generation,
        '--controller-pid', String(controllerPid),
        '--started-at', reservation.record.startedAt,
      ],
      { cwd, detached: true, stdio: 'ignore', windowsHide: true },
    );
    // spawn can emit an ASYNC 'error' (ENOENT/EACCES) AFTER returning; with no
    // listener that becomes an unhandled exception that could crash ship. A no-op
    // handler keeps a failed detached start best-effort; the reservation is
    // conditionally aborted so a later controller can recover immediately.
    if (child && typeof child.on === 'function') {
      child.on('error', () => {
        void Promise.resolve()
          .then(() => owner.abortStarting(identity, {
            generation: reservation.record.generation, controllerPid,
          }, opts.ownerOptions || {}))
          .catch(() => { /* a stale starting row is recoverable by the daemon */ });
      });
    }
    if (child && typeof child.unref === 'function') child.unref();
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) {
      await owner.abortStarting(identity, {
        generation: reservation.record.generation, controllerPid,
      }, opts.ownerOptions || {});
      return { started: false, reason: 'spawn-pid-unavailable' };
    }
    return {
      started: true,
      pid: child.pid,
      generation: reservation.record.generation,
      startedAt: reservation.record.startedAt,
      repository,
    };
  } catch (err) {
    // Lifecycle auto-start must never fail ship — degrade to "not started".
    if (reservation?.record && CANONICAL_REPOSITORY.test(repository)) {
      try {
        await owner.abortStarting({ repo: repository, pr }, {
          generation: reservation.record.generation, controllerPid,
        }, opts.ownerOptions || {});
      } catch { /* a stale starting row is recoverable by the daemon */ }
    }
    return { started: false, reason: err.message };
  }
}

module.exports = {
  startPrWatcherDetached,
  launchGateComplete,
  defaultResolveSlug,
  forgeBin,
};
