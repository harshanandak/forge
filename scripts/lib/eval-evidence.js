'use strict';

const { stableStringify } = require('../../lib/kernel/evaluators');
const { contentHash } = require('../../lib/file-hash');
const { resolveOwnedKernel, closeIfOwned } = require('../../lib/kernel/owned-kernel');
const { resolveIssueActor } = require('../../lib/forge-issues');

const SCHEMA_VERSION = 1;
const EVIDENCE_KIND = 'eval.evidence';
const EVENT_TYPE = 'eval.evidence.recorded';
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const HASH_FIELDS = ['eval_set', 'prompt', 'skill', 'tool'];

const CASE_FIELDS = [
  'issue_id', 'pr', 'head_sha', 'model', 'effort', 'role', 'hashes',
  'started_at', 'ended_at', 'active_ms', 'passive_ms', 'tokens',
  'retries', 'compactions', 'gates',
];

function assertObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

function assertExactFields(value, allowed, path) {
  assertObject(value, path);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown field '${path}.${key}'`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} is required`);
  }
}

function assertString(value, path) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} is required`);
}

function assertCount(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer`);
}

function assertTimestamp(value, path) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${path} must be an ISO timestamp`);
  }
}

function validateEvidence(evidence) {
  assertExactFields(evidence, CASE_FIELDS, 'evidence');
  assertString(evidence.issue_id, 'evidence.issue_id');
  if (!Number.isSafeInteger(evidence.pr) || evidence.pr <= 0) throw new Error('evidence.pr must be a positive integer');
  if (!HEX_40.test(evidence.head_sha)) throw new Error('evidence.head_sha must be a full 40-character commit SHA');
  for (const field of ['model', 'effort', 'role']) assertString(evidence[field], `evidence.${field}`);

  const hashFields = Object.hasOwn(evidence.hashes, 'eval_set')
    ? HASH_FIELDS
    : HASH_FIELDS.filter((field) => field !== 'eval_set');
  assertExactFields(evidence.hashes, hashFields, 'evidence.hashes');
  for (const field of hashFields) {
    if (!HEX_64.test(evidence.hashes[field])) {
      throw new Error(`evidence.hashes.${field} must be a 64-character lowercase SHA-256 hash`);
    }
  }

  assertTimestamp(evidence.started_at, 'evidence.started_at');
  assertTimestamp(evidence.ended_at, 'evidence.ended_at');
  if (Date.parse(evidence.ended_at) < Date.parse(evidence.started_at)) {
    throw new Error('evidence.ended_at must not precede evidence.started_at');
  }

  for (const field of ['active_ms', 'passive_ms', 'retries', 'compactions']) {
    assertCount(evidence[field], `evidence.${field}`);
  }
  assertExactFields(evidence.tokens, ['input', 'output', 'cached'], 'evidence.tokens');
  for (const field of ['input', 'output', 'cached']) assertCount(evidence.tokens[field], `evidence.tokens.${field}`);

  if (!Array.isArray(evidence.gates)) throw new Error('evidence.gates must be an array');
  evidence.gates.forEach((gate, index) => {
    assertExactFields(gate, ['name', 'passed'], `evidence.gates[${index}]`);
    assertString(gate.name, `evidence.gates[${index}].name`);
    if (typeof gate.passed !== 'boolean') throw new Error(`evidence.gates[${index}].passed must be a boolean`);
  });
}

function hashableEnvelope(evidence) {
  return { schema_version: SCHEMA_VERSION, kind: EVIDENCE_KIND, evidence };
}

function createEvalEvidence(evidence) {
  validateEvidence(evidence);
  const normalized = JSON.parse(stableStringify(evidence));
  return {
    ...hashableEnvelope(normalized),
    content_hash: contentHash(stableStringify(hashableEnvelope(normalized))),
  };
}

function buildEvalReplayPayload(evalSet) {
  assertObject(evalSet, 'evalSet');
  if (!Array.isArray(evalSet.queries)) throw new Error('evalSet.queries must be an array');
  return {
    command: evalSet.command,
    queries: evalSet.queries.map((query, index) => {
      const queryPath = 'evalSet.queries[' + index + ']';
      assertObject(query, queryPath);
      assertString(query.name, queryPath + '.name');
      assertString(query.prompt, queryPath + '.prompt');
      if (!Array.isArray(query.assertions) || query.assertions.length === 0) {
        throw new Error(queryPath + '.assertions must be a non-empty array');
      }
      return {
        name: query.name,
        prompt: query.prompt,
        setup: query.setup ?? null,
        teardown: query.teardown ?? null,
        assertions: query.assertions,
      };
    }),
  };
}

function buildEvalEvidenceHashes(inputs) {
  assertExactFields(inputs, ['evalSet', 'skill', 'tool'], 'hash inputs');
  assertString(inputs.skill, 'hash inputs.skill');
  assertString(inputs.tool, 'hash inputs.tool');
  const payload = buildEvalReplayPayload(inputs.evalSet);
  return {
    eval_set: contentHash(stableStringify(payload)),
    prompt: contentHash(stableStringify(payload.queries.map((query) => query.prompt))),
    skill: contentHash(inputs.skill),
    tool: contentHash(inputs.tool),
  };
}

function verifyEvalEvidence(envelope) {
  assertExactFields(envelope, ['schema_version', 'kind', 'evidence', 'content_hash'], 'envelope');
  if (envelope.schema_version !== SCHEMA_VERSION) throw new Error(`Unsupported evidence schema version '${envelope.schema_version}'`);
  if (envelope.kind !== EVIDENCE_KIND) throw new Error(`Unsupported evidence kind '${envelope.kind}'`);
  if (!HEX_64.test(envelope.content_hash)) throw new Error('envelope.content_hash must be a 64-character lowercase SHA-256 hash');
  validateEvidence(envelope.evidence);
  const actual = contentHash(stableStringify(hashableEnvelope(envelope.evidence)));
  if (actual !== envelope.content_hash) throw new Error('Eval evidence content hash mismatch');
  return envelope.evidence;
}

function verifyEvalReplay(envelope, inputs) {
  const evidence = verifyEvalEvidence(envelope);
  assertExactFields(inputs, ['evalSet', 'skill', 'tool'], 'replay.inputs');
  if (!Object.hasOwn(evidence.hashes, 'eval_set')) {
    throw new Error('replay evidence is missing the eval_set hash');
  }
  const expected = buildEvalEvidenceHashes(inputs);
  for (const field of HASH_FIELDS) {
    if (expected[field] !== evidence.hashes[field]) throw new Error(field + ' hash drift detected');
  }
  return evidence;
}

function parseStoredEnvelope(row) {
  const envelope = row.payload_json ? JSON.parse(row.payload_json) : row.payload;
  verifyEvalEvidence(envelope);
  return envelope;
}

function isIdempotencyRace(error) {
  const message = error && error.message ? String(error.message) : '';
  return /UNIQUE constraint failed/i.test(message) && /idempotency_key/i.test(message);
}

async function appendEvalEvidence(projectRoot, envelope, options = {}) {
  const evidence = verifyEvalEvidence(envelope);
  const actor = resolveIssueActor(options.env || process.env) || 'forge';
  const kernel = await resolveOwnedKernel(projectRoot, options.deps);
  const { driver, config } = kernel;
  const idempotencyKey = `${EVENT_TYPE}:${envelope.content_hash}`;

  try {
    const issue = await driver.loadKernelEntity('issue', evidence.issue_id, {}, config);
    if (!issue) return { ok: false, issueMissing: true, actor };

    const existing = await driver.loadKernelEventByIdempotencyKey(idempotencyKey, {}, config);
    if (existing) return { ok: true, duplicate: true, event: existing, envelope: parseStoredEnvelope(existing), actor };

    const event = {
      entity_type: 'issue',
      entity_id: evidence.issue_id,
      event_type: EVENT_TYPE,
      idempotency_key: idempotencyKey,
      expected_revision: 0,
      actor,
      origin: 'eval',
      payload_json: stableStringify(envelope),
      created_at: options.now || new Date().toISOString(),
    };
    try {
      const inserted = await driver.insertKernelEvent(event, {}, config);
      return { ok: true, duplicate: false, event: inserted, envelope, actor };
    } catch (error) {
      if (!isIdempotencyRace(error)) throw error;
      const winner = await driver.loadKernelEventByIdempotencyKey(idempotencyKey, {}, config);
      return { ok: true, duplicate: true, event: winner, envelope: parseStoredEnvelope(winner), actor };
    }
  } finally {
    closeIfOwned(kernel);
  }
}

module.exports = {
  SCHEMA_VERSION,
  EVIDENCE_KIND,
  EVENT_TYPE,
  createEvalEvidence,
  buildEvalReplayPayload,
  buildEvalEvidenceHashes,
  verifyEvalEvidence,
  verifyEvalReplay,
  appendEvalEvidence,
};
