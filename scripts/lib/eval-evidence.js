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
const LEGACY_RUN_IDENTITY_FIELDS = ['arm_id', 'trial_index'];
const RUN_IDENTITY_FIELDS = [
  'arm_id', 'case_id', 'risk', 'split', 'model', 'config', 'budget', 'tier',
  'trial_index', 'config_hash', 'budget_hash',
];
const CASE_RESULT_FIELDS = ['status', 'hard_failure', 'latency_ms', 'tokens'];

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

function resolveCaseFields(evidence) {
  const expandedRunIdentity = Object.hasOwn(evidence?.run_identity || {}, 'case_id');
  const fields = expandedRunIdentity
    ? [...CASE_FIELDS, 'run_identity', 'case_result']
    : Object.hasOwn(evidence || {}, 'run_identity') ? [...CASE_FIELDS, 'run_identity'] : CASE_FIELDS;
  return { expandedRunIdentity, fields };
}

function validateExpandedRunIdentity(evidence) {
  const identity = evidence.run_identity;
  for (const field of ['case_id', 'model', 'config', 'budget']) {
    assertString(identity[field], `evidence.run_identity.${field}`);
  }
  if (!['low', 'medium', 'high'].includes(identity.risk)) {
    throw new Error('evidence.run_identity.risk is invalid');
  }
  if (!['DEV', 'TEST'].includes(identity.split)) {
    throw new Error('evidence.run_identity.split is invalid');
  }
  if (!['current', 'bounded'].includes(identity.config)) {
    throw new Error('evidence.run_identity.config is invalid');
  }
  if (![30, 100, 300].includes(identity.tier)) {
    throw new Error('evidence.run_identity.tier is invalid');
  }
  for (const field of ['config_hash', 'budget_hash']) {
    if (!HEX_64.test(identity[field])) {
      throw new Error(`evidence.run_identity.${field} must be a 64-character lowercase SHA-256 hash`);
    }
  }
  if (identity.model !== evidence.model) {
    throw new Error('evidence.run_identity.model must match evidence.model');
  }
}

function validateRunIdentity(evidence, expanded) {
  if (!Object.hasOwn(evidence, 'run_identity')) return;
  const identityFields = expanded ? RUN_IDENTITY_FIELDS : LEGACY_RUN_IDENTITY_FIELDS;
  assertExactFields(evidence.run_identity, identityFields, 'evidence.run_identity');
  assertString(evidence.run_identity.arm_id, 'evidence.run_identity.arm_id');
  assertCount(evidence.run_identity.trial_index, 'evidence.run_identity.trial_index');
  if (expanded) validateExpandedRunIdentity(evidence);
}

function validateCaseResult(caseResult) {
  assertExactFields(caseResult, CASE_RESULT_FIELDS, 'evidence.case_result');
  if (!['PASS', 'FAIL'].includes(caseResult.status)) {
    throw new Error('evidence.case_result.status is invalid');
  }
  if (typeof caseResult.hard_failure !== 'boolean') {
    throw new Error('evidence.case_result.hard_failure must be a boolean');
  }
  assertCount(caseResult.latency_ms, 'evidence.case_result.latency_ms');
  assertCount(caseResult.tokens, 'evidence.case_result.tokens');
}

function validateHashes(hashes) {
  const hashFields = Object.hasOwn(hashes, 'eval_set')
    ? HASH_FIELDS
    : HASH_FIELDS.filter((field) => field !== 'eval_set');
  assertExactFields(hashes, hashFields, 'evidence.hashes');
  for (const field of hashFields) {
    if (!HEX_64.test(hashes[field])) {
      throw new Error(`evidence.hashes.${field} must be a 64-character lowercase SHA-256 hash`);
    }
  }
}

function validateTiming(evidence) {
  assertTimestamp(evidence.started_at, 'evidence.started_at');
  assertTimestamp(evidence.ended_at, 'evidence.ended_at');
  if (Date.parse(evidence.ended_at) < Date.parse(evidence.started_at)) {
    throw new Error('evidence.ended_at must not precede evidence.started_at');
  }
}

function validateCounters(evidence) {
  for (const field of ['active_ms', 'passive_ms', 'retries', 'compactions']) {
    assertCount(evidence[field], `evidence.${field}`);
  }
  assertExactFields(evidence.tokens, ['input', 'output', 'cached'], 'evidence.tokens');
  for (const field of ['input', 'output', 'cached']) {
    assertCount(evidence.tokens[field], `evidence.tokens.${field}`);
  }
}

function validateGates(gates) {
  if (!Array.isArray(gates)) throw new Error('evidence.gates must be an array');
  gates.forEach((gate, index) => {
    assertExactFields(gate, ['name', 'passed'], `evidence.gates[${index}]`);
    assertString(gate.name, `evidence.gates[${index}].name`);
    if (typeof gate.passed !== 'boolean') throw new Error(`evidence.gates[${index}].passed must be a boolean`);
  });
}

function validateEvidence(evidence) {
  const shape = resolveCaseFields(evidence);
  assertExactFields(evidence, shape.fields, 'evidence');
  assertString(evidence.issue_id, 'evidence.issue_id');
  if (!Number.isSafeInteger(evidence.pr) || evidence.pr <= 0) throw new Error('evidence.pr must be a positive integer');
  if (!HEX_40.test(evidence.head_sha)) throw new Error('evidence.head_sha must be a full 40-character commit SHA');
  for (const field of ['model', 'effort', 'role']) assertString(evidence[field], `evidence.${field}`);
  validateRunIdentity(evidence, shape.expandedRunIdentity);
  if (shape.expandedRunIdentity) validateCaseResult(evidence.case_result);
  validateHashes(evidence.hashes);
  validateTiming(evidence);
  validateCounters(evidence);
  validateGates(evidence.gates);
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
  const semanticIdentity = evidence.run_identity && Object.hasOwn(evidence.run_identity, 'case_id')
    ? {
        issue_id: evidence.issue_id,
        pr: evidence.pr,
        head_sha: evidence.head_sha,
        run_identity: evidence.run_identity,
      }
    : null;
  const identityHash = semanticIdentity ? contentHash(stableStringify(semanticIdentity)) : envelope.content_hash;
  const idempotencyKey = `${EVENT_TYPE}:${identityHash}`;

  function replay(existing) {
    const storedEnvelope = parseStoredEnvelope(existing);
    if (storedEnvelope.content_hash !== envelope.content_hash) {
      return {
        ok: false,
        duplicate: false,
        conflict: true,
        status: 'INCOMPLETE',
        event: existing,
        envelope: storedEnvelope,
        actor,
      };
    }
    return { ok: true, duplicate: true, event: existing, envelope: storedEnvelope, actor };
  }

  try {
    const issue = await driver.loadKernelEntity('issue', evidence.issue_id, {}, config);
    if (!issue) return { ok: false, issueMissing: true, actor };

    const existing = await driver.loadKernelEventByIdempotencyKey(idempotencyKey, {}, config);
    if (existing) return replay(existing);

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
      return replay(winner);
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
