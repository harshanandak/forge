'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const journal = require('../../lib/pr-monitor/journal');
const { runMonitorPass, pollEvents } = require('../../lib/pr-monitor/monitor');
const { EVENT_TYPES: T } = require('../../lib/pr-monitor/events');

function snap(over = {}) {
  return {
    repo: 'acme-forge', pr: '1', headSha: 'sha1', prState: 'OPEN', draft: false,
    verdict: { state: 'CLEAN-MERGEABLE', reason: null },
    checks: [], threads: [], reviews: [], comments: [], behind: 0, conflicts: false, degraded: [],
    ...over,
  };
}

let root; let dir;
const now = () => '2026-07-13T00:00:00.000Z';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'prmon-m-')); dir = journal.journalDir({ root, repo: 'acme-forge', pr: '1' }); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('runMonitorPass', () => {
  test('first pass appends the baseline event and persists the snapshot', async () => {
    const res = await runMonitorPass({ dir, gather: async () => snap(), now });
    expect(res.events.map((e) => e.type)).toEqual([T.VERDICT_CHANGED]);
    expect(res.events[0].seq).toBe(1);
    expect(journal.readSnapshot(dir).snapshot.headSha).toBe('sha1');
  });

  test('a no-change second pass emits nothing (dedup + fingerprint backpressure)', async () => {
    await runMonitorPass({ dir, gather: async () => snap(), now });
    const res = await runMonitorPass({ dir, gather: async () => snap(), now });
    expect(res.events).toEqual([]);
    expect(res.changed).toBe(false);
    expect(journal.lastSeq(dir)).toBe(1);
  });

  test('a real transition appends a new event with the next seq', async () => {
    await runMonitorPass({ dir, gather: async () => snap({ checks: [{ name: 'ci', class: 'green' }] }), now });
    const res = await runMonitorPass({ dir, gather: async () => snap({ checks: [{ name: 'ci', class: 'failed' }] }), now });
    expect(res.events.map((e) => e.type)).toContain(T.CHECK_FAILED);
    expect(res.events[0].seq).toBe(2);
  });

  test('NO DUPLICATES across a crash: snapshot lost after append → re-run emits 0', async () => {
    await runMonitorPass({ dir, gather: async () => snap(), now });
    expect(journal.lastSeq(dir)).toBe(1);
    // Crash BETWEEN append and snapshot-persist: drop the snapshot, keep the
    // journal. The next pass re-diffs from null, recomputes the SAME (type,key),
    // and the journal dedup guard drops it — no duplicate is ever written.
    fs.rmSync(journal.snapshotPath(dir));
    const res = await runMonitorPass({ dir, gather: async () => snap(), now });
    expect(res.events).toEqual([]);
    expect(journal.readAllEvents(dir)).toHaveLength(1);
  });

  test('an enrich hook can decorate records before they are appended', async () => {
    // Establish the baseline first, then transition a check to failed so the
    // pass actually produces a check.failed record for the enricher to touch.
    await runMonitorPass({ dir, gather: async () => snap({ checks: [{ name: 'ci', class: 'green' }] }), now });
    const res = await runMonitorPass({
      dir,
      gather: async () => snap({ checks: [{ name: 'ci', class: 'failed' }] }),
      now,
      enrich: (records) => { for (const r of records) if (r.type === T.CHECK_FAILED) r.data.excerpt = 'boom'; },
    });
    const failed = journal.readAllEvents(dir).find((e) => e.type === T.CHECK_FAILED);
    expect(failed.data.excerpt).toBe('boom');
    expect(res.changed).toBe(true);
  });
});

describe('pollEvents (events --since)', () => {
  test('returns only events with seq > since and does not re-run under a watcher', async () => {
    await runMonitorPass({ dir, gather: async () => snap({ checks: [{ name: 'ci', class: 'green' }] }), now });
    await runMonitorPass({ dir, gather: async () => snap({ checks: [{ name: 'ci', class: 'failed' }] }), now });
    const res = await pollEvents({ dir, gather: async () => { throw new Error('must not run'); }, since: 1, watcherRunning: () => true });
    expect(res.events.every((e) => e.seq > 1)).toBe(true);
    expect(res.ranPass).toBe(false);
  });

  test('runs an inline pass when no watcher owns the PR', async () => {
    const res = await pollEvents({ dir, gather: async () => snap(), since: 0, now, watcherRunning: () => false });
    expect(res.ranPass).toBe(true);
    expect(res.events.map((e) => e.type)).toEqual([T.VERDICT_CHANGED]);
  });
});
