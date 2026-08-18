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
const PENDING_BATCH_LIMIT = 12_000;
const PENDING_BATCH_OUTPUT_LIMIT = 262_144;
// One event per bounded surface delta, plus a second reply/resolution event per thread.
const PENDING_BATCH_RECORD_LIMIT = 538;
const BATCH_PLAN_FORMAT = 'segments-v1';
const BATCH_PLAN_SEGMENT_LIMIT = 128;
const MAX_REOPEN_DEPTH = 8;
const SNAPSHOT_FORMAT = 'digest-v1';
const SNAPSHOT_EVIDENCE_KEYS = new Set(['checks', 'threads', 'reviews', 'comments', 'degraded']);
const UNSAFE_PROVIDER_DIAGNOSTIC = /(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk_(?:live|test)_[a-z0-9]{16,}|sk-[a-z0-9]{16,}|AKIA[0-9A-Z]{16}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}|(?:^|[\\/])(?:users|home|root)[\\/]\S+)/i;
const REDACTED_PROVIDER_DIAGNOSTIC = '[provider diagnostic redacted]';

class FlowMonitorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'FlowMonitorError';
    this.code = code;
  }
}

function validBatchPlanSegmentCount(value) {
  return Number.isSafeInteger(value) && value > 1 && value <= BATCH_PLAN_SEGMENT_LIMIT;
}

function appendPendingBatch(batches, batch) {
  if (batches.length >= BATCH_PLAN_SEGMENT_LIMIT) {
    throw new FlowMonitorError('INVALID_OBSERVATION', 'Pending monitor transition plan exceeds its segment bound');
  }
  batches.push(batch);
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
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username && !url.password && !url.search && !url.hash
      ? value
      : null;
  } catch {
    return null;
  }
}

function safeProviderDiagnostic(value) {
  return typeof value === 'string' && UNSAFE_PROVIDER_DIAGNOSTIC.test(value)
    ? REDACTED_PROVIDER_DIAGNOSTIC
    : value;
}

function boundMonitorRecord(record) {
  const safeError = safeProviderDiagnostic(record.data?.error);
  const safeRecord = safeError !== record.data?.error
    ? { ...record, data: { ...record.data, error: safeError } }
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

function durableMonitorRecord(record) {
  return {
    ...boundMonitorRecord(record),
    ...(typeof record.repo === 'string' ? { repo: record.repo } : {}),
  };
}

function encodePendingBatch(ctx, subjectRevision, records, snapshot) {
  if (records.length < 1 || records.length > PENDING_BATCH_RECORD_LIMIT) {
    throw new FlowMonitorError('INVALID_OBSERVATION', 'Pending monitor transition batch exceeds its record bound');
  }
  const core = {
    monitor_id: ctx.monitorId,
    subject_revision: subjectRevision,
    snapshot_identity: snapshot === null ? null : snapshotIdentity(snapshot),
    records: records.map(durableMonitorRecord),
    snapshot,
  };
  const serialized = JSON.stringify({
    ...core,
    batch_id: computeContentHash(core),
  });
  if (Buffer.byteLength(serialized) > PENDING_BATCH_OUTPUT_LIMIT) {
    throw new FlowMonitorError('INVALID_OBSERVATION', 'Pending monitor transition batch exceeds its recovery bound');
  }
  const encoded = zlib.gzipSync(serialized, { level: 9 }).toString('base64url');
  if (encoded.length > PENDING_BATCH_LIMIT) {
    throw new FlowMonitorError('INVALID_OBSERVATION', 'Pending monitor transition batch exceeds its durable bound');
  }
  return encoded;
}

function decodePendingBatch(value, ctx, subjectRevision) {
  if (typeof value !== 'string' || value.length > PENDING_BATCH_LIMIT) {
    throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Pending monitor transition batch is missing');
  }
  try {
    const decoded = JSON.parse(zlib.gunzipSync(Buffer.from(value, 'base64url'), {
      maxOutputLength: PENDING_BATCH_OUTPUT_LIMIT,
    }));
    const { batch_id: batchId, ...core } = decoded || {};
    if (core.monitor_id !== ctx.monitorId || core.subject_revision !== subjectRevision
      || core.snapshot_identity !== (core.snapshot === null ? null : snapshotIdentity(core.snapshot))
      || batchId !== computeContentHash(core)
      || !Array.isArray(core.records) || core.records.length < 1
      || core.records.length > PENDING_BATCH_RECORD_LIMIT) {
      throw new Error('invalid pending batch');
    }
    return { ...core, batchId, encoded: value };
  } catch (error) {
    if (error instanceof FlowMonitorError) throw error;
    throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Pending monitor transition batch is malformed');
  }
}

function segmentablePendingBatchError(error) {
  return error instanceof FlowMonitorError
    && error.code === 'INVALID_OBSERVATION'
    && [
      'Pending monitor transition batch exceeds its recovery bound',
      'Pending monitor transition batch exceeds its durable bound',
    ].includes(error.message);
}

function splitPendingBatches(ctx, subjectRevision, records, snapshot) {
  const batches = [];
  let offset = 0;
  while (offset < records.length) {
    try {
      const encoded = encodePendingBatch(ctx, subjectRevision, records.slice(offset), snapshot);
      appendPendingBatch(batches, { encoded, records: records.slice(offset), snapshot });
      break;
    } catch (error) {
      if (!segmentablePendingBatchError(error)) throw error;
    }

    let low = 1;
    let high = records.length - offset - 1;
    let accepted = null;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const candidate = records.slice(offset, offset + count);
      try {
        accepted = {
          count,
          encoded: encodePendingBatch(ctx, subjectRevision, candidate, null),
          records: candidate,
          snapshot: null,
        };
        low = count + 1;
      } catch (error) {
        if (!segmentablePendingBatchError(error)) throw error;
        high = count - 1;
      }
    }
    if (!accepted) {
      throw new FlowMonitorError('INVALID_OBSERVATION', 'Pending monitor transition record exceeds its durable bound');
    }
    appendPendingBatch(batches, accepted);
    offset += accepted.count;
  }
  return batches;
}

function batchPlanReference(planId, startSequence, segmentCount, extra = {}) {
  return {
    format: BATCH_PLAN_FORMAT,
    id: planId,
    start_sequence: startSequence,
    segment_count: segmentCount,
    ...extra,
  };
}

function validBatchPlanReference(value) {
  return value && typeof value === 'object'
    && value.format === BATCH_PLAN_FORMAT
    && typeof value.id === 'string' && /^[a-f0-9]{64}$/.test(value.id)
    && Number.isSafeInteger(value.start_sequence) && value.start_sequence > 0
    && validBatchPlanSegmentCount(value.segment_count);
}

function batchPlanSegmentIndex(batches, recordOffset) {
  let boundary = 0;
  for (let index = 0; index < batches.length; index += 1) {
    boundary += batches[index].records.length;
    if (recordOffset < boundary) return index;
  }
  return -1;
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
      error: boundSnapshotScalar(safeProviderDiagnostic(source?.degraded?.[index]?.error)),
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

function monitorEventId(monitorId, sequence, type, key) {
  return crypto.createHash('sha256')
    .update(`${monitorId}:${sequence}:${type}:${key}`)
    .digest('hex');
}

function monitorEvent(
  ctx,
  record,
  snapshot,
  subjectRevision,
  checkpointComplete = true,
  pendingBatch = null,
  recordIsBounded = false,
  batchPlan = null,
) {
  const seed = `${ctx.monitorId}:${record.seq}:${record.type}:${record.key}`;
  const boundedRecord = recordIsBounded ? record : durableMonitorRecord(record);
  return envelope(
    'forge.memory.monitor-event.v1',
    uuidFrom(`event-object:${seed}`),
    record.ts,
    ctx.monitorId,
    {
      monitor_id: ctx.monitorId,
      event_id: monitorEventId(ctx.monitorId, record.seq, record.type, record.key),
      sequence: record.seq,
      subject_revision: subjectRevision,
      type: record.type,
      actionability: record.type === T.SNAPSHOT_CHECKPOINT ? 'advisory' : 'action_required',
      observed_at: record.ts,
      bounded_payload: {
        record: boundedRecord,
        snapshot,
        checkpoint_complete: checkpointComplete,
        ...(pendingBatch ? { pending_batch: pendingBatch } : {}),
        ...(batchPlan ? { batch_plan: batchPlan } : {}),
      },
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
  batchRecords = records,
  batchOffset = 0,
  pendingBatch = null,
  recordsAreBounded = false,
  batchPlan = null,
}) {
  let state = initialState;
  const receiptIds = [];
  const batchEvidence = batchPlan ? null : pendingBatch || (batchRecords.length > 1
    ? encodePendingBatch(ctx, subjectRevision, batchRecords, snapshot)
    : null);
  const prepared = [];
  let validatedState = state;
  for (const [index, record] of records.entries()) {
    const checkpointComplete = batchOffset + index === batchRecords.length - 1;
    const event = monitorEvent(
      ctx,
      record,
      checkpointComplete ? snapshot : null,
      subjectRevision,
      checkpointComplete,
      checkpointComplete ? null : batchEvidence,
      recordsAreBounded,
      typeof batchPlan === 'function' ? batchPlan(batchOffset + index) : batchPlan,
    );
    const transition = reduceMonitor(spec, validatedState, { kind: 'observation', event });
    const receipt = deliveryReceipt(ctx, event, timestamp);
    const nextState = event.payload.actionability === 'advisory'
      ? transition.state
      : reduceMonitor(spec, transition.state, { kind: 'acknowledge', sequence: record.seq }).state;
    prepared.push({ event, receipt, nextState });
    validatedState = nextState;
  }
  for (const { event, receipt, nextState } of prepared) {
    await bridge.persistEvent(event);
    await bridge.acknowledgeDelivery(ctx.monitorId, receipt);
    receiptIds.push(receipt.object_id);
    state = nextState;
  }
  return { state, receiptIds };
}

async function persistSegmentedRecords(ctx, bridge, spec, {
  initialState,
  records,
  snapshot,
  subjectRevision,
  timestamp,
}) {
  let segmentCount = 2;
  let shiftedRecords;
  let batches;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    shiftedRecords = records.map(record => ({ ...record, seq: record.seq + segmentCount + 1 }));
    batches = splitPendingBatches(ctx, subjectRevision, shiftedRecords, snapshot);
    if (batches.length === segmentCount) break;
    segmentCount = batches.length;
  }
  if (!batches || batches.length !== segmentCount || segmentCount < 2) {
    throw new FlowMonitorError('INVALID_OBSERVATION', 'Pending monitor transition plan did not converge');
  }

  const planId = computeContentHash({
    monitor_id: ctx.monitorId,
    subject_revision: subjectRevision,
    segments: batches.map(batch => batch.encoded),
  });
  const startSequence = records[0].seq;
  const planCandidates = [
    ...batches.map((_batch, index) => makeEvent(
      T.SNAPSHOT_CHECKPOINT,
      `batch-plan:${planId}:${index}`,
      {},
    )),
    makeEvent(T.SNAPSHOT_CHECKPOINT, `batch-plan:${planId}:commit`, {}),
  ];
  const planRecords = finalizeRecords(planCandidates, {
    baseSeq: startSequence - 1,
    ts: timestamp,
    snapshot,
  });
  const entries = [
    ...batches.map((batch, index) => ({
      record: planRecords[index],
      snapshot: null,
      checkpointComplete: false,
      pendingBatch: batch.encoded,
      batchPlan: batchPlanReference(planId, startSequence, segmentCount, { index }),
    })),
    {
      record: planRecords.at(-1),
      snapshot: null,
      checkpointComplete: false,
      pendingBatch: null,
      batchPlan: batchPlanReference(planId, startSequence, segmentCount, { committed: true }),
    },
    ...shiftedRecords.map((record, index) => ({
      record,
      snapshot: index === shiftedRecords.length - 1 ? snapshot : null,
      checkpointComplete: index === shiftedRecords.length - 1,
      pendingBatch: null,
      batchPlan: batchPlanReference(planId, startSequence, segmentCount, {
        segment_index: batchPlanSegmentIndex(batches, index),
      }),
    })),
  ];

  let validatedState = initialState;
  const prepared = [];
  for (const entry of entries) {
    const event = monitorEvent(
      ctx,
      entry.record,
      entry.snapshot,
      subjectRevision,
      entry.checkpointComplete,
      entry.pendingBatch,
      false,
      entry.batchPlan,
    );
    const transition = reduceMonitor(spec, validatedState, { kind: 'observation', event });
    const receipt = deliveryReceipt(ctx, event, timestamp);
    const nextState = event.payload.actionability === 'advisory'
      ? transition.state
      : reduceMonitor(spec, transition.state, { kind: 'acknowledge', sequence: entry.record.seq }).state;
    prepared.push({ event, receipt, nextState });
    validatedState = nextState;
  }

  let state = initialState;
  const receiptIds = [];
  for (const { event, receipt, nextState } of prepared) {
    await bridge.persistEvent(event);
    await bridge.acknowledgeDelivery(ctx.monitorId, receipt);
    receiptIds.push(receipt.object_id);
    state = nextState;
  }
  return { state, receiptIds, records: shiftedRecords };
}

function planRecordKey(planId, index) {
  return `batch-plan:${planId}:${index}`;
}

async function readPlannedEvent(ctx, durableEvents, sequence, key) {
  const expectedId = monitorEventId(ctx.monitorId, sequence, T.SNAPSHOT_CHECKPOINT, key);
  const retained = durableEvents.find(event => event.payload.sequence === sequence);
  if (retained) return retained.payload.event_id === expectedId ? retained : null;
  if (typeof ctx.store.getEvent !== 'function') return null;
  let row;
  try {
    row = await ctx.store.getEvent(expectedId);
  } catch (error) {
    throw new FlowMonitorError('PROVIDER_UNAVAILABLE', 'Durable monitor transition plan is unavailable', { cause: error });
  }
  if (!row) return null;
  const event = parseEventRow(row, ctx.monitorId);
  return event.payload.event_id === expectedId && event.payload.sequence === sequence ? event : null;
}

async function readSegmentedRecovery(ctx, durableEvents, pendingEvents, subjectRevision) {
  const references = [];
  for (let index = pendingEvents.length - 1; index >= 0; index -= 1) {
    const reference = pendingEvents[index].payload.bounded_payload.batch_plan;
    if (validBatchPlanReference(reference)
      && !references.some(item => item.id === reference.id)) {
      references.push(reference);
    }
  }

  for (const reference of references) {
    const markerSequence = reference.start_sequence + reference.segment_count;
    const referenceEvents = pendingEvents.filter(event => (
      event.payload.bounded_payload.batch_plan?.id === reference.id
    ));
    const committedHint = referenceEvents.some(event => (
      event.payload.bounded_payload.batch_plan?.committed === true
      || event.payload.sequence > markerSequence
    ));
    const marker = await readPlannedEvent(
      ctx,
      durableEvents,
      markerSequence,
      planRecordKey(reference.id, 'commit'),
    );
    if (!marker) {
      if (committedHint) {
        throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor transition plan marker is missing');
      }
      continue;
    }
    const markerReference = marker.payload.bounded_payload.batch_plan;
    const markerRecord = marker.payload.bounded_payload.record;
    const markerKey = planRecordKey(reference.id, 'commit');
    if (!validBatchPlanReference(markerReference)
      || markerReference.id !== reference.id
      || markerReference.start_sequence !== reference.start_sequence
      || markerReference.segment_count !== reference.segment_count
      || markerReference.committed !== true
      || marker.payload.event_id !== monitorEventId(
        ctx.monitorId,
        markerSequence,
        T.SNAPSHOT_CHECKPOINT,
        markerKey,
      )
      || marker.payload.sequence !== markerSequence
      || marker.payload.subject_revision !== subjectRevision
      || marker.payload.type !== T.SNAPSHOT_CHECKPOINT
      || marker.payload.actionability !== 'advisory'
      || markerRecord?.key !== boundIdentity(markerKey)
      || markerRecord?.seq !== markerSequence
      || markerRecord?.type !== T.SNAPSHOT_CHECKPOINT
      || marker.payload.observed_at !== markerRecord?.ts
      || marker.payload.bounded_payload.snapshot !== null
      || marker.payload.bounded_payload.checkpoint_complete !== false
      || marker.payload.bounded_payload.pending_batch !== undefined) {
      throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor transition plan marker is inconsistent');
    }

    const batches = [];
    for (let index = 0; index < reference.segment_count; index += 1) {
      const segmentSequence = reference.start_sequence + index;
      const segmentKey = planRecordKey(reference.id, index);
      const segment = await readPlannedEvent(
        ctx,
        durableEvents,
        segmentSequence,
        segmentKey,
      );
      const segmentReference = segment?.payload.bounded_payload.batch_plan;
      const pendingBatch = segment?.payload.bounded_payload.pending_batch;
      const segmentRecord = segment?.payload.bounded_payload.record;
      if (!segment
        || !validBatchPlanReference(segmentReference)
        || segmentReference.id !== reference.id
        || segmentReference.start_sequence !== reference.start_sequence
        || segmentReference.segment_count !== reference.segment_count
        || segmentReference.index !== index
        || segmentReference.committed !== undefined
        || segmentReference.segment_index !== undefined
        || segment.payload.event_id !== monitorEventId(
          ctx.monitorId,
          segmentSequence,
          T.SNAPSHOT_CHECKPOINT,
          segmentKey,
        )
        || segment.payload.sequence !== segmentSequence
        || segment.payload.subject_revision !== subjectRevision
        || segment.payload.type !== T.SNAPSHOT_CHECKPOINT
        || segment.payload.actionability !== 'advisory'
        || segmentRecord?.key !== boundIdentity(segmentKey)
        || segmentRecord?.seq !== segmentSequence
        || segmentRecord?.type !== T.SNAPSHOT_CHECKPOINT
        || segment.payload.observed_at !== segmentRecord?.ts
        || segment.payload.bounded_payload.snapshot !== null
        || segment.payload.bounded_payload.checkpoint_complete !== false
        || typeof pendingBatch !== 'string') {
        throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor transition plan segment is inconsistent');
      }
      batches.push(decodePendingBatch(pendingBatch, ctx, subjectRevision));
    }
    const planId = computeContentHash({
      monitor_id: ctx.monitorId,
      subject_revision: subjectRevision,
      segments: batches.map(batch => batch.encoded),
    });
    if (planId !== reference.id
      || batches.slice(0, -1).some(batch => batch.snapshot !== null)
      || batches.at(-1).snapshot === null) {
      throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor transition plan identity is inconsistent');
    }

    const records = batches.flatMap(batch => batch.records);
    const actualStart = markerSequence + 1;
    if (records.some((record, index) => record.seq !== actualStart + index)) {
      throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor transition plan sequence is inconsistent');
    }
    const actualEvents = pendingEvents.filter(event => event.payload.sequence >= actualStart);
    const retainedOffset = actualEvents.length > 0
      ? actualEvents[0].payload.sequence - actualStart
      : 0;
    const remainingOffset = retainedOffset + actualEvents.length;
    if (!Number.isSafeInteger(retainedOffset) || retainedOffset < 0
      || remainingOffset > records.length) {
      throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor transition plan has no remaining checkpoint');
    }
    for (const [index, event] of actualEvents.entries()) {
      const eventReference = event.payload.bounded_payload.batch_plan;
      const recordOffset = retainedOffset + index;
      const expectedRecord = records[recordOffset];
      const checkpointComplete = recordOffset === records.length - 1;
      const expectedActionability = expectedRecord.type === T.SNAPSHOT_CHECKPOINT
        ? 'advisory'
        : 'action_required';
      if (!validBatchPlanReference(eventReference)
        || eventReference.id !== reference.id
        || eventReference.segment_index !== batchPlanSegmentIndex(batches, recordOffset)
        || event.payload.sequence !== actualStart + recordOffset
        || event.payload.event_id !== monitorEventId(
          ctx.monitorId,
          expectedRecord.seq,
          expectedRecord.type,
          expectedRecord.key,
        )
        || event.payload.type !== expectedRecord.type
        || event.payload.actionability !== expectedActionability
        || event.payload.bounded_payload.checkpoint_complete !== checkpointComplete
        || event.payload.bounded_payload.pending_batch !== undefined
        || computeContentHash({ snapshot: event.payload.bounded_payload.snapshot ?? null })
          !== computeContentHash({ snapshot: checkpointComplete ? batches.at(-1).snapshot : null })
        || computeContentHash(event.payload.bounded_payload.record) !== computeContentHash(expectedRecord)) {
        throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Pending monitor transition identity is inconsistent');
      }
    }
    return {
      records,
      remainingOffset,
      snapshot: batches.at(-1).snapshot,
      reference: batchPlanReference(
        reference.id,
        reference.start_sequence,
        reference.segment_count,
      ),
      batches,
    };
  }
  return null;
}

function validOrphanedPrecommitPlan(ctx, pendingEvents, subjectRevision) {
  if (pendingEvents.length === 0) return false;
  let offset = 0;
  while (offset < pendingEvents.length) {
    const reference = pendingEvents[offset].payload.bounded_payload.batch_plan;
    if (!validBatchPlanReference(reference)
      || reference.start_sequence !== pendingEvents[offset].payload.sequence
      || reference.index !== 0) return false;
    const batches = [];
    while (offset < pendingEvents.length) {
      const event = pendingEvents[offset];
      const candidate = event.payload.bounded_payload.batch_plan;
      if (candidate?.id !== reference.id) break;
      const index = batches.length;
      const pendingBatch = event.payload.bounded_payload.pending_batch;
      const record = event.payload.bounded_payload.record;
      const key = planRecordKey(reference.id, index);
      if (event.payload.actionability !== 'advisory'
        || !validBatchPlanReference(candidate)
        || candidate.start_sequence !== reference.start_sequence
        || candidate.segment_count !== reference.segment_count
        || candidate.index !== index
        || index >= reference.segment_count
        || candidate.committed === true
        || event.payload.sequence !== reference.start_sequence + index
        || event.payload.event_id !== monitorEventId(
          ctx.monitorId,
          event.payload.sequence,
          T.SNAPSHOT_CHECKPOINT,
          key,
        )
        || event.payload.type !== T.SNAPSHOT_CHECKPOINT
        || event.payload.bounded_payload.snapshot !== null
        || event.payload.bounded_payload.checkpoint_complete !== false
        || record?.type !== T.SNAPSHOT_CHECKPOINT
        || record?.key !== boundIdentity(key)
        || record?.seq !== event.payload.sequence
        || typeof pendingBatch !== 'string') return false;
      try {
        batches.push(decodePendingBatch(pendingBatch, ctx, subjectRevision));
      } catch {
        return false;
      }
      offset += 1;
    }
    if (batches.length < reference.segment_count) {
      if (batches.some(batch => batch.snapshot !== null)) return false;
      continue;
    }
    const planId = computeContentHash({
      monitor_id: ctx.monitorId,
      subject_revision: subjectRevision,
      segments: batches.map(batch => batch.encoded),
    });
    if (planId !== reference.id
      || batches.slice(0, -1).some(batch => batch.snapshot !== null)
      || batches.at(-1).snapshot === null) return false;
  }
  return true;
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

  let checkpointIndex = -1;
  for (let index = durableEvents.length - 1; index >= 0; index -= 1) {
    if (durableEvents[index].payload.bounded_payload.checkpoint_complete !== false) {
      checkpointIndex = index;
      break;
    }
  }
  const previousSnapshot = checkpointIndex >= 0
    ? durableEvents[checkpointIndex].payload.bounded_payload.snapshot ?? null
    : null;
  const pendingEvents = durableEvents.slice(checkpointIndex + 1);
  const deliveryCursor = deliveryState.cursors.find(item => item.target === DELIVERY_TARGET)?.sequence ?? 0;
  const unacknowledgedPlanEvents = durableEvents.filter(event => (
    event.payload.sequence > deliveryCursor && event.payload.bounded_payload.batch_plan
  ));
  const recoveryEvents = pendingEvents.some(event => event.payload.bounded_payload.batch_plan)
    ? pendingEvents
    : unacknowledgedPlanEvents;
  const segmented = recoveryEvents.length > 0
    ? await readSegmentedRecovery(ctx, durableEvents, recoveryEvents, subjectRevision)
    : null;
  const hasBatchPlan = recoveryEvents.some(event => event.payload.bounded_payload.batch_plan);
  const orphanedPlan = !segmented && hasBatchPlan
    && recoveryEvents === pendingEvents
    && validOrphanedPrecommitPlan(ctx, pendingEvents, subjectRevision);
  if (!segmented && hasBatchPlan && !orphanedPlan) {
    throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Durable monitor transition plan is inconsistent');
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
  if (pendingEvents.length > 0) {
    if (segmented) {
      const remaining = segmented.records.slice(segmented.remainingOffset);
      const timestamp = remaining[0].ts;
      const persisted = await persistRecords(ctx, bridge, spec, {
        initialState: state,
        records: remaining,
        snapshot: segmented.snapshot,
        subjectRevision,
        timestamp,
        batchRecords: segmented.records,
        batchOffset: segmented.remainingOffset,
        recordsAreBounded: true,
        batchPlan: offset => ({
          ...segmented.reference,
          segment_index: batchPlanSegmentIndex(segmented.batches, offset),
        }),
      });
      receiptIds.push(...persisted.receiptIds);
      return finalizePass(ctx, bridge, spec, {
        state: persisted.state,
        snapshot: segmented.snapshot,
        receiptIds,
        createdAt: timestamp,
        records: remaining,
      });
    }
    if (orphanedPlan) {
      // A crash before the commit marker leaves only advisory preparation events.
      // No provider transition was accepted, so a fresh gather may safely supersede it.
    } else {
    const pendingValue = pendingEvents.at(-1).payload.bounded_payload.pending_batch;
    const batch = decodePendingBatch(pendingValue, ctx, subjectRevision);
    const retainedOffset = pendingEvents[0].payload.sequence - batch.records[0].seq;
    const remainingOffset = retainedOffset + pendingEvents.length;
    if (!Number.isSafeInteger(retainedOffset) || retainedOffset < 0
      || remainingOffset >= batch.records.length) {
      throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Pending monitor transition batch has no remaining checkpoint');
    }
    for (const [index, pending] of pendingEvents.entries()) {
      if (pending.payload.bounded_payload.pending_batch !== batch.encoded
        || computeContentHash(pending.payload.bounded_payload.record) !== computeContentHash(batch.records[retainedOffset + index])) {
        throw new FlowMonitorError('MONITOR_HISTORY_INCOMPLETE', 'Pending monitor transition identity is inconsistent');
      }
    }
    const remaining = batch.records.slice(remainingOffset);
    const timestamp = remaining[0].ts;
    const persisted = await persistRecords(ctx, bridge, spec, {
      initialState: state,
      records: remaining,
      snapshot: batch.snapshot,
      subjectRevision,
      timestamp,
      batchRecords: batch.records,
      batchOffset: remainingOffset,
      pendingBatch: batch.encoded,
      recordsAreBounded: true,
    });
    receiptIds.push(...persisted.receiptIds);
    return finalizePass(ctx, bridge, spec, {
      state: persisted.state,
      snapshot: batch.snapshot,
      receiptIds,
      createdAt: timestamp,
      records: remaining,
    });
    }
  }

  const gathered = await ctx.gather();
  const next = compactSnapshot(gathered);
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
  let persisted;
  try {
    persisted = await persistRecords(ctx, bridge, spec, {
      initialState: state,
      records,
      snapshot: next,
      subjectRevision,
      timestamp,
    });
  } catch (error) {
    if (!segmentablePendingBatchError(error)) throw error;
    persisted = await persistSegmentedRecords(ctx, bridge, spec, {
      initialState: state,
      records,
      snapshot: next,
      subjectRevision,
      timestamp,
    });
  }
  receiptIds.push(...persisted.receiptIds);
  return finalizePass(ctx, bridge, spec, {
    state: persisted.state,
    snapshot: next,
    receiptIds,
    createdAt: timestamp,
    records: persisted.records || records,
  });
}

module.exports = {
  FlowMonitorError,
  runFlowMonitorPass,
  _internals: { appendPendingBatch },
};
