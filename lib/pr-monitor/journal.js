'use strict';

/**
 * PR-monitor journal — per-PR append-only NDJSON event log plus an atomic
 * snapshot fingerprint, under `.forge/pr-monitor/<repo>-<pr>/`. The journal is
 * the CURSOR AUTHORITY: it survives crashes and is shared across processes and
 * worktrees, and works with no kernel configured. A consumer keeps its own `seq`
 * cursor and reads new events with `readEventsSince`.
 *
 * Ordering contract (exactly-once): a monitor pass APPENDS events, THEN writes
 * the snapshot. If a crash lands between, the next pass re-diffs the old snapshot
 * and recomputes the same `(type,key)` events — `seenIdentities` filters the ones
 * already appended, so no duplicate is ever journaled.
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

/** Set of `(type,key)` identities already journaled — the dedup guard. */
function seenIdentities(dir) {
  const set = new Set();
  for (const e of readAllEvents(dir)) set.add(eventIdentity(e));
  return set;
}

/** Append finalized records as NDJSON lines (atomic per-line append). */
function appendEvents(dir, records) {
  if (!records || !records.length) return;
  const payload = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(journalPath(dir), payload);
}

/**
 * Read the persisted snapshot + fingerprint, or null when absent/unreadable.
 *
 * @param {string} dir
 * @returns {{ snapshot: object, fingerprint: string }|null}
 */
function readSnapshot(dir) {
  const file = snapshotPath(dir);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { snapshot: data.snapshot || null, fingerprint: data.fingerprint || null };
  } catch { return null; }
}

/**
 * Atomically persist the snapshot + fingerprint (write temp, then rename). The
 * rename is atomic on the same filesystem, so a reader never sees a half-write.
 *
 * @param {string} dir
 * @param {{ snapshot: object, fingerprint: string }} payload
 */
function writeSnapshot(dir, { snapshot, fingerprint }) {
  const tmp = path.join(dir, `.snapshot.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ snapshot, fingerprint }));
  fs.renameSync(tmp, snapshotPath(dir));
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
  try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
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
