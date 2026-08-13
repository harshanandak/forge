'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { computeContentHash, validateContractStructure } = require('../../packages/memory-contracts');
const {
  createMonitorDurabilityBridge,
  createMonitorReceipt,
  createMonitorState,
  reduceMonitor,
} = require('../../packages/flow');
const { diffSnapshots } = require('./differ');
const { EVENT_TYPES: T, makeEvent } = require('./events');
const { finalizeRecords } = require('./monitor');

const MAX_HISTORY = 128;
const DELIVERY_TARGET = 'legacy-journal';
const SNAPSHOT_TEXT_LIMIT = 64;
const SNAPSHOT_OBJECT_KEY_LIMIT = 24;
const JOB_URL_LIMIT = 2048;
const MAX_REOPEN_DEPTH = 8;
const SNAPSHOT_FORMAT = 'digest-v1';
const SNAPSHOT_EVIDENCE_KEYS = new Set(['checks', 'threads', 'reviews', 'comments', 'degraded']);
const UNSAFE_PROVIDER_DIAGNOSTIC = /(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk_(?:live|test)_[a-z0-9]{16,}|sk-[a-z0-9]{16,}|AKIA[0-9A-Z]{16}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}|(?:^|[\\/])(?:users|home|root)[\\/]\S+)/i;

class FlowMonitorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'FlowMonitorError';
    this.code = code;
  }
}

function defaultNow() { return new Date().toISOString(); }

function boundSnapshotScalar(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, SNAPSHOT_TEXT_LIMIT);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return null;
  if (Array.isArray(value)) {
    return value.slice(0, SNAPSHOT_OBJECT_KEY_LIMIT)
      .map(item => boundSnapshotScalar(item, depth + 1));
  }
  return Object.fromEntries(Object.entries(value)
    .slice(0, SNAPSHOT_OBJECT_KEY_LIMIT)
    .map(([key, item]) => [key, boundSnapshotScalar(item, depth + 1)]));
}

function identityToken(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('base64url').slice(0, 12);
}

function boundIdentity(value) {
  if (typeof value !== 'string' || value.length <= SNAPSHOT_TEXT_LIMIT) return value;
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function validBoundedJobUrl(value) {
  if (typeof value !== 'string' || value.length > JOB_URL_LIMIT || UNSAFE_PROVIDER_DIAGNOSTIC.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

function boundMonitorRecord(record) {
  const safeRecord = typeof record.data?.error === 'string' && UNSAFE_PROVIDER_DIAGNOSTIC.test(record.data.error)
    ? { ...record, data: { ...record.data, error: '[provider diagnostic redacted]' } }
    : record;
  const bounded = boundSnapshotScalar(safeRecord);
  bounded.key = boundIdentity(record.key);
  for (const field of ['name', 'threadId', 'author', 'commitOid', 'surface']) {
    if (typeof record.data?.[field] === 'string') bounded.data[field] = boundIdentity(record.data[field]);
  }
  const jobUrl = validBoundedJobUrl(record.data?.jobUrl);
  if (jobUrl) bounded.data.jobUrl = jobUrl;
  else if (bounded.data) delete bounded.data.jobUrl;
  return bounded;
}

function reopenedMonitorId(monitorId, terminalReceiptId) {
  const lifecycleSeed = `${monitorId}:${terminalReceiptId}`;
  const lifecycleHash = crypto.createHash('sha256').update(lifecycleSeed).digest('hex');
  return `pr-reopen:${lifecycleHash}`;
}

function compactSnapshot(value) {
  if (value?._snapshotFormat === SNAPSHOT_FORMAT) return value;
  const source = value && typeof value === 'object' ? value : {};
  const scalarSource = Object.fromEntries(Object.entries(source)
    .filter(([key]) => !SNAPSHOT_EVIDENCE_KEYS.has(key)));
  const compact = boundSnapshotScalar(scalarSource);
  const evidence = {
    checks: (Array.isArray(source.checks) ? source.checks : [])
      .map(item => [identityToken(item?.name), boundSnapshotScalar(item?.class)]),
    threads: (Array.isArray(source.threads) ? source.threads : [])
      .map(item => [identityToken(item?.threadId), Boolean(item?.isResolved), item?.commentCount || 0, Boolean(item?.actionable)]),
    reviews: (Array.isArray(source.reviews) ? source.reviews : [])
      .map(item => [identityToken(item?.author), identityToken(item?.submittedAt), identityToken(item?.commitOid)]),
    comments: (Array.isArray(source.comments) ? source.comments : [])
      .map(item => [identityToken(item?.id)]),
    degraded: (Array.isArray(source.degraded) ? source.degraded : [])
      .map(item => [identityToken(item?.surface)]),
  };
  const evidenceJson = JSON.stringify(evidence);
  const durableScalar = {
    ...compact,
    ...(typeof source.repo === 'string' ? { repo: source.repo } : {}),
    _snapshotFormat: SNAPSHOT_FORMAT,
  };
  return {
    ...durableScalar,
    _snapshotIdentity: crypto.createHash('sha256')
      .update(JSON.stringify({ snapshot: durableScalar, evidence }))
      .digest('hex'),
    _snapshotEvidence: zlib.gzipSync(evidenceJson, { level: 9 }).toString('base64url'),
  };
}

function snapshotIdentity(snapshot) {
  return typeof snapshot?._snapshotIdentity === 'string'
    ? snapshot._snapshotIdentity
    : computeContentHash(snapshot);
}

function comparableSnapshot(compact, source = null) {
  if (compact?._snapshotFormat !== SNAPSHOT_FORMAT) return compact;
  let evidence;
  try {
    evidence = JSON.parse(zlib.gunzipSync(Buffer.from(compact._snapshotEvidence, 'base64url')));
  } catch {
    throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor snapshot evidence is malformed');
  }
  const tupleLengths = { checks: 2, threads: 4, reviews: 3, comments: 1, degraded: 1 };
  const valid = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    && Object.entries(tupleLengths).every(([key, length]) => Array.isArray(evidence[key])
      && evidence[key].every(item => Array.isArray(item) && item.length === length));
  if (!valid) {
    throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor snapshot evidence is incomplete');
  }
  return {
    ...compact,
    checks: evidence.checks.map((item, index) => ({
      name: item[0], class: item[1], displayName: source?.checks?.[index]?.name,
    })),
    threads: evidence.threads.map((item, index) => ({
      threadId: item[0], isResolved: item[1], commentCount: item[2], actionable: item[3],
      path: boundSnapshotScalar(source?.threads?.[index]?.path),
    })),
    reviews: evidence.reviews.map((item, index) => ({
      author: item[0], submittedAt: item[1], commitOid: item[2],
      state: boundSnapshotScalar(source?.reviews?.[index]?.state),
      displayAuthor: boundSnapshotScalar(source?.reviews?.[index]?.author),
      displayCommitOid: boundSnapshotScalar(source?.reviews?.[index]?.commitOid),
    })),
    comments: evidence.comments.map((item, index) => ({
      id: item[0], author: boundSnapshotScalar(source?.comments?.[index]?.author),
    })),
    degraded: evidence.degraded.map((item, index) => ({
      surface: item[0],
      displaySurface: boundSnapshotScalar(source?.degraded?.[index]?.surface),
      error: boundSnapshotScalar(source?.degraded?.[index]?.error),
    })),
  };
}

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
  const validation = validateContractStructure(event);
  if (!validation.ok
    || event?.schema_id !== 'forge.memory.monitor-event.v1'
    || event.payload?.monitor_id !== monitorId
    || !Number.isSafeInteger(event.payload?.sequence)
    || (typeof row?.content_hash === 'string' && row.content_hash !== event.content_hash)) {
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
      let event = row;
      if (typeof row.envelope_json === 'string') {
        try {
          event = JSON.parse(row.envelope_json);
        } catch {
          throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor history is malformed');
        }
      }
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
    reducer: (_previous, observation, event) => ({
      sequence: event.payload.sequence,
      snapshot: observation.snapshot,
    }),
    terminalPredicate: () => false,
  };
}

function monitorEvent(ctx, record, snapshot, subjectRevision) {
  const seed = `${ctx.monitorId}:${record.seq}:${record.type}:${record.key}`;
  const boundedRecord = {
    ...boundMonitorRecord(record),
    ...(typeof record.repo === 'string' ? { repo: record.repo } : {}),
  };
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
      actionability: record.type === T.SNAPSHOT_CHECKPOINT ? 'advisory' : 'action_required',
      observed_at: record.ts,
      bounded_payload: { record: boundedRecord, snapshot },
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

function terminalPrState(snapshot) {
  const state = String(snapshot?.prState || snapshot?.state || '').toUpperCase();
  if (state === 'MERGED') return 'PASS';
  if (state === 'CLOSED') return 'FAIL';
  return null;
}

async function recordTerminalHandoff(ctx, bridge, spec, state, snapshot, createdAt) {
  const terminalState = terminalPrState(snapshot);
  if (!terminalState) return null;
  const terminating = reduceMonitor(spec, state, { kind: 'subject-terminal', terminalState }).state;
  const terminal = reduceMonitor(spec, terminating, {
    kind: 'cleanup-complete',
    processCleanup: { status: 'not-required', owner: 'repo-singleton-shepherd' },
    leaseCleanup: { status: 'checkpointed', continuing_authority: false },
  }).state;
  const receipt = createMonitorReceipt(spec, terminal, {
    objectId: uuidFrom(`terminal:${ctx.monitorId}:${terminalState}:${terminal.lastSequence}`),
    createdAt,
    producerInstanceId: ctx.monitorId,
  });
  await bridge.recordTerminalReceipt(receipt, { maxHistory: MAX_HISTORY });
  return receipt.object_id;
}

async function readAuthority(ctx) {
  let tail;
  try {
    tail = await ctx.store.readEventTail(ctx.monitorId, { limit: MAX_HISTORY });
  } catch (error) {
    throw new FlowMonitorError('PROVIDER_UNAVAILABLE', 'Durable monitor history is unavailable', { cause: error });
  }
  if (!tail || !Array.isArray(tail.events) || tail.events.length > MAX_HISTORY
    || (tail.overflow && tail.events.length !== MAX_HISTORY)) {
    throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor history exceeds its restart bound');
  }
  const events = tail.events.map(row => parseEventRow(row, ctx.monitorId));
  const firstSequence = events[0]?.payload.sequence ?? 1;
  if (tail.overflow && tail.truncated_before_sequence !== firstSequence) {
    throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor checkpoint boundary is invalid');
  }
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].payload.sequence !== firstSequence + index) {
      throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor history is not contiguous');
    }
  }
  return events;
}

async function readDeliveryAuthority(ctx) {
  let deliveryState;
  try {
    deliveryState = await ctx.store.readDeliveryState(ctx.monitorId, { limit: MAX_HISTORY });
  } catch {
    throw new FlowMonitorError('PROVIDER_UNAVAILABLE', 'Durable delivery state is unavailable');
  }
  if (!deliveryState || deliveryState.overflow?.cursors || !Array.isArray(deliveryState.cursors)) {
    throw new FlowMonitorError('PROVIDER_UNAVAILABLE', 'Durable delivery state is incomplete');
  }
  return deliveryState;
}

function terminalReplay(deliveryState, monitorId) {
  if (!deliveryState.terminal_receipt) return null;
  let terminal;
  try {
    terminal = JSON.parse(deliveryState.terminal_receipt.envelope_json);
  } catch {
    throw new FlowMonitorError('PROVIDER_UNAVAILABLE', 'Durable terminal receipt is malformed');
  }
  const validation = validateContractStructure(terminal);
  if (!validation.ok
    || terminal?.schema_id !== 'forge.memory.monitor-receipt.v1'
    || terminal.payload?.monitor_id !== monitorId
    || typeof terminal.object_id !== 'string' || !terminal.object_id
    || deliveryState.terminal_receipt.content_hash !== terminal.content_hash) {
    throw new FlowMonitorError('PROVIDER_UNAVAILABLE', 'Durable terminal receipt is incomplete');
  }
  return {
    events: [], changed: false, authority: 'memory',
    terminalReceiptId: terminal.object_id,
    receiptIds: [terminal.object_id],
  };
}

async function redeliverOutstanding(ctx, bridge, spec, initialState, durableEvents, deliveryState, now) {
  let state = initialState;
  const receiptIds = [];
  const cursor = deliveryState.cursors.find(item => item.target === DELIVERY_TARGET)?.sequence ?? 0;
  const firstSequence = durableEvents[0]?.payload.sequence ?? 1;
  const lastSequence = durableEvents.at(-1)?.payload.sequence ?? 0;
  if (cursor < firstSequence - 1 || cursor > lastSequence) {
    throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable delivery cursor is outside the restart checkpoint');
  }
  const cursorEvent = durableEvents.find(event => event.payload.sequence === cursor);
  if (cursorEvent && cursorEvent.payload.actionability !== 'advisory' && cursor > 0) {
    state = reduceMonitor(spec, state, { kind: 'acknowledge', sequence: cursor }).state;
  }
  for (const event of durableEvents.filter(item => item.payload.sequence > cursor)) {
    if (event.payload.actionability !== 'advisory') {
      await ctx.deliverLegacy(event.payload.bounded_payload.record, event.payload.event_id);
    }
    const receipt = deliveryReceipt(ctx, event, now());
    await bridge.acknowledgeDelivery(ctx.monitorId, receipt);
    receiptIds.push(receipt.object_id);
    if (event.payload.actionability !== 'advisory') {
      state = reduceMonitor(spec, state, { kind: 'acknowledge', sequence: event.payload.sequence }).state;
    }
  }
  return { state, receiptIds };
}

async function persistRecords(ctx, bridge, spec, {
  initialState,
  records,
  snapshot,
  subjectRevision,
  timestamp,
}) {
  let state = initialState;
  const receiptIds = [];
  for (const record of records) {
    const event = monitorEvent(ctx, record, snapshot, subjectRevision);
    const transition = reduceMonitor(spec, state, { kind: 'observation', event });
    await bridge.persistEvent(event);
    const receipt = deliveryReceipt(ctx, event, timestamp);
    await bridge.acknowledgeDelivery(ctx.monitorId, receipt);
    receiptIds.push(receipt.object_id);
    state = event.payload.actionability === 'advisory'
      ? transition.state
      : reduceMonitor(spec, transition.state, { kind: 'acknowledge', sequence: record.seq }).state;
  }
  return { state, receiptIds };
}

async function finalizePass(ctx, bridge, spec, {
  state,
  snapshot,
  receiptIds,
  createdAt,
  records,
}) {
  const terminalReceiptId = await recordTerminalHandoff(ctx, bridge, spec, state, snapshot, createdAt);
  if (terminalReceiptId) receiptIds.push(terminalReceiptId);
  return {
    events: records,
    changed: records.length > 0,
    authority: 'memory',
    receiptIds,
    ...(terminalReceiptId ? { terminalReceiptId } : {}),
  };
}

async function runFlowMonitorPass(ctx, reopenDepth = 0) {
  const now = ctx.now || defaultNow;
  const durableEvents = await readAuthority(ctx);
  const subjectRevision = ctx.subjectRevision || ctx.subjectId;
  const spec = monitorSpec(ctx, subjectRevision);
  let state = createMonitorState(spec);
  for (const event of durableEvents) {
    state = reduceMonitor(spec, state, { kind: 'observation', event }).state;
  }

  const deliveryState = await readDeliveryAuthority(ctx);
  const replay = terminalReplay(deliveryState, ctx.monitorId);
  if (replay) {
    let gathered; let current;
    try {
      gathered = await ctx.gather();
      current = compactSnapshot(gathered);
    } catch { return replay; }
    const lifecycle = String(current?.prState || current?.state || '').toUpperCase();
    const monitorId = reopenedMonitorId(ctx.monitorId, replay.terminalReceiptId);
    const reopenedHistory = await readAuthority({ ...ctx, monitorId });
    if (lifecycle !== 'OPEN' && reopenedHistory.length === 0) return replay;
    if (reopenDepth >= MAX_REOPEN_DEPTH) {
      throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Reopened monitor lifecycle exceeds its restart bound');
    }
    return runFlowMonitorPass({
      ...ctx,
      monitorId,
      gather: async () => gathered,
    }, reopenDepth + 1);
  }

  const bridge = createMonitorDurabilityBridge({
    store: bridgeStore(ctx.store),
    deliveryTargets: [DELIVERY_TARGET],
    deliver: async (event) => event.payload.actionability === 'advisory'
      ? undefined
      : ctx.deliverLegacy(event.payload.bounded_payload.record, event.payload.event_id),
  });
  const replayed = await redeliverOutstanding(ctx, bridge, spec, state, durableEvents, deliveryState, now);
  state = replayed.state;
  const receiptIds = replayed.receiptIds;

  const gathered = await ctx.gather();
  const next = compactSnapshot(gathered);
  const previousSnapshot = durableEvents.at(-1)?.payload.bounded_payload.snapshot ?? null;
  const previous = previousSnapshot == null
    ? null
    : comparableSnapshot(compactSnapshot(previousSnapshot));
  const candidates = diffSnapshots(previous, comparableSnapshot(next, gathered));
  if (candidates.length === 0) {
    const snapshotChanged = snapshotIdentity(previousSnapshot) !== snapshotIdentity(next);
    if (snapshotChanged) {
      candidates.push(makeEvent(T.SNAPSHOT_CHECKPOINT, computeContentHash(next), {}));
    }
  }
  if (candidates.length === 0) {
    return finalizePass(ctx, bridge, spec, {
      state,
      snapshot: next,
      receiptIds,
      createdAt: now(),
      records: [],
    });
  }
  const timestamp = now();
  const records = finalizeRecords(candidates, {
    baseSeq: durableEvents.at(-1)?.payload.sequence ?? 0,
    ts: timestamp,
    snapshot: next,
  });
  if (typeof ctx.enrich === 'function') await ctx.enrich(records);
  const persisted = await persistRecords(ctx, bridge, spec, {
    initialState: state,
    records,
    snapshot: next,
    subjectRevision,
    timestamp,
  });
  receiptIds.push(...persisted.receiptIds);
  return finalizePass(ctx, bridge, spec, {
    state: persisted.state,
    snapshot: next,
    receiptIds,
    createdAt: timestamp,
    records,
  });
}

module.exports = { FlowMonitorError, runFlowMonitorPass };
