'use strict';

const { describe, expect, test } = require('bun:test');

const { runFlowMonitorPass } = require('../../lib/pr-monitor/flow-monitor');
const { computeContentHash } = require('../../packages/memory-contracts');

function snapshot(overrides = {}) {
  return {
    repo: 'owner/forge',
    pr: '42',
    headSha: 'a'.repeat(40),
    state: 'OPEN',
    checks: [],
    threads: [],
    reviews: [],
    comments: [],
    verdict: { state: 'BLOCKED-CHECKS', reason: 'pending' },
    ...overrides,
  };
}

function durableStore() {
  const events = [];
  const cursors = new Map();
  const terminalReceipts = new Map();
  let outboxOverflow = false;
  return {
    events,
    setCursor(target, sequence, monitorId = 'pr:owner/forge:42') {
      if (!cursors.has(monitorId)) cursors.set(monitorId, new Map());
      cursors.get(monitorId).set(target, sequence);
    },
    setOutboxOverflow(value) { outboxOverflow = value; },
    get terminalReceipt() { return terminalReceipts.values().next().value || null; },
    async appendEvent(event, targets) {
      const existing = events.find((item) => item.payload.monitor_id === event.payload.monitor_id
        && (item.payload.event_id === event.payload.event_id
          || item.payload.sequence === event.payload.sequence));
      if (existing) {
        if (existing.content_hash !== event.content_hash) {
          const error = new Error('identity conflict');
          error.code = 'MONITOR_EVENT_CONFLICT';
          throw error;
        }
        return { idempotent: true };
      }
      events.push(structuredClone(event));
      return { idempotent: false, targets };
    },
    async getEvent(eventId) {
      const event = events.find(item => item.payload.event_id === eventId);
      return event ? { envelope_json: JSON.stringify(event) } : null;
    },
    async readEventTail(monitorId, { limit }) {
      const matching = events.filter(event => event.payload.monitor_id === monitorId);
      const selected = matching.slice(-limit);
      return {
        events: selected.map(event => ({
          event_id: event.payload.event_id,
          monitor_id: event.payload.monitor_id,
          sequence: event.payload.sequence,
          content_hash: event.content_hash,
          envelope_json: JSON.stringify(event),
        })),
        overflow: matching.length > limit,
        truncated_before_sequence: matching.length > limit ? selected[0].payload.sequence : null,
      };
    },
    async readDeliveryState(monitorId) {
      return {
        cursors: [...(cursors.get(monitorId) || new Map()).entries()]
          .map(([target, sequence]) => ({ monitor_id: monitorId, target, sequence })),
        outbox: [],
        terminal_receipt: terminalReceipts.get(monitorId) ? {
          monitor_id: monitorId,
          content_hash: terminalReceipts.get(monitorId).content_hash,
          envelope_json: JSON.stringify(terminalReceipts.get(monitorId)),
        } : null,
        overflow: { cursors: false, outbox: outboxOverflow },
      };
    },
    async recordDeliveryReceipt(receipt) {
      const event = events.find(item => item.payload.event_id === receipt.payload.event_id);
      if (!cursors.has(event.payload.monitor_id)) cursors.set(event.payload.monitor_id, new Map());
      cursors.get(event.payload.monitor_id).set(receipt.payload.target, event.payload.sequence);
      return { idempotent: false };
    },
    async recordTerminalReceipt(receipt) {
      const prior = terminalReceipts.get(receipt.payload.monitor_id);
      if (prior && prior.content_hash !== receipt.content_hash) {
        throw new Error('monitor receipt conflict');
      }
      terminalReceipts.set(receipt.payload.monitor_id, structuredClone(receipt));
      return { idempotent: Boolean(prior) };
    },
  };
}

function context(store, gather, deliverLegacy) {
  return {
    monitorId: 'pr:owner/forge:42',
    ownerRunId: 'run-42',
    packetId: 'packet-42',
    subjectId: 'owner/forge#42',
    store,
    gather,
    deliverLegacy,
    now: () => '2026-08-12T12:00:00.000Z',
  };
}

async function seedHistory(store, count) {
  await runFlowMonitorPass(context(store, async () => snapshot(), async () => {}));
  const template = store.events[0];
  for (let sequence = 2; sequence <= count; sequence += 1) {
    const event = structuredClone(template);
    event.object_id = `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
    event.payload.event_id = sequence.toString(16).padStart(64, '0');
    event.payload.sequence = sequence;
    event.payload.bounded_payload.record.seq = sequence;
    event.payload.bounded_payload.snapshot.headSha = sequence.toString(16).padStart(40, '0');
    event.content_hash = computeContentHash(event);
    store.events.push(event);
  }
  store.setCursor('legacy-journal', count);
}

describe('Flow-backed PR monitor authority', () => {
  test('persists through public Memory before legacy journal delivery and ignores legacy snapshot authority', async () => {
    const store = durableStore();
    const order = [];
    const next = snapshot();
    const result = await runFlowMonitorPass(context(
      store,
      async () => next,
      async record => {
        expect(store.events.some(event => event.payload.sequence === record.seq)).toBe(true);
        order.push(`legacy:${record.seq}`);
      },
    ));

    expect(result.events).toHaveLength(1);
    expect(store.events).toHaveLength(1);
    expect(order).toEqual(['legacy:1']);
    expect(result.authority).toBe('memory');
  });

  test('reconstructs the prior snapshot from durable events after restart and emits no duplicate', async () => {
    const store = durableStore();
    const next = snapshot();
    const delivered = [];
    await runFlowMonitorPass(context(store, async () => next, async record => delivered.push(record)));

    const restarted = await runFlowMonitorPass(context(
      store,
      async () => structuredClone(next),
      async record => delivered.push(record),
    ));

    expect(restarted.events).toEqual([]);
    expect(store.events).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  test('fails closed without writing legacy compatibility state when Memory is unavailable', async () => {
    const store = durableStore();
    store.appendEvent = async () => {
      const error = new Error('provider unavailable');
      error.code = 'MONITOR_UNAVAILABLE';
      throw error;
    };
    let deliveries = 0;

    await expect(runFlowMonitorPass(context(store, async () => snapshot(), async () => { deliveries += 1; })))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(deliveries).toBe(0);
  });

  test('bounds high-cardinality snapshots before Flow validation and durable persistence', async () => {
    const store = durableStore();
    const large = snapshot({
      checks: Array.from({ length: 100 }, (_, index) => ({ name: `check-${index}-${'x'.repeat(256)}`, class: 'green' })),
      threads: Array.from({ length: 100 }, (_, index) => ({
        threadId: `thread-${index}-${'x'.repeat(256)}`, isResolved: false, isOutdated: false,
        commentCount: 1, actionable: true, path: `path-${index}-${'x'.repeat(256)}`,
      })),
      reviews: Array.from({ length: 100 }, (_, index) => ({ author: `reviewer-${index}-${'x'.repeat(256)}`, state: 'APPROVED' })),
      comments: Array.from({ length: 100 }, (_, index) => ({ id: `comment-${index}-${'x'.repeat(256)}`, author: 'author' })),
    });

    const result = await runFlowMonitorPass(context(store, async () => large, async () => {}));

    expect(result.changed).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(store.events.at(-1).payload.bounded_payload))).toBeLessThanOrEqual(16_384);
  });

  test('retains transition identity beyond the first three snapshot entries', async () => {
    const store = durableStore();
    let next = snapshot({
      checks: Array.from({ length: 4 }, (_, index) => ({ name: `check-${index}`, class: 'green' })),
    });
    const delivered = [];
    const ctx = context(store, async () => next, async record => delivered.push(record));
    await runFlowMonitorPass(ctx);
    next = snapshot({
      checks: Array.from({ length: 4 }, (_, index) => ({
        name: `check-${index}`,
        class: index === 3 ? 'failed' : 'green',
      })),
    });

    await runFlowMonitorPass(ctx);

    expect(delivered.some(record => record.type === 'check.failed')).toBe(true);
  });

  test('rejects truncated durable history instead of treating it as a complete restart checkpoint', async () => {
    const store = durableStore();
    store.readEventTail = async () => ({ events: [], overflow: true, truncated_before_sequence: 1 });

    await expect(runFlowMonitorPass(context(store, async () => snapshot(), async () => {})))
      .rejects.toMatchObject({ code: 'MONITOR_HISTORY_INCOMPLETE' });
  });

  test('uses a contiguous bounded tail as a restart checkpoint after history exceeds the limit', async () => {
    const store = durableStore();
    await seedHistory(store, 129);
    let next = snapshot({ headSha: 'f'.repeat(40) });
    const ctx = context(store, async () => next, async () => {});

    const before = store.events.at(-1).payload.sequence;
    const resumed = await runFlowMonitorPass(ctx);

    expect(store.events.length).toBeGreaterThan(128);
    expect(resumed.changed).toBe(true);
    expect(resumed.events[0].seq).toBe(before + 1);
  });

  test('rejects a truncated restart checkpoint when delivery predates its first retained event', async () => {
    const store = durableStore();
    await seedHistory(store, 129);
    const ctx = context(store, async () => snapshot(), async () => {});
    store.setCursor('legacy-journal', 0);

    await expect(runFlowMonitorPass(ctx))
      .rejects.toMatchObject({ code: 'MONITOR_HISTORY_INCOMPLETE' });
  });

  test('rejects a bounded replay when the durable delivery outbox was truncated', async () => {
    const store = durableStore();
    await seedHistory(store, 129);
    store.setOutboxOverflow(true);

    await expect(runFlowMonitorPass(context(store, async () => snapshot(), async () => {})))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  test('rejects content-corrupted durable history before provider observation', async () => {
    const store = durableStore();
    await runFlowMonitorPass(context(store, async () => snapshot(), async () => {}));
    store.events[0].payload.bounded_payload.snapshot.headSha = 'b'.repeat(40);

    await expect(runFlowMonitorPass(context(store, async () => {
      throw new Error('corrupt replay must not poll the provider');
    }, async () => {}))).rejects.toMatchObject({ code: 'MONITOR_HISTORY_INCOMPLETE' });
  });

  test('records one terminal receipt after merged evidence and replays its id', async () => {
    const store = durableStore();
    const merged = snapshot({ state: 'MERGED' });
    const first = await runFlowMonitorPass(context(store, async () => merged, async () => {}));
    const replay = await runFlowMonitorPass(context(store, async () => {
      throw new Error('terminal replay must not poll the provider');
    }, async () => {}));

    expect(first.terminalReceiptId).toBeString();
    expect(first.receiptIds).toContain(first.terminalReceiptId);
    expect(store.terminalReceipt.payload).toMatchObject({
      terminal_state: 'PASS',
      cancellation_acknowledged: false,
      lease_cleanup: { continuing_authority: false },
    });
    expect(replay.terminalReceiptId).toBe(first.terminalReceiptId);
  });

  test('starts a new lifecycle when a terminal closed PR is reopened', async () => {
    const store = durableStore();
    let next = snapshot({ state: 'CLOSED' });
    const ctx = context(store, async () => next, async () => {});
    const closed = await runFlowMonitorPass(ctx);
    next = snapshot({ state: 'OPEN' });

    const reopened = await runFlowMonitorPass(ctx);

    expect(closed.terminalReceiptId).toBeString();
    expect(reopened.terminalReceiptId).toBeUndefined();
    expect(reopened.changed).toBe(true);
    expect(store.events.some(event => event.payload.monitor_id.includes(':after:'))).toBe(true);
  });

  test('rejects a content-corrupted terminal receipt instead of replaying authority', async () => {
    const store = durableStore();
    await runFlowMonitorPass(context(store, async () => snapshot({ state: 'MERGED' }), async () => {}));
    store.terminalReceipt.payload.terminal_reason = 'tampered';

    await expect(runFlowMonitorPass(context(store, async () => {
      throw new Error('corrupt terminal replay must not poll the provider');
    }, async () => {}))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
