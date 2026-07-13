'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const journal = require('../../lib/pr-monitor/journal');
const { eventIdentity } = require('../../lib/pr-monitor/events');

let root; let dir;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'prmon-j-'));
  dir = journal.journalDir({ root, repo: 'acme/forge', pr: '1' });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('journal', () => {
  test('journalDir sanitizes the repo slug and creates the dir', () => {
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toContain('acme-forge-1');
  });

  test('append + readEventsSince cursor + lastSeq + seenIdentities', () => {
    journal.appendEvents(dir, [
      { v: 1, seq: 1, type: 'a.b', key: 'k1' },
      { v: 1, seq: 2, type: 'c.d', key: 'k2' },
    ]);
    expect(journal.lastSeq(dir)).toBe(2);
    expect(journal.readEventsSince(dir, 1).map((e) => e.seq)).toEqual([2]);
    expect(journal.seenIdentities(dir).has(eventIdentity({ type: 'a.b', key: 'k1' }))).toBe(true);
  });

  test('a corrupt journal line is skipped, not fatal', () => {
    fs.appendFileSync(journal.journalPath(dir), '{"seq":1,"type":"a","key":"k"}\nnot-json\n');
    expect(journal.readAllEvents(dir)).toHaveLength(1);
  });

  test('writeSnapshot/readSnapshot round-trips atomically', () => {
    journal.writeSnapshot(dir, { snapshot: { headSha: 'sha1' }, fingerprint: 'fp1' });
    const read = journal.readSnapshot(dir);
    expect(read.fingerprint).toBe('fp1');
    expect(read.snapshot.headSha).toBe('sha1');
  });

  test('readSnapshot returns null when absent', () => {
    expect(journal.readSnapshot(dir)).toBeNull();
  });

  test('watcherRunning is false for a stale/own pid, so poll can fall back inline', () => {
    journal.writePid(dir, process.pid);
    expect(journal.watcherRunning(dir)).toBe(false); // our own pid is not a foreign watcher
    journal.removePid(dir);
    expect(journal.readPid(dir)).toBeNull();
  });

  test('writeSnapshot/readSnapshot carry an appliedSeq cursor (0 for legacy)', () => {
    journal.writeSnapshot(dir, { snapshot: { headSha: 's' }, fingerprint: 'fp', appliedSeq: 5 });
    expect(journal.readSnapshot(dir).appliedSeq).toBe(5);
    // Legacy snapshot without the field reads back as 0.
    fs.writeFileSync(journal.snapshotPath(dir), JSON.stringify({ snapshot: {}, fingerprint: 'fp' }));
    expect(journal.readSnapshot(dir).appliedSeq).toBe(0);
  });

  test('seenIdentities is scoped to seq > sinceSeq (not the whole history)', () => {
    journal.appendEvents(dir, [
      { v: 1, seq: 1, type: 'check.failed', key: 'ci:sha' },
      { v: 1, seq: 2, type: 'check.recovered', key: 'ci:sha' },
    ]);
    // Full-history default still sees the early identity...
    expect(journal.seenIdentities(dir).has(eventIdentity({ type: 'check.failed', key: 'ci:sha' }))).toBe(true);
    // ...but scoped past seq 2, the earlier check.failed is NOT suppressed, so a
    // re-failure on the same sha can legitimately re-emit.
    expect(journal.seenIdentities(dir, 2).has(eventIdentity({ type: 'check.failed', key: 'ci:sha' }))).toBe(false);
  });
});

describe('withJournalLock (cross-process serialization)', () => {
  test('serializes concurrent critical sections — no interleave', async () => {
    const order = [];
    const section = (id) => journal.withJournalLock(dir, async () => {
      order.push(`${id}:enter`);
      await new Promise((r) => { setTimeout(r, 15); });
      order.push(`${id}:exit`);
    });
    await Promise.all([section('A'), section('B')]);
    // Whoever entered first must exit before the other enters (no A:enter,B:enter,...).
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(order[0].replace(':enter', ':exit'));
    expect(order[3]).toBe(order[2].replace(':enter', ':exit'));
  });

  test('releases the lock on success AND on throw', async () => {
    await expect(journal.withJournalLock(dir, () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    expect(fs.existsSync(journal.lockPath(dir))).toBe(false);
    // Lock is reusable after the throw.
    const got = await journal.withJournalLock(dir, () => 'ok');
    expect(got).toBe('ok');
  });

  test('steals a stale lock whose owner process is dead', async () => {
    // Simulate a crashed holder: a lock dir with a dead pid stamped long ago.
    fs.mkdirSync(journal.lockPath(dir));
    fs.writeFileSync(path.join(journal.lockPath(dir), 'owner'), '999999999:1');
    const got = await journal.withJournalLock(dir, () => 'recovered', { retries: 5, waitMs: 5 });
    expect(got).toBe('recovered');
  });

  test('heartbeats the owner timestamp so a healthy long pass is never mistaken for stale', async () => {
    // A pass that outlives staleMs several times over — without the heartbeat,
    // the single acquisition-time timestamp would age well past staleMs and a
    // competing caller would see (and steal) the lock as stale mid-flight.
    const staleMs = 30;
    const heartbeatMs = 10;
    let sawStaleMidFlight = false;
    const longPass = journal.withJournalLock(dir, async () => {
      await new Promise((r) => { setTimeout(r, staleMs * 4); });
    }, { staleMs, heartbeatMs });
    // Sample staleness mid-flight, well past the original staleMs window, while
    // the heartbeat should be keeping the owner timestamp fresh.
    await new Promise((r) => { setTimeout(r, staleMs * 2); });
    if (fs.existsSync(journal.lockPath(dir))) {
      sawStaleMidFlight = lockIsStaleForTest(journal.lockPath(dir), staleMs);
    }
    await longPass;
    expect(sawStaleMidFlight).toBe(false);
    expect(fs.existsSync(journal.lockPath(dir))).toBe(false);
  });
});

/** Mirrors journal.js's internal lockIsStale age check for the owner file, without requiring an internal export. */
function lockIsStaleForTest(lock, staleMs) {
  try {
    const [, tsStr] = fs.readFileSync(path.join(lock, 'owner'), 'utf8').split(':');
    const stampedAt = Number.parseInt(tsStr, 10);
    return Date.now() - stampedAt > staleMs;
  } catch {
    return true;
  }
}
