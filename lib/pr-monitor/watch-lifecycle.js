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

const journal = require('./journal');

/** Absolute path to the forge CLI entrypoint (this file is lib/pr-monitor/). */
function forgeBin() {
  return path.join(__dirname, '..', '..', 'bin', 'forge.js');
}

/**
 * Best-effort repo slug (the bare repo NAME, matching the shepherd's `ctx.repo`)
 * from `git remote get-url origin`, so the idempotency check hits the same
 * journal dir the watcher itself uses. Returns null on any failure — the caller
 * then falls through to spawn and relies on the watch loop's own de-dup.
 */
function defaultResolveSlug({ cwd, exec = execFileSync }) {
  try {
    const url = exec('git', ['remote', 'get-url', 'origin'], {
      cwd, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = /[/:][^/]+\/([^/]+?)(?:\.git)?$/.exec(url);
    return match ? match[1] : null;
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
 * @param {Function} [opts.exec] - git runner for slug resolution (test injection).
 * @param {object} [opts.journal] - journal module (test injection).
 * @param {Function} [opts.resolveSlug] - slug resolver (test injection).
 * @returns {{ started: boolean, pid?: number|null, reason?: string }} — never throws.
 */
function startPrWatcherDetached(opts = {}) {
  const { prNumber, cwd = process.cwd() } = opts;
  const spawnFn = opts.spawn || spawn;
  const journalMod = opts.journal || journal;
  const resolveSlug = opts.resolveSlug || defaultResolveSlug;
  try {
    if (!prNumber) return { started: false, reason: 'no-pr' };

    const slug = resolveSlug({ cwd, exec: opts.exec });
    if (slug) {
      const dir = journalMod.journalDir({ root: cwd, repo: slug, pr: prNumber });
      if (journalMod.watcherRunning(dir)) return { started: false, reason: 'already-running' };
    }

    const child = spawnFn(
      process.execPath,
      [forgeBin(), 'shepherd', 'watch', String(prNumber)],
      { cwd, detached: true, stdio: 'ignore', windowsHide: true },
    );
    // spawn can emit an ASYNC 'error' (ENOENT/EACCES) AFTER returning; with no
    // listener that becomes an unhandled exception that could crash ship. A no-op
    // handler keeps a failed detached start best-effort (the watch loop's own
    // journal claim is the authoritative de-dup anyway).
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return { started: true, pid: child?.pid ?? null };
  } catch (err) {
    // Lifecycle auto-start must never fail ship — degrade to "not started".
    return { started: false, reason: err.message };
  }
}

module.exports = {
  startPrWatcherDetached,
  defaultResolveSlug,
  forgeBin,
};
