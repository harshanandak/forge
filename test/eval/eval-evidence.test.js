'use strict';

const { describe, expect, test } = require('bun:test');

const {
  createEvalEvidence,
  buildEvalEvidenceHashes,
  verifyEvalEvidence,
  verifyEvalReplay,
  appendEvalEvidence,
} = require('../../scripts/lib/eval-evidence');
const { buildMigratedKernelIssueDeps } = require('../../lib/kernel/cli-broker-factory');
const { stableStringify } = require('../../lib/kernel/evaluators');

const ISSUE_ID = '02f5ea90-4a1a-462f-9b22-54eb5d37f6b3';
const SHA = 'a'.repeat(40);
const HASHES = {
  prompt: '1'.repeat(64),
  skill: '2'.repeat(64),
  tool: '3'.repeat(64),
};

function validCase(overrides = {}) {
  return {
    issue_id: ISSUE_ID,
    pr: 484,
    head_sha: SHA,
    model: 'model-a',
    effort: 'high',
    role: 'implementation',
    hashes: HASHES,
    started_at: '2026-08-05T10:00:00.000Z',
    ended_at: '2026-08-05T10:00:03.000Z',
    active_ms: 2000,
    passive_ms: 1000,
    tokens: { input: 100, output: 25, cached: 5 },
    retries: 0,
    compactions: 0,
    gates: [{ name: 'tests', passed: true }],
    ...overrides,
  };
}

async function freshKernel() {
  const kernel = await buildMigratedKernelIssueDeps({ databasePath: ':memory:' });
  const created = await kernel.kernelBroker.runIssueOperation(
    'create',
    ['--id', ISSUE_ID, '--title', 'eval evidence', '--type', 'task'],
    { actor: 'seed', origin: 'test' },
  );
  expect(created.ok).toBe(true);
  return kernel;
}

function deps(kernel) {
  return { kernelBroker: kernel.kernelBroker, kernelDriver: kernel.kernelDriver };
}

describe('eval evidence', () => {
  test('requires the complete model-neutral case metadata', () => {
    const input = validCase();
    delete input.role;
    expect(() => createEvalEvidence(input)).toThrow(/role.*required/i);
  });

  test('rejects unknown fields at every level so private material cannot persist', () => {
    expect(() => createEvalEvidence(validCase({ prompt: 'raw prompt' }))).toThrow(/unknown field.*prompt/i);
    expect(() => createEvalEvidence(validCase({
      tokens: { input: 1, output: 1, cached: 0, secret: 'token' },
    }))).toThrow(/unknown field.*secret/i);
    expect(() => createEvalEvidence(validCase({
      gates: [{ name: 'tests', passed: true, transcript: 'raw transcript' }],
    }))).toThrow(/unknown field.*transcript/i);
  });

  test('uses stable serialization for a deterministic content hash', () => {
    const first = createEvalEvidence(validCase());
    const reordered = createEvalEvidence({
      gates: [{ passed: true, name: 'tests' }],
      compactions: 0,
      retries: 0,
      tokens: { cached: 5, output: 25, input: 100 },
      passive_ms: 1000,
      active_ms: 2000,
      ended_at: '2026-08-05T10:00:03.000Z',
      started_at: '2026-08-05T10:00:00.000Z',
      hashes: { tool: HASHES.tool, skill: HASHES.skill, prompt: HASHES.prompt },
      role: 'implementation',
      effort: 'high',
      model: 'model-a',
      head_sha: SHA,
      pr: 484,
      issue_id: ISSUE_ID,
    });

    expect(first.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(reordered).toEqual(first);
  });

  test('allow-lists behavioral run identity and binds arm and trial into the content hash', () => {
    const first = createEvalEvidence(validCase({
      run_identity: { arm_id: 'arm-1', trial_index: 0 },
    }));
    const nextTrial = createEvalEvidence(validCase({
      run_identity: { arm_id: 'arm-1', trial_index: 1 },
    }));

    expect(first.evidence.run_identity).toEqual({ arm_id: 'arm-1', trial_index: 0 });
    expect(first.content_hash).not.toBe(nextTrial.content_hash);
    expect(() => createEvalEvidence(validCase({
      run_identity: { arm_id: 'arm-1', trial_index: 0, transcript: 'private' },
    }))).toThrow(/unknown field.*transcript/i);
  });

  test('detects corruption', () => {
    const envelope = createEvalEvidence(validCase());
    envelope.evidence.tokens.output += 1;
    expect(() => verifyEvalEvidence(envelope)).toThrow(/content hash mismatch/i);
  });

  test('builds one deterministic replay hash for the execution and scoring inputs', () => {
    const evalSet = {
      command: '/status',
      queries: [{
        name: 'basic',
        prompt: 'show status',
        setup: null,
        teardown: 'true',
        assertions: [{ type: 'standard', check: 'branch' }],
      }],
    };
    const first = buildEvalEvidenceHashes({ evalSet, skill: 'skill', tool: 'tool' });
    const reordered = {
      queries: [{
        assertions: [{ check: 'branch', type: 'standard' }],
        teardown: 'true',
        prompt: 'show status',
        setup: null,
        name: 'basic',
      }],
      command: '/status',
    };
    expect(buildEvalEvidenceHashes({ evalSet: reordered, skill: 'skill', tool: 'tool' })).toEqual(first);
    expect(first.eval_set).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects malformed query entries before hashing', () => {
    const base = { command: '/status', queries: [] };
    expect(() => buildEvalEvidenceHashes({
      evalSet: { ...base, queries: [null] }, skill: 'skill', tool: 'tool',
    })).toThrow(/evalSet\.queries\[0\] must be an object/i);

    for (const field of ['name', 'prompt', 'assertions']) {
      const query = { name: 'query', prompt: 'prompt', assertions: [{ type: 'standard', check: 'ok' }] };
      delete query[field];
      expect(() => buildEvalEvidenceHashes({
        evalSet: { ...base, queries: [query] }, skill: 'skill', tool: 'tool',
      })).toThrow(new RegExp('evalSet\\.queries\\[0\\]\\.' + field));
    }
  });

  test('strictly allows only canonical replay inputs', () => {
    const envelope = createEvalEvidence(validCase());
    expect(() => verifyEvalReplay(envelope, {
      evalSet: {},
      skill: 'current skill',
      tool: 'current tool',
      secret: 'not allowed',
    })).toThrow(/unknown field.*secret/i);
  });

  test('appends one idempotent Kernel event per content hash', async () => {
    const kernel = await freshKernel();
    const envelope = createEvalEvidence(validCase());
    const options = { deps: deps(kernel), env: { FORGE_ACTOR: 'eval-test' } };

    const first = await appendEvalEvidence('/unused', envelope, options);
    const duplicate = await appendEvalEvidence('/unused', envelope, options);
    const events = await kernel.kernelDriver.listKernelEvents('issue', ISSUE_ID, {}, kernel.kernelBroker.config);
    const evidenceEvents = events.filter(event => event.event_type === 'eval.evidence.recorded');

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(evidenceEvents).toHaveLength(1);
    expect(JSON.parse(evidenceEvents[0].payload_json)).toEqual(envelope);
  });

  test('keys behavioral retries by semantic run identity and rejects conflicting payloads', async () => {
    const kernel = await freshKernel();
    const semanticIdentity = {
      arm_id: 'opaque-a',
      case_id: 'case-001', risk: 'low', split: 'DEV', model: 'model-a',
      config: 'current', budget: 'tier-30', tier: 30, trial_index: 0,
      config_hash: '4'.repeat(64), budget_hash: '5'.repeat(64),
    };
    const caseResult = { status: 'PASS', hard_failure: false, latency_ms: 3000, tokens: 125 };
    const firstEnvelope = createEvalEvidence(validCase({
      run_identity: semanticIdentity,
      case_result: caseResult,
    }));
    const conflictingEnvelope = createEvalEvidence(validCase({
      run_identity: semanticIdentity,
      case_result: caseResult,
      tokens: { input: 101, output: 25, cached: 5 },
    }));
    const options = { deps: deps(kernel), env: { FORGE_ACTOR: 'eval-test' } };

    const first = await appendEvalEvidence('/unused', firstEnvelope, options);
    const duplicate = await appendEvalEvidence('/unused', firstEnvelope, options);
    const conflict = await appendEvalEvidence('/unused', conflictingEnvelope, options);
    const events = await kernel.kernelDriver.listKernelEvents('issue', ISSUE_ID, {}, kernel.kernelBroker.config);

    expect(first.duplicate).toBe(false);
    expect(duplicate).toMatchObject({ ok: true, duplicate: true });
    expect(conflict).toMatchObject({ ok: false, duplicate: false, conflict: true, status: 'INCOMPLETE' });
    expect(events.filter((event) => event.event_type === 'eval.evidence.recorded')).toHaveLength(1);
  });

  test('persists canonical stable envelope bytes regardless of input key order', async () => {
    const kernel = await freshKernel();
    const envelope = createEvalEvidence(validCase());

    await appendEvalEvidence('/unused', envelope, {
      deps: deps(kernel),
      env: { FORGE_ACTOR: 'eval-test' },
    });
    const stored = await kernel.kernelDriver.loadKernelEventByIdempotencyKey(
      `eval.evidence.recorded:${envelope.content_hash}`,
      {},
      kernel.kernelBroker.config,
    );

    expect(stored.payload_json).toBe(stableStringify(envelope));
  });
});
