"use strict";

const { beforeAll, describe, expect, mock, test } = require("bun:test");
const contracts = require("../../memory-contracts");
mock.module("@forge/memory-contracts", () => contracts);

const {
  canonicalize,
  computeContentHash,
} = contracts;

let createMonitorStore;
let MonitorDurabilityError;
let createMonitorDurabilityBridge;

beforeAll(() => {
  ({ MonitorDurabilityError, createMonitorDurabilityBridge } = require("../src/monitor-durability.js"));
  ({ createMonitorStore } = require("../../memory"));
});

const ZERO_HASH = '0'.repeat(64);
const ONE_HASH = '1'.repeat(64);

function envelope(schemaId, objectId, payload, createdAt = '2026-08-10T00:00:00.000Z') {
  const base = {
    schema_id: schemaId,
    schema_version: 1,
    object_id: objectId,
    content_hash: ZERO_HASH,
    created_at: createdAt,
    producer: { product_id: "forge-flow", product_version: "0.1.0", instance_id: "test" },
    capabilities_used: [],
    provenance: { source_kind: "monitor", actor_class: "system", actor_id: "monitor-1" },
    payload,
    extensions: {},
  };
  return Object.freeze({
    ...base,
    content_hash: computeContentHash(base),
  });
}

function monitorEvent(overrides = {}) {
  const sequence = overrides.sequence ?? 0;
  return envelope(
    'forge.memory.monitor-event.v1',
    overrides.objectId ?? `10000000-0000-4000-8000-${String(sequence + 1).padStart(12, "0")}`,
    {
      event_id: overrides.eventId ?? `event-${sequence}`,
      monitor_id: overrides.monitorId ?? 'monitor-1',
      sequence,
      subject_revision: overrides.subjectRevision ?? "head-1",
      type: overrides.eventType ?? "status",
      actionability: overrides.actionability ?? "action_required",
      observed_at: overrides.observedAt ?? `2026-08-10T00:00:0${sequence}.000Z`,
      artifact_digest: overrides.artifactDigest ?? ONE_HASH,
      bounded_payload: overrides.boundedPayload ?? { state: `value-${sequence}` },
    },
  );
}

function deliveryReceipt(event, overrides = {}) {
  return envelope(
    'forge.memory.delivery-receipt.v1',
    overrides.objectId ?? `20000000-0000-4000-8000-${String(event.payload.sequence + 1).padStart(12, "0")}`,
    {
      event_id: event.payload.event_id,
      target: overrides.targetId ?? "target-1",
      transport_tier: "T1",
      attempt: 1,
      delivered_at: overrides.deliveredAt ?? '2026-08-10T00:01:00.000Z',
      acknowledged: true,
      outcome: "acknowledged",
    },
  );
}

function terminalReceipt(events, overrides = {}) {
  const hashes = events.slice(-128).map((event) => event.content_hash);
  return envelope(
    'forge.memory.monitor-receipt.v1',
    overrides.objectId ?? "30000000-0000-4000-8000-000000000001",
    {
      monitor_id: overrides.monitorId ?? 'monitor-1',
      owner_run_id: "run-1",
      terminal_state: overrides.terminalState ?? 'PASS',
      last_sequence: overrides.lastSequence ?? events.at(-1)?.payload.sequence ?? 0,
      evidence_digest:
        overrides.evidenceDigest ?? computeContentHash({ evidence_hashes: hashes }),
      terminal_reason: overrides.terminalReason ?? 'terminal evidence complete',
      cancellation_acknowledged: overrides.cancellationAcknowledged ?? true,
      process_cleanup: overrides.processCleanup ?? { outcome: "complete" },
      lease_cleanup: overrides.leaseCleanup ?? { outcome: "complete" },
    },
  );
}

function createDurableDriver() {
  const state = {
    available: true,
    events: new Map(),
    identity: new Map(),
    deliveryReceipts: new Map(),
    cursors: new Map(),
    terminals: new Map(),
    staleTerminal: false,
    terminalWrites: 0,
    listLimit: undefined,
    log: [],
  };

  function requireAvailable() {
    if (!state.available) throw new Error('monitor provider unavailable');
  }

  return {
    state,
    appendMonitorEvent(event, targets) {
      requireAvailable();
      const monitorKey = `${event.payload.monitor_id}:${event.payload.sequence}`;
      const existingById = state.events.get(event.payload.event_id);
      const existingByPosition = state.identity.get(monitorKey);
      const existing = existingById ?? existingByPosition;
      if (existing) {
        if (
          existing.event.content_hash !== event.content_hash ||
          canonicalize(existing.targets) !== canonicalize(targets)
        ) {
          throw new Error('monitor event identity conflict');
        }
        return { eventId: event.payload.event_id, idempotent: true };
      }

      const record = { event, targets: [...targets] };
      state.events.set(event.payload.event_id, record);
      state.identity.set(monitorKey, record);
      state.log.push(`persist:${event.payload.event_id}`);
      return { eventId: event.payload.event_id, idempotent: false };
    },
    recordMonitorDeliveryReceipt(receipt) {
      requireAvailable();
      const event = state.events.get(receipt.payload.event_id)?.event;
      if (!event) throw new Error('delivery receipt references unknown event');
      const priorReceipt = state.deliveryReceipts.get(receipt.object_id);
      if (priorReceipt) {
        if (priorReceipt.content_hash !== receipt.content_hash) {
          throw new Error('delivery receipt identity conflict');
        }
        return { receiptId: receipt.object_id, idempotent: true };
      }

      const cursorKey = `${event.payload.monitor_id}:${receipt.payload.target}`;
      const cursor = state.cursors.get(cursorKey) ?? -1;
      if (event.payload.sequence < cursor) throw new Error('stale delivery cursor');
      state.deliveryReceipts.set(receipt.object_id, receipt);
      state.cursors.set(cursorKey, Math.max(cursor, event.payload.sequence));
      return { receiptId: receipt.object_id, idempotent: false };
    },
    recordMonitorTerminalReceipt(receipt) {
      requireAvailable();
      if (state.staleTerminal) {
        throw new Error('stale monitor terminal sequence: last_sequence does not match durable events');
      }
      const prior = state.terminals.get(receipt.payload.monitor_id);
      if (prior) {
        if (prior.content_hash !== receipt.content_hash) {
          throw new Error('terminal receipt identity conflict');
        }
        return { monitorId: receipt.payload.monitor_id, idempotent: true };
      }
      state.terminals.set(receipt.payload.monitor_id, receipt);
      state.terminalWrites += 1;
      return { monitorId: receipt.payload.monitor_id, idempotent: false };
    },
    listMonitorEvents(monitorId) {
      requireAvailable();
      const rows = [...state.events.values()]
        .map(({ event }) => event)
        .filter((event) => event.payload.monitor_id === monitorId)
        .sort((left, right) => left.payload.sequence - right.payload.sequence)
        .map((event) => ({
          event_id: event.payload.event_id,
          monitor_id: event.payload.monitor_id,
          sequence: event.payload.sequence,
          content_hash: event.content_hash,
          envelope_json: canonicalize(event),
          artifact_digest: event.payload.artifact_digest,
          created_at: event.created_at,
        }));
      return state.listLimit === undefined ? rows : rows.slice(0, state.listLimit);
    },
  };
}

function bridge(driver, deliver = async () => undefined) {
  return createMonitorDurabilityBridge({
    store: createMonitorStore(driver),
    deliveryTargets: ['target-1'],
    deliver,
  });
}

describe('monitor durability bridge', () => {
  test('persists a validated event before delivery and retries safely after restart', async () => {
    const driver = createDurableDriver();
    const event = monitorEvent();
    const deliver = mock(async (deliveredEvent) => {
      expect(driver.state.events.has(deliveredEvent.payload.event_id)).toBe(true);
      driver.state.log.push(`deliver:${deliveredEvent.payload.event_id}`);
    });

    const first = await bridge(driver, deliver).persistEvent(event);
    const restarted = await bridge(driver, deliver).persistEvent(event);

    expect(first.persistence.idempotent).toBe(false);
    expect(restarted.persistence.idempotent).toBe(true);
    expect(driver.state.log).toEqual(['persist:event-0', 'deliver:event-0', 'deliver:event-0']);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  test('rejects event identity/content conflicts without delivering the conflicting event', async () => {
    const driver = createDurableDriver();
    const deliver = mock(async () => undefined);
    await bridge(driver, deliver).persistEvent(monitorEvent());

    const conflict = monitorEvent({ boundedPayload: { state: 'conflict' } });
    await expect(bridge(driver, deliver).persistEvent(conflict)).rejects.toMatchObject({
      name: 'MonitorDurabilityError',
      code: 'IDENTITY_CONFLICT',
    });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  test('fails closed when the provider is unavailable and never attempts delivery', async () => {
    const driver = createDurableDriver();
    const deliver = mock(async () => undefined);
    driver.state.available = false;

    await expect(bridge(driver, deliver).persistEvent(monitorEvent())).rejects.toMatchObject({
      name: 'MonitorDurabilityError',
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(driver.state.events.size).toBe(0);
  });

  test('rejects hash-consistent structurally invalid events and receipts before provider calls', async () => {
    const driver = createDurableDriver();
    const deliver = mock(async () => undefined);
    const validEvent = monitorEvent();
    const invalidEventPayload = { ...validEvent.payload };
    delete invalidEventPayload.actionability;
    const invalidEvent = envelope(validEvent.schema_id, validEvent.object_id, invalidEventPayload);

    await expect(bridge(driver, deliver).persistEvent(invalidEvent)).rejects.toMatchObject({
      code: 'INPUT_INVALID',
    });
    expect(driver.state.events.size).toBe(0);
    expect(deliver).not.toHaveBeenCalled();

    await bridge(driver).persistEvent(validEvent);
    let listCalls = 0;
    const originalList = driver.listMonitorEvents;
    driver.listMonitorEvents = (...args) => {
      listCalls += 1;
      return originalList.call(driver, ...args);
    };

    const validDelivery = deliveryReceipt(validEvent);
    const invalidDeliveryPayload = { ...validDelivery.payload };
    delete invalidDeliveryPayload.event_id;
    const invalidDelivery = envelope(validDelivery.schema_id, validDelivery.object_id, invalidDeliveryPayload);
    await expect(bridge(driver).acknowledgeDelivery('monitor-1', invalidDelivery)).rejects.toMatchObject({
      code: 'INPUT_INVALID',
    });

    const validTerminal = terminalReceipt([validEvent]);
    const invalidTerminalPayload = { ...validTerminal.payload };
    delete invalidTerminalPayload.owner_run_id;
    const invalidTerminal = envelope(validTerminal.schema_id, validTerminal.object_id, invalidTerminalPayload);
    await expect(bridge(driver).recordTerminalReceipt(invalidTerminal)).rejects.toMatchObject({
      code: 'INPUT_INVALID',
    });

    expect(listCalls).toBe(0);
    expect(driver.state.deliveryReceipts.size).toBe(0);
    expect(driver.state.terminals.size).toBe(0);
  });

  test('rejects monitor IDs that are not bounded before append or list provider calls', async () => {
    const driver = createDurableDriver();
    const longMonitorId = 'm'.repeat(129);
    const deliver = mock(async () => undefined);
    await expect(bridge(driver, deliver).persistEvent(monitorEvent({ monitorId: longMonitorId })))
      .rejects.toMatchObject({ code: 'INPUT_INVALID' });
    expect(driver.state.events.size).toBe(0);
    expect(deliver).not.toHaveBeenCalled();

    const validEvent = monitorEvent();
    await bridge(driver).persistEvent(validEvent);
    let listCalls = 0;
    const originalList = driver.listMonitorEvents;
    driver.listMonitorEvents = (...args) => {
      listCalls += 1;
      return originalList.call(driver, ...args);
    };
    await expect(bridge(driver).acknowledgeDelivery(longMonitorId, deliveryReceipt(validEvent)))
      .rejects.toMatchObject({ code: 'INPUT_INVALID' });
    await expect(bridge(driver).recordTerminalReceipt(terminalReceipt([validEvent], { monitorId: longMonitorId })))
      .rejects.toMatchObject({ code: 'INPUT_INVALID' });
    expect(listCalls).toBe(0);
  });

  test('reports delivery failure without hiding that the event is already durable', async () => {
    const driver = createDurableDriver();
    const deliver = mock(async () => {
      throw new Error("delivery provider lost");
    });

    await expect(bridge(driver, deliver).persistEvent(monitorEvent())).rejects.toMatchObject({
      code: "DELIVERY_FAILED",
      persisted: true,
      eventId: "event-0",
    });
    expect(driver.state.events.has("event-0")).toBe(true);
  });

  test('persists acknowledgements monotonically and rejects a stale cursor after restart', async () => {
    const driver = createDurableDriver();
    const firstEvent = monitorEvent({ sequence: 0 });
    const secondEvent = monitorEvent({ sequence: 1 });
    const firstBridge = bridge(driver);
    await firstBridge.persistEvent(firstEvent);
    await firstBridge.persistEvent(secondEvent);

    const secondAck = deliveryReceipt(secondEvent);
    const secondAckResult = await firstBridge.acknowledgeDelivery('monitor-1', secondAck);
    const replayResult = await bridge(driver).acknowledgeDelivery('monitor-1', secondAck);
    expect(secondAckResult.persistence.idempotent).toBe(false);
    expect(replayResult.persistence.idempotent).toBe(true);
    expect(driver.state.cursors.get('monitor-1:target-1')).toBe(1);

    await expect(
      bridge(driver).acknowledgeDelivery('monitor-1', deliveryReceipt(firstEvent)),
    ).rejects.toMatchObject({ code: 'STALE_CURSOR' });
    expect(driver.state.cursors.get('monitor-1:target-1')).toBe(1);
  });

  test('records one terminal receipt across restarts and rejects a conflicting terminal', async () => {
    const driver = createDurableDriver();
    const events = [monitorEvent({ sequence: 0 }), monitorEvent({ sequence: 1 })];
    const firstBridge = bridge(driver);
    for (const event of events) await firstBridge.persistEvent(event);
    const receipt = terminalReceipt(events);

    const first = await firstBridge.recordTerminalReceipt(receipt);
    const replay = await bridge(driver).recordTerminalReceipt(receipt);
    expect(first.persistence.idempotent).toBe(false);
    expect(replay.persistence.idempotent).toBe(true);
    expect(driver.state.terminals.size).toBe(1);

    const conflict = terminalReceipt(events, { terminalReason: 'conflicting terminal result' });
    await expect(bridge(driver).recordTerminalReceipt(conflict)).rejects.toMatchObject({
      code: 'IDENTITY_CONFLICT',
    });
  });

  test('rejects PASS with incomplete event evidence without consuming the terminal slot', async () => {
    const driver = createDurableDriver();
    const stored = monitorEvent();
    await bridge(driver).persistEvent(stored);
    const receipt = terminalReceipt([stored], { evidenceDigest: ZERO_HASH });

    await expect(bridge(driver).recordTerminalReceipt(receipt)).rejects.toMatchObject({
      code: 'INCOMPLETE_TERMINAL_EVIDENCE',
    });
    expect(driver.state.terminals.size).toBe(0);
    expect(driver.state.terminalWrites).toBe(0);
  });

  test('rejects FAIL with incomplete event evidence without writing a terminal receipt', async () => {
    const driver = createDurableDriver();
    const stored = monitorEvent();
    await bridge(driver).persistEvent(stored);
    const receipt = terminalReceipt([stored], {
      terminalState: 'FAIL',
      evidenceDigest: ZERO_HASH,
    });

    await expect(bridge(driver).recordTerminalReceipt(receipt)).rejects.toMatchObject({
      code: 'INCOMPLETE_TERMINAL_EVIDENCE',
    });
    expect(driver.state.terminals.size).toBe(0);
    expect(driver.state.terminalWrites).toBe(0);
  });

  test('preserves the legitimate empty-history FAIL terminal receipt', async () => {
    const driver = createDurableDriver();
    const receipt = terminalReceipt([], { terminalState: 'FAIL' });

    const result = await bridge(driver).recordTerminalReceipt(receipt);

    expect(result.persistence.idempotent).toBe(false);
    expect(driver.state.terminals.size).toBe(1);
  });

  test('maps stale terminal sequence provider errors to incomplete evidence', async () => {
    const driver = createDurableDriver();
    const event = monitorEvent();
    await bridge(driver).persistEvent(event);
    driver.state.staleTerminal = true;

    await expect(bridge(driver).recordTerminalReceipt(terminalReceipt([event]))).rejects.toMatchObject({
      code: 'INCOMPLETE_TERMINAL_EVIDENCE',
    });
    expect(driver.state.terminals.size).toBe(0);
    expect(driver.state.terminalWrites).toBe(0);
  });

  test('accepts monotonic terminal evidence whose first sequence is one', async () => {
    const driver = createDurableDriver();
    const event = monitorEvent({ sequence: 1 });
    await bridge(driver).persistEvent(event);

    const result = await bridge(driver).recordTerminalReceipt(terminalReceipt([event]));

    expect(result.persistence.idempotent).toBe(false);
    expect(driver.state.terminals.size).toBe(1);
  });

  test('hashes only the bounded runtime evidence tail when history exceeds 128 events', async () => {
    const driver = createDurableDriver();
    const events = Array.from({ length: 129 }, (_, index) => monitorEvent({
      sequence: index + 1,
      observedAt: new Date(Date.UTC(2026, 7, 10, 0, 0, index)).toISOString(),
    }));
    const monitorBridge = bridge(driver);
    for (const event of events) await monitorBridge.persistEvent(event);

    const result = await monitorBridge.recordTerminalReceipt(terminalReceipt(events));

    expect(result.persistence.idempotent).toBe(false);
    expect(driver.state.terminals.size).toBe(1);
  });

  test('rejects a durable history truncated before the terminal sequence', async () => {
    const driver = createDurableDriver();
    const events = Array.from({ length: 129 }, (_, index) => monitorEvent({
      sequence: index + 1,
      observedAt: new Date(Date.UTC(2026, 7, 10, 0, 0, index)).toISOString(),
    }));
    const monitorBridge = bridge(driver);
    for (const event of events) await monitorBridge.persistEvent(event);
    driver.state.listLimit = 128;

    await expect(monitorBridge.recordTerminalReceipt(terminalReceipt(events))).rejects.toMatchObject({
      code: 'INCOMPLETE_TERMINAL_EVIDENCE',
    });
    expect(driver.state.terminals.size).toBe(0);
    expect(driver.state.terminalWrites).toBe(0);
  });

  test('isolates immutable persistence and delivery snapshots from provider retention mutation', async () => {
    const driver = createDurableDriver();
    const originalAppend = driver.appendMonitorEvent;
    let retained;
    driver.appendMonitorEvent = (event, ...args) => {
      retained = event;
      const result = originalAppend.call(driver, event, ...args);
      try {
        event.payload.bounded_payload.state = 'retention-tampered';
      } catch {
        // The bridge owns an immutable provider snapshot.
      }
      return result;
    };
    let delivered;
    const deliver = mock(async (event) => {
      delivered = event;
      try {
        event.payload.bounded_payload.state = 'delivery-tampered';
      } catch {
        // The bridge owns an immutable delivery snapshot.
      }
    });

    await bridge(driver, deliver).persistEvent(monitorEvent());

    expect(retained).not.toBe(delivered);
    expect(retained.payload.bounded_payload).not.toBe(delivered.payload.bounded_payload);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained.payload.bounded_payload)).toBe(true);
    expect(Object.isFrozen(delivered)).toBe(true);
    expect(Object.isFrozen(delivered.payload.bounded_payload)).toBe(true);
    expect(retained.payload.bounded_payload.state).toBe('value-0');
    expect(delivered.payload.bounded_payload.state).toBe('value-0');
  });

  test('rejects hostile accessor input without invoking it or reaching the provider', async () => {
    const driver = createDurableDriver();
    const valid = monitorEvent();
    let getterCalls = 0;
    const hostilePayload = { ...valid.payload };
    Object.defineProperty(hostilePayload, 'bounded_payload', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { secret: true };
      },
    });
    const hostile = { ...valid, payload: hostilePayload };

    await expect(bridge(driver).persistEvent(hostile)).rejects.toBeInstanceOf(
      MonitorDurabilityError,
    );
    expect(getterCalls).toBe(0);
    expect(driver.state.log).toEqual([]);
  });
});
