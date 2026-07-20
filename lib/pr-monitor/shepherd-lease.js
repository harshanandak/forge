'use strict';

/**
 * Shepherd singleton lease — a machine-wide "one watcher-set" guard for the PR
 * shepherd, fusing two existing precedents:
 *
 *   - `serve.lock`'s exclusive-create + foreign-PID block + stale reclaim
 *     (`lib/commands/_serve-security.js`), so a live foreign owner is never
 *     stolen but a dead/wedged one is reclaimed.
 *   - the journal lock's heartbeat + TTL staleness
 *     (`lib/pr-monitor/journal.js`), so a slow-but-alive owner refreshes its
 *     timestamp and a crashed owner ages out.
 *
 * The lock lives at `<gitCommonDir>/forge/shepherd.lock`, keyed by the SAME
 * `resolveGitCommonDir` the kernel DB uses — so every worktree of a repo shares
 * one lock. This module is the lease PRIMITIVE only: pure fs + I/O, no spawned
 * process and no reconcile loop (the daemon wires those up later).
 *
 * Payload JSON: `{ pid, startedAt, heartbeatAt, watchers: [prNumbers] }`.
 *
 * @module pr-monitor/shepherd-lease
 */

const fs = require('node:fs');
const path = require('node:path');
const { resolveGitCommonDir } = require('../kernel/broker');

/** A wedged owner whose heartbeat is older than this (ms) is reclaimable. */
const STALE_MS = 30000;
const LOCK_FILE_MODE = 0o600;

/**
 * Resolve the shared lock path. `gitCommonDir` may be injected (tests, or a
 * caller that already resolved it); otherwise it is resolved from `projectRoot`
 * with the same resolver the kernel broker uses.
 */
function lockFilePath(projectRoot, opts = {}) {
  const gitCommonDir = opts.gitCommonDir
    ? path.resolve(opts.gitCommonDir)
    : resolveGitCommonDir(projectRoot, opts);
  return path.join(gitCommonDir, 'forge', 'shepherd.lock');
}

/** Parse the lock payload, or null when missing/unreadable/corrupt. */
function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Is `pid` a live process? `process.kill(pid, 0)` sends no signal but throws
// ESRCH when the pid is gone. EPERM means it exists but isn't ours — still live.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Is a held lock stale (dead owner, or heartbeat older than STALE_MS)? */
function isHeldStale(held, { isAlive, now }) {
  if (!isAlive(held.pid)) return true;
  const beat = Date.parse(held.heartbeatAt);
  if (!Number.isFinite(beat)) return true;
  return now() - beat >= STALE_MS;
}

function writeLock(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload), { mode: LOCK_FILE_MODE });
}

/**
 * Try to claim the singleton lease.
 *   -> { ok:true, file }              first claim
 *   -> { ok:true, file, reclaimed }   stale lock (dead/wedged owner) reclaimed
 *   -> { ok:false, held }             a LIVE, FRESH foreign owner holds it
 *   -> { ok:false, held }             we lost a concurrent double-reclaim race
 *
 * `pid`/`isAlive`/`now` are injectable for testing. `onReclaimWrite` is a test
 * seam invoked immediately after the reclaim write and before the confirm
 * re-read, so a test can simulate a competitor overwriting the file.
 */
function acquire(projectRoot, {
  gitCommonDir,
  pid = process.pid,
  isAlive = pidAlive,
  now = () => Date.now(),
  onReclaimWrite = null,
} = {}) {
  const file = lockFilePath(projectRoot, { gitCommonDir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const iso = new Date(now()).toISOString();
  const payload = { pid, startedAt: iso, heartbeatAt: iso, watchers: [] };

  try {
    // Exclusive create: EEXIST if a lock is already present.
    const fd = fs.openSync(file, 'wx', LOCK_FILE_MODE);
    try {
      fs.writeSync(fd, JSON.stringify(payload));
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, file };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  // A lock exists. A DIFFERENT, live, fresh owner blocks us.
  const held = readLock(file);
  if (held && held.pid !== pid && !isHeldStale(held, { isAlive, now })) {
    return { ok: false, held };
  }

  // Stale (dead/wedged owner, unreadable, or already ours) — reclaim. The write
  // is not atomic against a simultaneous double-reclaim (see
  // _serve-security.js:164-165), so after writing we RE-READ and confirm our
  // pid won; a foreign pid means a competitor overwrote us — back off.
  writeLock(file, payload);
  if (typeof onReclaimWrite === 'function') onReclaimWrite();
  const after = readLock(file);
  if (!after || after.pid !== pid) {
    return { ok: false, held: after };
  }
  return { ok: true, file, reclaimed: true };
}

/**
 * Refresh `heartbeatAt` on OUR lock. Returns false (a no-op) when the lock is
 * missing or owned by another pid — we never stamp a foreign lock.
 */
function stamp(projectRoot, { gitCommonDir, pid = process.pid, now = () => Date.now() } = {}) {
  const file = lockFilePath(projectRoot, { gitCommonDir });
  const held = readLock(file);
  if (!held || held.pid !== pid) return false;
  held.heartbeatAt = new Date(now()).toISOString();
  writeLock(file, held);
  return true;
}

/**
 * Start a heartbeat timer that stamps `heartbeatAt` every STALE_MS/3. The timer
 * is `.unref()`ed so it never keeps the process alive. Returns the handle for
 * `stopHeartbeat`.
 */
function startHeartbeat(projectRoot, opts = {}) {
  const timer = setInterval(() => stamp(projectRoot, opts), Math.max(1, Math.floor(STALE_MS / 3)));
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

/** Stop a heartbeat timer started by `startHeartbeat`. */
function stopHeartbeat(timer) {
  if (timer) clearInterval(timer);
}

/**
 * Rewrite the `watchers[]` array on OUR lock. Returns false when the lock is
 * missing or foreign-owned.
 */
function updateWatchers(projectRoot, prNumbers, { gitCommonDir, pid = process.pid } = {}) {
  const file = lockFilePath(projectRoot, { gitCommonDir });
  const held = readLock(file);
  if (!held || held.pid !== pid) return false;
  held.watchers = Array.isArray(prNumbers) ? prNumbers : [];
  writeLock(file, held);
  return true;
}

/**
 * Release the lease — delete the lock ONLY when it is ours (matching pid), so a
 * foreign or reclaimed lock is never removed out from under its owner.
 */
function release(projectRoot, { gitCommonDir, pid = process.pid } = {}) {
  const file = lockFilePath(projectRoot, { gitCommonDir });
  try {
    const held = readLock(file);
    if (held && held.pid === pid) fs.rmSync(file, { force: true });
  } catch {
    /* best effort — a failed release just leaves a stale lock to be reclaimed */
  }
}

module.exports = {
  STALE_MS,
  lockFilePath,
  pidAlive,
  acquire,
  stamp,
  startHeartbeat,
  stopHeartbeat,
  updateWatchers,
  release,
};
