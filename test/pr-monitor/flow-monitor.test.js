'use strict';

const { describe, expect, test } = require('bun:test');

const { runFlowMonitorPass } = require('../../lib/pr-monitor/flow-monitor');

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
  let terminalReceipt = null;
  return {
    events,
    get terminalReceipt() { return terminalReceipt; },
    async appendEvent(event, targets) {
      const existing = events.find((item) => item.payload.event_id === event.payload.event_id
        || item.payload.sequence === event.payload.sequence);
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
    async readEventTail(_monitorId, { limit }) {
      const selected = events.slice(-limit);
      return {
        events: selected.map(event => ({
          event_id: event.payload.event_id,
          monitor_id: event.payload.monitor_id,
          sequence: event.payload.sequence,
          content_hash: event.content_hash,
          envelope_json: JSON.stringify(event),
        })),
        overflow: events.length > limit,
        truncated_before_sequence: events.length > limit ? selected[0].payload.sequence : null,
      };
    },
    async readDeliveryState(monitorId) {
      return {
        cursors: [...cursors.entries()].map(([target, sequence]) => ({ monitor_id: monitorId, target, sequence })),
        outbox: [],
        terminal_receipt: terminalReceipt && {
          monitor_id: monitorId,
          content_hash: terminalReceipt.content_hash,
          envelope_json: JSON.stringify(terminalReceipt),
        },
        overflow: { cursors: false, outbox: false },
      };
    },
    async recordDeliveryReceipt(receipt) {
      const event = events.find(item => item.payload.event_id === receipt.payload.event_id);
      cursors.set(receipt.payload.target, event.payload.sequence);
      return { idempotent: false };
    },
    async recordTerminalReceipt(receipt) {
      if (terminalReceipt && terminalReceipt.content_hash !== receipt.content_hash) {
        throw new Error('monitor receipt conflict');
      }
      terminalReceipt = structuredClone(receipt);
      return { idempotent: Boolean(terminalReceipt) };
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

  test('rejects truncated durable history instead of treating it as a complete restart checkpoint', async () => {
    const store = durableStore();
    store.readEventTail = async () => ({ events: [], overflow: true, truncated_before_sequence: 1 });

    await expect(runFlowMonitorPass(context(store, async () => snapshot(), async () => {})))
      .rejects.toMatchObject({ code: 'MONITOR_HISTORY_INCOMPLETE' });
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

  test('rejects a content-corrupted terminal receipt instead of replaying authority', async () => {
    const store = durableStore();
    await runFlowMonitorPass(context(store, async () => snapshot({ state: 'MERGED' }), async () => {}));
    store.terminalReceipt.payload.terminal_reason = 'tampered';

    await expect(runFlowMonitorPass(context(store, async () => {
      throw new Error('corrupt terminal replay must not poll the provider');
    }, async () => {}))).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
