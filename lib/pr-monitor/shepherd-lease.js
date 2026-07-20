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
 * Payload JSON: `{ pid, token, startedAt, heartbeatAt, watchers: [prNumbers] }`.
 *
 * ## Ownership is by TOKEN, not pid
 * Each successful `acquire` mints a unique `token`. Every mutating op
 * (`stamp`/`updateWatchers`/`release`) verifies that token against the on-disk
 * lock before writing. A pid can be reused after a crash/reboot, and a wedged
 * owner can revive after its lease was reclaimed — in both cases the token no
 * longer matches, so the superseded holder can never resurrect or mutate a lease
 * it no longer owns. Takeover of a stale lock is made atomic by an O_EXCL create
 * (only one racer can win it), so two processes reclaiming the same stale lock
 * can never both succeed.
 *
 * @module pr-monitor/shepherd-lease
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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

/**
 * A lock is "ours" iff its unique lease `token` matches the one `acquire`
 * returned. Token is authoritative: a pid can be reused after a crash/reboot and
 * a wedged owner can revive after being reclaimed, so a pid match alone is NOT
 * proof of ownership. Only a hypothetical legacy lock with no `token` field falls
 * back to pid comparison.
 */
function ownsLock(held, { token, pid }) {
  if (held.token) return token !== undefined && held.token === token;
  return held.pid === pid;
}

function writeLock(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload), { mode: LOCK_FILE_MODE });
}

/**
 * Atomically create the lock with O_EXCL and write `payload`. Returns true when
 * we won the create, false on EEXIST (a concurrent contender holds it); other
 * errors rethrow. The O_EXCL create is the single atomic arbiter — of N racers
 * attempting it against the same absent path, exactly one succeeds.
 */
function tryExclusiveCreate(file, payload) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx', LOCK_FILE_MODE);
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, JSON.stringify(payload));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Try to claim the singleton lease.
 *   -> { ok:true, file, token }              first claim
 *   -> { ok:true, file, token, reclaimed }   stale lock (dead/wedged owner) reclaimed
 *   -> { ok:false, held }                    a LIVE, FRESH foreign owner holds it
 *   -> { ok:false, held }                    we lost the atomic takeover race
 *
 * `pid`/`isAlive`/`now`/`token` are injectable for testing. `onBeforeTakeover` is
 * a test seam invoked AFTER the stale lock is removed and BEFORE our exclusive
 * re-create, so a test can simulate a competitor winning the O_EXCL create first
 * (making our takeover lose).
 */
function acquire(projectRoot, {
  gitCommonDir,
  pid = process.pid,
  isAlive = pidAlive,
  now = () => Date.now(),
  token = crypto.randomUUID(),
  onBeforeTakeover = null,
} = {}) {
  const file = lockFilePath(projectRoot, { gitCommonDir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const iso = new Date(now()).toISOString();
  const payload = { pid, token, startedAt: iso, heartbeatAt: iso, watchers: [] };

  // Fast path: atomic exclusive create. Only ONE caller can win O_EXCL.
  if (tryExclusiveCreate(file, payload)) {
    return { ok: true, file, token };
  }

  // A lock exists. A DIFFERENT, live, fresh owner blocks us.
  const held = readLock(file);
  if (held && held.pid !== pid && !isHeldStale(held, { isAlive, now })) {
    return { ok: false, held };
  }

  // Stale (dead/wedged owner, unreadable, or already ours). Take over ATOMICALLY:
  // remove the stale lock, then re-create it with O_EXCL. If a competitor
  // recreated it first, our exclusive create fails (EEXIST) and we back off — so
  // two racers reclaiming the same stale lock can NEVER both win. A wedged owner
  // that revives after we delete its lock is stopped by the per-lease `token`
  // guard on stamp()/updateWatchers()/release(), never able to resurrect it here.
  fs.rmSync(file, { force: true });
  if (typeof onBeforeTakeover === 'function') onBeforeTakeover();
  if (!tryExclusiveCreate(file, payload)) {
    return { ok: false, held: readLock(file) };
  }
  return { ok: true, file, token, reclaimed: true };
}

/**
 * Refresh `heartbeatAt` on OUR lock. Returns false (a no-op) when the lock is
 * missing or NOT ours by `token` — we never stamp a lease we no longer own, so a
 * revived wedged owner cannot resurrect a reclaimed lease.
 */
function stamp(projectRoot, { gitCommonDir, token, pid = process.pid, now = () => Date.now() } = {}) {
  const file = lockFilePath(projectRoot, { gitCommonDir });
  const held = readLock(file);
  if (!held || !ownsLock(held, { token, pid })) return false;
  held.heartbeatAt = new Date(now()).toISOString();
  writeLock(file, held);
  return true;
}

/**
 * Start a heartbeat timer that stamps `heartbeatAt` every STALE_MS/3. The timer
 * is `.unref()`ed so it never keeps the process alive. `opts` MUST carry the
 * `token` returned by `acquire` (threaded straight through to `stamp`). Returns
 * the handle for `stopHeartbeat`.
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
 * missing or NOT ours by `token`.
 */
function updateWatchers(projectRoot, prNumbers, { gitCommonDir, token, pid = process.pid } = {}) {
  const file = lockFilePath(projectRoot, { gitCommonDir });
  const held = readLock(file);
  if (!held || !ownsLock(held, { token, pid })) return false;
  held.watchers = Array.isArray(prNumbers) ? prNumbers : [];
  writeLock(file, held);
  return true;
}

/**
 * Release the lease — delete the lock ONLY when it is ours by `token`, so a
 * foreign or already-reclaimed lock is never removed out from under its owner
 * (and a reused pid can never delete someone else's lease).
 */
function release(projectRoot, { gitCommonDir, token, pid = process.pid } = {}) {
  const file = lockFilePath(projectRoot, { gitCommonDir });
  try {
    const held = readLock(file);
    if (held && ownsLock(held, { token, pid })) fs.rmSync(file, { force: true });
  } catch {
    /* best effort — a failed release just leaves a stale lock to be reclaimed */
  }
}

module.exports = {
  STALE_MS,
  lockFilePath,
  pidAlive,
  ownsLock,
  acquire,
  stamp,
  startHeartbeat,
  stopHeartbeat,
  updateWatchers,
  release,
};
