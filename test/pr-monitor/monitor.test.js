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

function memoryStore() {
  const events = [];
  const cursors = new Map();
  return {
    async appendEvent(event) {
      const existing = events.find(item => item.payload.event_id === event.payload.event_id);
      if (!existing) events.push(structuredClone(event));
    },
    async getEvent(id) {
      const event = events.find(item => item.payload.event_id === id);
      return event ? { envelope_json: JSON.stringify(event) } : null;
    },
    async readEventTail(monitorId, { limit = 128 } = {}) {
      const matching = events.filter(event => event.payload.monitor_id === monitorId);
      const selected = matching.slice(-limit);
      return {
        events: selected.map(event => ({
          object_id: event.object_id,
          content_hash: event.content_hash,
          envelope_json: JSON.stringify(event),
        })),
        overflow: matching.length > limit,
        truncated_before_sequence: matching.length > limit ? selected[0].payload.sequence : null,
      };
    },
    async readDeliveryState(monitorId) {
      return {
        cursors: [...(cursors.get(monitorId) || new Map())]
          .map(([target, sequence]) => ({ monitor_id: monitorId, target, sequence })),
        outbox: [],
        terminal_receipt: null,
        overflow: { cursors: false, outbox: false },
      };
    },
    async recordDeliveryReceipt(receipt) {
      const event = events.find(item => item.payload.event_id === receipt.payload.event_id);
      const monitorId = event.payload.monitor_id;
      if (!cursors.has(monitorId)) cursors.set(monitorId, new Map());
      cursors.get(monitorId).set(receipt.payload.target, event.payload.sequence);
    },
  };
}

function memoryContext(store, gather) {
  return {
    dir,
    store,
    gather,
    now,
    monitorId: 'pr:acme-forge:1',
    ownerRunId: 'run-1',
    packetId: 'packet-1',
    subjectId: 'acme-forge#1',
  };
}

let root; let dir;
const now = () => '2026-07-13T00:00:00.000Z';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'prmon-m-')); dir = journal.journalDir({ root, repo: 'acme-forge', pr: '1' }); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('runMonitorPass', () => {
	test('test Memory store reports bounded monitor-specific tails', async () => {
		const store = memoryStore();
		for (let sequence = 1; sequence <= 3; sequence += 1) {
			await store.appendEvent({
				object_id: `event-${sequence}`, content_hash: `hash-${sequence}`,
				payload: { monitor_id: 'monitor-a', event_id: `id-${sequence}`, sequence },
			});
		}
		await store.appendEvent({
			object_id: 'other', content_hash: 'other-hash',
			payload: { monitor_id: 'monitor-b', event_id: 'other-id', sequence: 1 },
		});

		const tail = await store.readEventTail('monitor-a', { limit: 2 });
		expect(tail).toMatchObject({ overflow: true, truncated_before_sequence: 2 });
		expect(tail.events.map(row => JSON.parse(row.envelope_json).payload.sequence)).toEqual([2, 3]);
	});

  test('uses durable Memory as authority when a monitor store is supplied', async () => {
    const store = memoryStore();
    const ctx = memoryContext(store, async () => snap());

    const first = await runMonitorPass(ctx);
    fs.rmSync(journal.snapshotPath(dir));
    const restarted = await runMonitorPass(ctx);

    expect(first.authority).toBe('memory');
    expect(restarted.events).toEqual([]);
    expect((await store.readEventTail(ctx.monitorId)).events).toHaveLength(1);
    expect(journal.readAllEvents(dir)).toHaveLength(1);
  });

  test('Memory compatibility delivery continues after an existing journal cursor', async () => {
    journal.appendEvents(dir, [{
      seq: 40, ts: now(), type: T.VERDICT_CHANGED, key: 'legacy',
      repo: 'acme-forge', pr: '1', headSha: 'old', data: {},
    }]);

    await runMonitorPass(memoryContext(memoryStore(), async () => snap()));

    const delivered = journal.readEventsSince(dir, 40);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].seq).toBe(41);
  });

  test('returns the lock-protected compatibility cursor for watch consumers', async () => {
    journal.appendEvents(dir, [{
      seq: 40, ts: now(), type: T.VERDICT_CHANGED, key: 'legacy',
      repo: 'acme-forge', pr: '1', headSha: 'old', data: {},
    }]);

    const result = await runMonitorPass(memoryContext(memoryStore(), async () => snap()));

    expect(result.journalCursor).toBe(40);
    expect(journal.readEventsSince(dir, result.journalCursor)).toHaveLength(1);
  });

  test('Memory compatibility delivery preserves recurring event identities', async () => {
    const store = memoryStore();
    const current = { value: snap({ headSha: 'shaX', checks: [{ name: 'ci', class: 'green' }] }) };
    const ctx = memoryContext(store, async () => current.value);
    await runMonitorPass(ctx);
    current.value = snap({ headSha: 'shaX', checks: [{ name: 'ci', class: 'failed' }] });
    await runMonitorPass(ctx);
    current.value = snap({ headSha: 'shaX', checks: [{ name: 'ci', class: 'green' }] });
    await runMonitorPass(ctx);
    current.value = snap({ headSha: 'shaX', checks: [{ name: 'ci', class: 'failed' }] });
    await runMonitorPass(ctx);

    const checkEvents = journal.readAllEvents(dir)
      .filter(event => event.type === T.CHECK_FAILED || event.type === T.CHECK_RECOVERED)
      .map(event => event.type);
    expect(checkEvents).toEqual([T.CHECK_FAILED, T.CHECK_RECOVERED, T.CHECK_FAILED]);
  });

  test('Memory compatibility redelivery is idempotent after a receipt-write crash', async () => {
    const store = memoryStore();
    const recordReceipt = store.recordDeliveryReceipt;
    store.recordDeliveryReceipt = async () => { throw new Error('receipt crash'); };
    const ctx = memoryContext(store, async () => snap());
    await expect(runMonitorPass(ctx)).rejects.toThrow('Monitor durability provider unavailable');
    expect(journal.readAllEvents(dir)).toHaveLength(1);

    store.recordDeliveryReceipt = recordReceipt;
    await runMonitorPass(ctx);
    expect(journal.readAllEvents(dir)).toHaveLength(1);
  });

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

  test('fail → green → fail on the same sha re-emits: 3 check events, not 2', async () => {
    // The dedup guard must be scoped to the snapshot cursor, NOT the whole
    // journal history. A check that breaks, recovers, then breaks again keeps the
    // same (type,key) identity (name+sha), so a history-wide guard would swallow
    // the SECOND failure forever — a silent gap for a check that re-breaks.
    const ci = (cls) => snap({ headSha: 'shaX', checks: [{ name: 'ci', class: cls }] });
    await runMonitorPass({ dir, gather: async () => ci('green'), now });   // baseline
    await runMonitorPass({ dir, gather: async () => ci('failed'), now });  // fail #1
    await runMonitorPass({ dir, gather: async () => ci('green'), now });   // recover
    await runMonitorPass({ dir, gather: async () => ci('failed'), now });  // fail #2 (re-emit)

    const checkEvents = journal.readAllEvents(dir)
      .filter((e) => e.type === T.CHECK_FAILED || e.type === T.CHECK_RECOVERED)
      .map((e) => e.type);
    expect(checkEvents).toEqual([T.CHECK_FAILED, T.CHECK_RECOVERED, T.CHECK_FAILED]);
    expect(checkEvents.filter((t) => t === T.CHECK_FAILED)).toHaveLength(2);
  });

  test('concurrent passes do not duplicate events or reuse a sequence number', async () => {
    // Two watchers/events callers racing on the same PR. The cross-process lock
    // must serialize them: the second pass sees the first's snapshot and emits
    // nothing, so exactly one check.failed lands with a unique seq.
    await runMonitorPass({ dir, gather: async () => snap({ checks: [{ name: 'ci', class: 'green' }] }), now });
    const failGather = async () => {
      await new Promise((r) => { setTimeout(r, 5); }); // widen the race window
      return snap({ checks: [{ name: 'ci', class: 'failed' }] });
    };
    await Promise.all([
      runMonitorPass({ dir, gather: failGather, now }),
      runMonitorPass({ dir, gather: failGather, now }),
    ]);
    const all = journal.readAllEvents(dir);
    const failed = all.filter((e) => e.type === T.CHECK_FAILED);
    expect(failed).toHaveLength(1);
    const seqs = all.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);           // unique
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);  // monotonic in journal order
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

  test('caps returned deltas and reports overflow instead of returning whole history', async () => {
    const records = Array.from({ length: 140 }, (_, index) => ({
      seq: index + 1,
      ts: '2026-07-13T00:00:00.000Z',
      type: T.VERDICT_CHANGED,
      key: `state:${index}`,
      repo: 'acme-forge',
      pr: '1',
      data: {},
    }));
    journal.appendEvents(dir, records);
    const res = await pollEvents({
      dir,
      gather: async () => { throw new Error('must not run'); },
      since: 0,
      watcherRunning: () => true,
    });

    expect(res.overflow).toBe(true);
    expect(res.events).toHaveLength(128);
    expect(res.events[0].seq).toBe(13);
  });

  test('propagates durable continuation separately from journal overflow', async () => {
    const store = memoryStore();
    const checks = Array.from({ length: 130 }, (_, index) => ({ name: `check-${index}`, class: 'green' }));
    let current = snap({ checks });
    const ctx = memoryContext(store, async () => current);
    await runMonitorPass(ctx);
    current = snap({ checks: checks.map(check => ({ ...check, class: 'failed' })) });

    const res = await pollEvents({ ...ctx, since: 0, watcherRunning: () => false });

    expect(res.continuationPending).toBe(true);
    expect(res.receiptIds).toHaveLength(128);
    expect(res.receiptIds.length).toBeLessThanOrEqual(128);
  });
});
