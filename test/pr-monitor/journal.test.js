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
    expect(journal.readSnapshot(dir)).toBe(null);
  });

  test('watcherRunning is false for a stale/own pid, so poll can fall back inline', () => {
    journal.writePid(dir, process.pid);
    expect(journal.watcherRunning(dir)).toBe(false); // our own pid is not a foreign watcher
    journal.removePid(dir);
    expect(journal.readPid(dir)).toBe(null);
  });
});
