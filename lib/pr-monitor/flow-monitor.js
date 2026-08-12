'use strict';

const crypto = require('node:crypto');

const { computeContentHash } = require('../../packages/memory-contracts');
const {
  createMonitorDurabilityBridge,
  createMonitorState,
  reduceMonitor,
} = require('../../packages/flow');
const { diffSnapshots } = require('./differ');
const { finalizeRecords } = require('./monitor');

const MAX_HISTORY = 128;
const DELIVERY_TARGET = 'legacy-journal';

class FlowMonitorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FlowMonitorError';
    this.code = code;
  }
}

function defaultNow() { return new Date().toISOString(); }

function uuidFrom(seed) {
  const hex = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function envelope(schemaId, objectId, createdAt, producerId, payload) {
  const value = {
    schema_id: schemaId,
    schema_version: 1,
    object_id: objectId,
    created_at: createdAt,
    producer: { product_id: 'forge', product_version: '0.1.0', instance_id: producerId },
    capabilities_used: [],
    provenance: { source_kind: 'monitor', actor_class: 'system', actor_id: producerId },
    payload,
    extensions: {},
  };
  value.content_hash = computeContentHash(value);
  return value;
}

function parseEventRow(row, monitorId) {
  let event;
  try {
    event = typeof row?.envelope_json === 'string' ? JSON.parse(row.envelope_json) : row;
  } catch {
    throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor history is malformed');
  }
  if (event?.schema_id !== 'forge.memory.monitor-event.v1'
    || event.payload?.monitor_id !== monitorId
    || !Number.isSafeInteger(event.payload?.sequence)) {
    throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor history is incomplete');
  }
  return event;
}

function persistenceRow(event) {
  return {
    event_id: event.payload.event_id,
    monitor_id: event.payload.monitor_id,
    sequence: event.payload.sequence,
    content_hash: event.content_hash,
    envelope_json: JSON.stringify(event),
  };
}

function bridgeStore(store) {
  return {
    appendEvent: (...args) => store.appendEvent(...args),
    recordDeliveryReceipt: (...args) => store.recordDeliveryReceipt(...args),
    recordTerminalReceipt: (...args) => {
      if (typeof store.recordTerminalReceipt !== 'function') {
        throw new FlowMonitorError('PROVIDER_UNAVAILABLE', 'Terminal receipt store is unavailable');
      }
      return store.recordTerminalReceipt(...args);
    },
    async getEvent(eventId, config) {
      const row = await store.getEvent(eventId, config);
      if (!row) return row;
      const event = typeof row.envelope_json === 'string' ? JSON.parse(row.envelope_json) : row;
      return row.monitor_id ? row : persistenceRow(event);
    },
    readEventTail: (...args) => store.readEventTail(...args),
    readDeliveryState: (...args) => store.readDeliveryState(...args),
  };
}

function monitorSpec(ctx, subjectRevision) {
  return {
    monitorId: ctx.monitorId,
    ownerRunId: ctx.ownerRunId,
    packetId: ctx.packetId,
    subject: { id: ctx.subjectId, revision: subjectRevision },
    sourceAdapters: ['github-pr'],
    deliveryTargets: [DELIVERY_TARGET],
    lifetime: 'subject',
    deadline: '9999-12-31T23:59:59.999Z',
    maxPending: MAX_HISTORY,
    maxRetries: 3,
    retryBaseMs: 1000,
    maxHistory: MAX_HISTORY,
    securityPolicy: { maxPayloadBytes: 16_384 },
    reducer: (_previous, observation) => observation.snapshot,
    terminalPredicate: () => false,
  };
}

function monitorEvent(ctx, record, snapshot, subjectRevision) {
  const seed = `${ctx.monitorId}:${record.seq}:${record.type}:${record.key}`;
  return envelope(
    'forge.memory.monitor-event.v1',
    uuidFrom(`event-object:${seed}`),
    record.ts,
    ctx.monitorId,
    {
      monitor_id: ctx.monitorId,
      event_id: crypto.createHash('sha256').update(seed).digest('hex'),
      sequence: record.seq,
      subject_revision: subjectRevision,
      type: record.type,
      actionability: 'action_required',
      observed_at: record.ts,
      bounded_payload: { record, snapshot },
    },
  );
}

function deliveryReceipt(ctx, event, deliveredAt) {
  return envelope(
    'forge.memory.delivery-receipt.v1',
    uuidFrom(`delivery:${event.payload.event_id}:${DELIVERY_TARGET}`),
    deliveredAt,
    ctx.monitorId,
    {
      event_id: event.payload.event_id,
      target: DELIVERY_TARGET,
      transport_tier: 'T1',
      attempt: 1,
      delivered_at: deliveredAt,
      acknowledged: true,
      outcome: 'acknowledged',
    },
  );
}

async function readAuthority(ctx) {
  let tail;
  try {
    tail = await ctx.store.readEventTail(ctx.monitorId, { limit: MAX_HISTORY });
  } catch (error) {
    throw new FlowMonitorError('PROVIDER_UNAVAILABLE', 'Durable monitor history is unavailable', { cause: error });
  }
  if (!tail || tail.overflow || !Array.isArray(tail.events) || tail.events.length > MAX_HISTORY) {
    throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor history exceeds its restart bound');
  }
  const events = tail.events.map(row => parseEventRow(row, ctx.monitorId));
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].payload.sequence !== index + 1) {
      throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor history is not contiguous');
    }
  }
  return events;
}

async function runFlowMonitorPass(ctx) {
  const now = ctx.now || defaultNow;
  const durableEvents = await readAuthority(ctx);
  const subjectRevision = ctx.subjectRevision || ctx.subjectId;
  const spec = monitorSpec(ctx, subjectRevision);
  let state = createMonitorState(spec);
  for (const event of durableEvents) {
    state = reduceMonitor(spec, state, { kind: 'observation', event }).state;
  }

  let deliveryState;
  try {
    deliveryState = await ctx.store.readDeliveryState(ctx.monitorId, { limit: MAX_HISTORY });
  } catch {
    throw new FlowMonitorError('PROVIDER_UNAVAILABLE', 'Durable delivery state is unavailable');
  }
  if (!deliveryState || deliveryState.overflow?.cursors || !Array.isArray(deliveryState.cursors)) {
    throw new FlowMonitorError('PROVIDER_UNAVAILABLE', 'Durable delivery state is incomplete');
  }

  const bridge = createMonitorDurabilityBridge({
    store: bridgeStore(ctx.store),
    deliveryTargets: [DELIVERY_TARGET],
    deliver: async (event) => ctx.deliverLegacy(event.payload.bounded_payload.record),
  });
  const cursor = deliveryState.cursors.find(item => item.target === DELIVERY_TARGET)?.sequence ?? 0;
  if (cursor > 0 && durableEvents.some(event => event.payload.sequence === cursor)) {
    state = reduceMonitor(spec, state, { kind: 'acknowledge', sequence: cursor }).state;
  }
  for (const event of durableEvents.filter(item => item.payload.sequence > cursor)) {
    await ctx.deliverLegacy(event.payload.bounded_payload.record);
    const receipt = deliveryReceipt(ctx, event, now());
    await bridge.acknowledgeDelivery(ctx.monitorId, receipt);
    state = reduceMonitor(spec, state, { kind: 'acknowledge', sequence: event.payload.sequence }).state;
  }

  const next = await ctx.gather();
  const previous = durableEvents.at(-1)?.payload.bounded_payload.snapshot ?? null;
  const candidates = diffSnapshots(previous, next);
  if (candidates.length === 0) {
    return { events: [], changed: false, authority: 'memory' };
  }
  const timestamp = now();
  const records = finalizeRecords(candidates, {
    baseSeq: durableEvents.length,
    ts: timestamp,
    snapshot: next,
  });
  if (typeof ctx.enrich === 'function') await ctx.enrich(records);
  for (const record of records) {
    const event = monitorEvent(ctx, record, next, subjectRevision);
    const transition = reduceMonitor(spec, state, { kind: 'observation', event });
    await bridge.persistEvent(event);
    const receipt = deliveryReceipt(ctx, event, timestamp);
    await bridge.acknowledgeDelivery(ctx.monitorId, receipt);
    state = reduceMonitor(spec, transition.state, { kind: 'acknowledge', sequence: record.seq }).state;
  }
  return { events: records, changed: true, authority: 'memory' };
}

module.exports = { FlowMonitorError, runFlowMonitorPass };
