'use strict';

const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const { resolveKernelDatabasePath } = require('./kernel/cli-broker-factory');
const { createBuiltinSQLiteDriver } = require('./kernel/sqlite-driver');
const projectMemory = require('./project-memory');

const EVENT_TYPE = 'memory.recall.observed';
const OUTCOMES = new Set(['selected', 'empty', 'filtered', 'unsupported', 'timeout', 'error']);
const MAX_COUNT = 1_000_000;
const MAX_SELECTED_IDS = 20;
const MAX_MIX_KEYS = 10;
const EVENT_WRITER = "const { recordMemoryRecallPayload } = require(process.argv[1]); recordMemoryRecallPayload(process.argv[2], JSON.parse(process.argv[3])).catch(() => {});";

function boundedInteger(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_COUNT, Math.max(0, Math.trunc(value)));
}

function boundedString(value, maxLength) {
  return String(value ?? '').slice(0, maxLength);
}

function boundedMix(mix) {
  if (!mix || typeof mix !== 'object' || Array.isArray(mix)) return {};
  return Object.fromEntries(
    Object.entries(mix)
      .slice(0, MAX_MIX_KEYS)
      .map(([label, count]) => [boundedString(label, 64), boundedInteger(count)])
      .filter(([label, count]) => label && count > 0)
  );
}

function buildRecallEventPayload(observation = {}) {
  const selectedIds = Array.isArray(observation.selectedIds)
    ? observation.selectedIds
      .slice(0, MAX_SELECTED_IDS)
      .map(id => boundedString(id, 128))
      .filter(Boolean)
    : [];
  return {
    outcome: OUTCOMES.has(observation.outcome) ? observation.outcome : 'error',
    counts: {
      candidates: boundedInteger(observation.candidateCount),
      eligible: boundedInteger(observation.eligibleCount),
      selected: selectedIds.length,
    },
    selected_ids: selectedIds,
    source_mix: boundedMix(observation.sourceMix),
    trust_mix: boundedMix(observation.trustMix),
    token_estimate: boundedInteger(observation.tokenEstimate),
    elapsed_ms: boundedInteger(observation.elapsedMs),
    harness: boundedString(observation.harness || 'unknown', 32),
  };
}

function normalizeRecallEventPayload(payload = {}) {
  return buildRecallEventPayload({
    outcome: payload.outcome,
    candidateCount: payload.counts?.candidates,
    eligibleCount: payload.counts?.eligible,
    selectedIds: payload.selected_ids,
    sourceMix: payload.source_mix,
    trustMix: payload.trust_mix,
    tokenEstimate: payload.token_estimate,
    elapsedMs: payload.elapsed_ms,
    harness: payload.harness,
  });
}

async function recordMemoryRecallEvent(projectRoot, observation = {}, options = {}) {
  return recordMemoryRecallPayload(projectRoot, buildRecallEventPayload(observation), options);
}

async function recordMemoryRecallPayload(projectRoot, payload, options = {}) {
  const safePayload = normalizeRecallEventPayload(payload);
  let store = options.store;
  let ownsStore = false;
  try {
    const projectId = options.projectId || projectMemory.resolveProjectId(projectRoot, options);
    if (!store) {
      store = createBuiltinSQLiteDriver({
        databasePath: resolveKernelDatabasePath({
          projectRoot,
          gitCommonDir: options.gitCommonDir,
          databasePath: options.databasePath,
        }),
      });
      ownsStore = true;
    }
    const id = (options.randomUUID || randomUUID)();
    const createdAt = options.now || new Date().toISOString();
    await store.insertKernelEvent({
      id,
      entity_type: 'project',
      entity_id: projectId,
      event_type: EVENT_TYPE,
      idempotency_key: id,
      expected_revision: 0,
      actor: 'forge',
      origin: 'hook',
      payload: safePayload,
      created_at: createdAt,
    });
    return { recorded: true, eventId: id };
  } catch (error) {
    return {
      recorded: false,
      reason: error && error.message ? error.message : 'telemetry unavailable',
    };
  } finally {
    if (ownsStore && store && typeof store.close === 'function') {
      try {
        store.close();
      } catch {
        // Best-effort evidence must never block recall.
      }
    }
  }
}

function launchMemoryRecallEvent(projectRoot, observation = {}, options = {}) {
  try {
    const child = (options.spawn || spawn)(
      process.execPath,
      ['-e', EVENT_WRITER, __filename, projectRoot, JSON.stringify(buildRecallEventPayload(observation))],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return { launched: true };
  } catch {
    return { launched: false };
  }
}

module.exports = {
  EVENT_TYPE,
  buildRecallEventPayload,
  launchMemoryRecallEvent,
  recordMemoryRecallEvent,
  recordMemoryRecallPayload,
};
