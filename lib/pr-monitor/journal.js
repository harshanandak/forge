'use strict';

/**
 * PR-monitor journal — per-PR append-only NDJSON event log plus an atomic
 * snapshot fingerprint, under `.forge/pr-monitor/<repo>-<pr>/`. The journal is
 * the CURSOR AUTHORITY: it survives crashes and is shared across processes and
 * worktrees, and works with no kernel configured. A consumer keeps its own `seq`
 * cursor and reads new events with `readEventsSince`.
 *
 * Ordering contract (exactly-once): a monitor pass APPENDS events, THEN writes
 * the snapshot together with an `appliedSeq` cursor (the highest seq that
 * snapshot accounts for). If a crash lands between the append and the snapshot
 * write, the persisted `appliedSeq` still points BEFORE the just-appended tail,
 * so the next pass re-diffs the old snapshot, recomputes the same `(type,key)`
 * events, and `seenIdentities(dir, appliedSeq)` filters exactly that pending tail
 * — no duplicate is ever journaled. Crucially the dedup is scoped to that
 * pending/crash-recovery window, NOT the whole journal history: a value that
 * flips back to a prior state (fail → green → fail on the same sha) legitimately
 * re-emits, because the earlier identity sits at/below `appliedSeq`.
 *
 * Concurrency: multiple processes/worktrees can poll the same PR. The
 * read→diff→dedup→append→snapshot critical section is serialized across
 * processes by `withJournalLock` (a crash-recoverable lock-directory), so
 * concurrent passes can never interleave appends or reuse a sequence number.
 *
 * @module pr-monitor/journal
 */

const fs = require('node:fs');
const path = require('node:path');
const { eventIdentity } = require('./events');

/** Sanitize a repo slug for a filesystem directory name. */
function sanitize(part) {
  return String(part || '').replace(/[^A-Za-z0-9._-]+/g, '-');
}

/**
 * Resolve (and create) the per-PR journal directory.
 *
 * @param {{ root: string, repo: string, pr: string|number }} ctx
 * @returns {string} absolute directory path
 */
function journalDir({ root, repo, pr }) {
  const dir = path.join(root, '.forge', 'pr-monitor', `${sanitize(repo)}-${sanitize(pr)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function journalPath(dir) { return path.join(dir, 'events.ndjson'); }
function snapshotPath(dir) { return path.join(dir, 'snapshot.json'); }
function pidPath(dir) { return path.join(dir, 'watch.pid'); }
function lockPath(dir) { return path.join(dir, 'journal.lock'); }

/**
 * Read all journal records (NDJSON), skipping any unparseable line so one
 * corrupt tail line never blinds the cursor.
 *
 * @param {string} dir
 * @returns {object[]}
 */
function readAllEvents(dir) {
  const file = journalPath(dir);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip corrupt line */ }
  }
  return out;
}

/** Records with `seq > sinceSeq`, in journal order. */
function readEventsSince(dir, sinceSeq) {
  const since = Number(sinceSeq) || 0;
  return readAllEvents(dir).filter((e) => Number(e.seq) > since);
}

/** Highest `seq` recorded so far (0 when empty). */
function lastSeq(dir) {
  let max = 0;
  for (const e of readAllEvents(dir)) {
    const s = Number(e.seq) || 0;
    if (s > max) max = s;
  }
  return max;
}

/**
 * Set of `(type,key)` identities journaled with `seq > sinceSeq` — the dedup
 * guard, SCOPED to the crash-recovery/pending window above the snapshot cursor.
 *
 * With `sinceSeq = 0` (no snapshot, or an explicit full scan) it covers the
 * whole history, which is the correct behaviour during crash recovery when the
 * snapshot is missing. With `sinceSeq = appliedSeq` it covers only the events
 * the current snapshot has NOT yet accounted for, so an identity that recurs
 * after a full round-trip (e.g. fail → green → fail) is NOT suppressed forever.
 *
 * @param {string} dir
 * @param {number} [sinceSeq=0]
 * @returns {Set<string>}
 */
function seenIdentities(dir, sinceSeq = 0) {
  const since = Number(sinceSeq) || 0;
  const set = new Set();
  for (const e of readAllEvents(dir)) {
    if ((Number(e.seq) || 0) > since) set.add(eventIdentity(e));
  }
  return set;
}

/** Append finalized records as NDJSON lines (atomic per-line append). */
function appendEvents(dir, records) {
  if (!records?.length) return;
  const payload = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(journalPath(dir), payload);
}

/**
 * Read the persisted snapshot + fingerprint + `appliedSeq`, or null when
 * absent/unreadable. `appliedSeq` is the highest journal seq this snapshot
 * accounts for (0 for legacy snapshots written before the cursor existed); it
 * bounds the dedup window in `seenIdentities`.
 *
 * @param {string} dir
 * @returns {{ snapshot: object, fingerprint: string, appliedSeq: number }|null}
 */
function readSnapshot(dir) {
  const file = snapshotPath(dir);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      snapshot: data.snapshot || null,
      fingerprint: data.fingerprint || null,
      appliedSeq: Number(data.appliedSeq) || 0,
    };
  } catch { return null; }
}

/**
 * Atomically persist the snapshot + fingerprint + `appliedSeq` (write temp, then
 * rename). The rename is atomic on the same filesystem, so a reader never sees a
 * half-write.
 *
 * @param {string} dir
 * @param {{ snapshot: object, fingerprint: string, appliedSeq?: number }} payload
 */
function writeSnapshot(dir, { snapshot, fingerprint, appliedSeq = 0 }) {
  const tmp = path.join(dir, `.snapshot.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ snapshot, fingerprint, appliedSeq: Number(appliedSeq) || 0 }));
  fs.renameSync(tmp, snapshotPath(dir));
}

/** Non-blocking sleep for the lock retry loop. */
function delay(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

/**
 * Is the held lock stale? A lock is stale when its owner process is dead, or
 * when it has out-lived `staleMs` (guards against a reused pid or a crash that
 * left no readable owner file). Either way it is safe to steal.
 */
function lockIsStale(lock, staleMs) {
  let ownerPid = null;
  let stampedAt = null;
  try {
    const [pidStr, tsStr] = fs.readFileSync(path.join(lock, 'owner'), 'utf8').split(':');
    ownerPid = Number.parseInt(pidStr, 10);
    stampedAt = Number.parseInt(tsStr, 10);
  } catch { /* owner file missing/unreadable → fall through to age check */ }
  if (ownerPid && !pidAlive(ownerPid)) return true;
  let ageBase = stampedAt;
  if (!Number.isFinite(ageBase)) {
    try { ageBase = fs.statSync(lock).mtimeMs; } catch { return true; }
  }
  return Date.now() - ageBase > staleMs;
}

/** Remove a lock directory (owner file + dir), best-effort. */
function releaseLock(lock) {
  try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* already gone */ }
}

/**
 * Run `fn` while holding the per-PR journal lock, serializing the
 * read→diff→dedup→append→snapshot critical section across processes and
 * worktrees. The lock is a directory created with an atomic `mkdir` (fails with
 * EEXIST when held); a crash-recoverable staleness check lets a later caller
 * steal a lock whose owner died or that out-lived `staleMs`. The lock is always
 * released in a `finally`, on success or throw.
 *
 * @param {string} dir - journal directory.
 * @param {() => Promise<T>|T} fn - critical section.
 * @param {{ staleMs?: number, retries?: number, waitMs?: number }} [opts]
 * @returns {Promise<T>}
 * @template T
 */
async function withJournalLock(dir, fn, opts = {}) {
  const { staleMs = 30000, retries = 600, waitMs = 25 } = opts;
  const lock = lockPath(dir);
  let acquired = false;
  for (let i = 0; i < retries && !acquired; i += 1) {
    try {
      fs.mkdirSync(lock);
      acquired = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (lockIsStale(lock, staleMs)) { releaseLock(lock); continue; }
      await delay(waitMs);
    }
  }
  if (!acquired) throw new Error(`journal lock busy after ${retries} tries: ${lock}`);
  try {
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}:${Date.now()}`);
    return await fn();
  } finally {
    releaseLock(lock);
  }
}

/** Write the watcher pid file. */
function writePid(dir, pid) {
  fs.writeFileSync(pidPath(dir), String(pid == null ? process.pid : pid));
}

/** Read the watcher pid (number) or null. */
function readPid(dir) {
  const file = pidPath(dir);
  if (!fs.existsSync(file)) return null;
  const n = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Remove the watcher pid file (best-effort). */
function removePid(dir) {
  try { fs.unlinkSync(pidPath(dir)); } catch { /* already gone */ }
}

/** Is `pid` a live process? `process.kill(pid, 0)` probes without signaling. */
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

/**
 * A watcher is "running" when the pid file names a live process that is NOT us.
 * Stale pid files (dead process) return false so a poll falls back to an inline
 * pass.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function watcherRunning(dir) {
  const pid = readPid(dir);
  return pidAlive(pid) && pid !== process.pid;
}

module.exports = {
  sanitize,
  journalDir,
  journalPath,
  snapshotPath,
  pidPath,
  lockPath,
  withJournalLock,
  readAllEvents,
  readEventsSince,
  lastSeq,
  seenIdentities,
  appendEvents,
  readSnapshot,
  writeSnapshot,
  writePid,
  readPid,
  removePid,
  pidAlive,
  watcherRunning,
};
