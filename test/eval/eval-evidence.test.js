'use strict';

const { describe, expect, test } = require('bun:test');

const {
  createEvalEvidence,
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

  test('detects corruption', () => {
    const envelope = createEvalEvidence(validCase());
    envelope.evidence.tokens.output += 1;
    expect(() => verifyEvalEvidence(envelope)).toThrow(/content hash mismatch/i);
  });

  test('strictly allows only transient prompt, skill, and tool contents for replay', () => {
    const envelope = createEvalEvidence(validCase());
    expect(() => verifyEvalReplay(envelope, {
      prompt: 'current prompt',
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
