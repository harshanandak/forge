'use strict';

/**
 * Shared-machine hardening for `forge serve` — three cheap "ALWAYS" controls.
 *
 * `forge serve` binds loopback only and token-gates every read/write, but on a
 * multi-user box the process still lives in a shared filesystem. These controls
 * raise the floor without adding accounts, a daemon, or cloud:
 *
 *   1. serve.lock — a single-instance guard so a second `forge serve` for the
 *      SAME project can't silently start and port-squat. Stale locks (dead PID)
 *      are reclaimed; a live holder blocks. Released cleanly on exit.
 *   2. securePath() — create the lock/journal and their directory owner-only
 *      (files 0o600, dirs 0o700) AT CREATION, plus a startup audit that warns
 *      loudly if a sensitive path is group/other-readable.
 *   3. A hash-chained mutation journal — each appended record carries
 *      sha256(prevHash ‖ record), so an attacker cannot silently edit or delete
 *      a past entry without breaking the chain. verifyJournal() proves it.
 *
 * Windows honesty: chmod on Windows only toggles the read-only bit — it does NOT
 * change NTFS ACLs — and `fs.stat().mode` does not reflect ACLs. So on Windows
 * securePath() is a best-effort no-op (reported as `applied:false`) and the
 * audit refuses to raise false alarms from meaningless mode bits (it flags the
 * platform caveat instead). The lock + hash-chain logic is platform-independent.
 *
 * State lives under `.forge/serve/` (owner-only) so we never re-chmod the shared
 * `.forge/` config directory out from under other tooling.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;
const GENESIS_HASH = '0'.repeat(64);
const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function serveStateDir(projectRoot) {
  return path.join(projectRoot, '.forge', 'serve');
}
function lockPath(projectRoot) {
  return path.join(serveStateDir(projectRoot), 'serve.lock');
}
function journalPath(projectRoot) {
  return path.join(serveStateDir(projectRoot), 'journal.jsonl');
}

// ---------------------------------------------------------------------------
// 2. Perms — securePath / writeSecret / ensureSecureDir + startup audit
// ---------------------------------------------------------------------------

// Tighten an existing path to owner-only. POSIX: real chmod. Windows: chmod only
// flips the read-only bit (ACLs untouched), so we report applied:false — the
// caller and the security doc treat Windows perms as best-effort.
function securePath(target, { dir = false } = {}) {
  const mode = dir ? SECRET_DIR_MODE : SECRET_FILE_MODE;
  try {
    fs.chmodSync(target, mode);
    return { ok: true, applied: !IS_WINDOWS, mode };
  } catch (err) {
    return { ok: false, applied: false, error: err.message };
  }
}

// Create/overwrite a file with owner-only perms AT CREATION. The `mode` option
// governs the perms for a NEW file; an existing file keeps its perms on write,
// so we chmod afterwards to be certain it is tight either way.
function writeSecret(target, data) {
  ensureSecureDir(path.dirname(target));
  fs.writeFileSync(target, data, { mode: SECRET_FILE_MODE });
  securePath(target);
}

// Create a directory owner-only (recursive). Tighten it afterwards in case it
// already existed with looser perms that we own.
function ensureSecureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
  securePath(dir, { dir: true });
}

// Inspect one path: does it exist, and is it group/other-readable? On Windows
// the mode bits are meaningless for ACLs, so we never mark it world-readable —
// we surface `platformCaveat:true` so the caller can print an honest note.
function auditPath(target) {
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return { path: target, exists: false, worldReadable: false, platformCaveat: IS_WINDOWS };
  }
  const mode = st.mode & 0o777;
  const worldReadable = !IS_WINDOWS && (mode & 0o077) !== 0;
  return { path: target, exists: true, mode, worldReadable, platformCaveat: IS_WINDOWS };
}

// Audit a set of sensitive paths. `ok:false` when any existing path is
// group/other-readable (POSIX). Callers warn loudly on the offenders.
function auditPaths(targets) {
  const results = targets.map(auditPath);
  const offenders = results.filter((r) => r.exists && r.worldReadable);
  return { ok: offenders.length === 0, offenders, results };
}

// ---------------------------------------------------------------------------
// 1. serve.lock — single-instance guard
// ---------------------------------------------------------------------------

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

// Try to claim the single-instance lock for this project.
//   -> { ok:true, file }            first claim
//   -> { ok:true, file, reclaimed } stale lock (dead holder) reclaimed
//   -> { ok:false, held }           a LIVE holder already owns it (blocked)
// `pid` / `isAlive` are injectable for testing; production uses the real pid and
// a real liveness probe.
function acquireLock(projectRoot, { pid = process.pid, port = null, isAlive = pidAlive } = {}) {
  const file = lockPath(projectRoot);
  ensureSecureDir(path.dirname(file));
  const payload = JSON.stringify({ pid, port, startedAt: new Date().toISOString() });

  try {
    // Exclusive create: EEXIST if a lock is already present.
    const fd = fs.openSync(file, 'wx', SECRET_FILE_MODE);
    try {
      fs.writeSync(fd, payload);
    } finally {
      fs.closeSync(fd);
    }
    securePath(file);
    return { ok: true, file };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  // A lock exists. If a DIFFERENT process still holds it and is alive, block.
  const held = readLock(file);
  if (held && held.pid !== pid && isAlive(held.pid)) {
    return { ok: false, held };
  }
  // Otherwise it is stale (dead holder, unreadable, or already ours) — reclaim.
  // NOTE: reclaim is best-effort and not itself atomic across a simultaneous
  // double-reclaim race; acceptable for a cheap loopback dev-server guard.
  fs.writeFileSync(file, payload, { mode: SECRET_FILE_MODE });
  securePath(file);
  return { ok: true, file, reclaimed: true };
}

// Release ONLY if the lock is ours (matching pid), so a reclaimed/foreign lock
// is never deleted out from under its owner.
function releaseLock(projectRoot, { pid = process.pid } = {}) {
  const file = lockPath(projectRoot);
  try {
    const held = readLock(file);
    if (held && held.pid === pid) fs.rmSync(file, { force: true });
  } catch {
    /* best effort — a failed release just leaves a stale lock to be reclaimed */
  }
}

// ---------------------------------------------------------------------------
// 3. Hash-chained tamper-evident journal
// ---------------------------------------------------------------------------

// hash = sha256(prevHash ‖ JSON(record-without-hash)). The prevHash is embedded
// in the record too, so both a payload edit and a record deletion break verify.
function recordHash(prevHash, record) {
  return crypto.createHash('sha256').update(`${prevHash}\n${JSON.stringify(record)}`).digest('hex');
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function lastHash(lines) {
  if (!lines || !lines.length) return GENESIS_HASH;
  try {
    return JSON.parse(lines[lines.length - 1]).hash || GENESIS_HASH;
  } catch {
    return GENESIS_HASH;
  }
}

// Append a tamper-evident record. `entry` is arbitrary JSON (e.g. { verb, ok,
// actor, origin }). Returns { seq, hash }. Best-effort perms on first create.
function appendJournal(projectRoot, entry) {
  const file = journalPath(projectRoot);
  ensureSecureDir(path.dirname(file));
  const existed = fs.existsSync(file);
  const lines = existed ? readLines(file) : [];
  const prevHash = lastHash(lines);
  const seq = lines ? lines.length : 0;
  // Key order is fixed (seq, ts, prevHash, ...entry) so the stored record,
  // minus its hash, re-serializes identically at verify time.
  const record = { seq, ts: new Date().toISOString(), prevHash, ...entry };
  const hash = recordHash(prevHash, record);
  fs.appendFileSync(file, `${JSON.stringify({ ...record, hash })}\n`, { mode: SECRET_FILE_MODE });
  if (!existed) securePath(file);
  return { seq, hash };
}

// Re-walk the chain from genesis. Returns { ok:true, entries } or
// { ok:false, brokenAt, reason } at the first record that fails to verify.
function verifyJournal(projectRoot) {
  const file = journalPath(projectRoot);
  const lines = readLines(file);
  if (lines === null) return { ok: true, entries: 0, empty: true };
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < lines.length; i += 1) {
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      return { ok: false, brokenAt: i, reason: 'unparseable record' };
    }
    const { hash, ...rest } = parsed;
    if (rest.prevHash !== prevHash) {
      return { ok: false, brokenAt: i, reason: 'prevHash mismatch (record inserted or deleted)' };
    }
    if (recordHash(prevHash, rest) !== hash) {
      return { ok: false, brokenAt: i, reason: 'hash mismatch (record edited)' };
    }
    prevHash = hash;
  }
  return { ok: true, entries: lines.length, head: prevHash };
}

module.exports = {
  serveStateDir,
  lockPath,
  journalPath,
  securePath,
  writeSecret,
  ensureSecureDir,
  auditPath,
  auditPaths,
  acquireLock,
  releaseLock,
  readLock,
  pidAlive,
  appendJournal,
  verifyJournal,
  GENESIS_HASH,
};
