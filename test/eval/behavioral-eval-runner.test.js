'use strict';

const { describe, expect, test } = require('bun:test');

const { runBehavioralEvaluation } = require('../../scripts/lib/behavioral-eval-runner');
const { hashPacket } = require('../../scripts/lib/immutable-eval-corpus');

const ISSUE_ID = '198bec40-0d65-42a8-b2c2-c682f44fdb22';
const BINDING = {
  repoSha: 'a'.repeat(40),
  configHash: 'b'.repeat(64),
  budgetHash: 'c'.repeat(64),
};

function executorResult(input, overrides = {}) {
  const startedAt = '2026-08-08T10:00:00.000Z';
  const endedAt = '2026-08-08T10:00:01.000Z';
  return {
    evidence: {
      schemaVersion: 1,
      caseId: input.packet.caseId,
      packetHash: hashPacket(input.packet),
      split: input.packet.split,
      trialIndex: input.trialIndex,
      binding: { ...BINDING },
      observation: input.packet.oracle.expected,
      metrics: { durationMs: 1000, tokensUsed: 15 },
      ...overrides.evidence,
    },
    attribution: {
      model: input.armId === 'arm-1' ? 'model-one' : 'model-two',
      effort: 'high',
      role: 'behavioral-eval',
      hashes: {
        prompt: 'd'.repeat(64),
        skill: 'e'.repeat(64),
        tool: 'f'.repeat(64),
      },
      startedAt,
      endedAt,
      activeMs: 1000,
      passiveMs: 0,
      tokens: { input: 10, output: 5, cached: 0 },
      retries: 0,
      compactions: 0,
      ...overrides.attribution,
    },
    ...overrides.result,
  };
}

function options(overrides = {}) {
  const appended = [];
  return {
    appended,
    input: {
      projectRoot: '/unused',
      skillName: 'dev',
      tier: 30,
      issueId: ISSUE_ID,
      pr: 500,
      binding: BINDING,
      arms: ['arm-1', 'arm-2'],
      executor: async (input) => executorResult(input),
      appendEvidence: async (_root, envelope) => {
        appended.push(envelope);
        return { ok: true };
      },
      ...overrides,
    },
  };
}

describe('controlled behavioral evaluation runner', () => {
  test('executes every corpus case and trial in matched opaque arms and appends safe exact-SHA evidence', async () => {
    const executorInputs = [];
    const run = options({
      executor: async (input) => {
        executorInputs.push(input);
        return executorResult(input);
      },
    });
    const result = await runBehavioralEvaluation(run.input);

    expect(result.status).toBe('PASS');
    expect(result.expectedRuns).toBe(30 * 3 * 2);
    expect(result.completedRuns).toBe(result.expectedRuns);
    expect(result.arms).toEqual(['arm-1', 'arm-2']);
    expect(run.appended).toHaveLength(result.expectedRuns);
    expect(Object.keys(executorInputs[0]).sort()).toEqual([
      'armId', 'binding', 'packet', 'skillName', 'trialIndex',
    ]);
    expect(executorInputs[0]).not.toHaveProperty('merge');
    expect(executorInputs[0]).not.toHaveProperty('projectRoot');

    const envelope = run.appended[0];
    expect(envelope.evidence.head_sha).toBe(BINDING.repoSha);
    expect(envelope.evidence.hashes.eval_set).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.evidence.gates).toEqual([{ name: 'behavioral-case', passed: true }]);
    expect(JSON.stringify(envelope)).not.toMatch(/rawPrompt|transcript|toolPayload|secret/i);
    expect(result).not.toHaveProperty('merge');
    expect(result).not.toHaveProperty('winner');
  });

  test('classifies malformed, mismatched, and partial executor evidence as INCOMPLETE', async () => {
    for (const mode of ['malformed', 'mismatched', 'partial']) {
      let calls = 0;
      const run = options({
        executor: async (input) => {
          calls += 1;
          if (calls !== 1) return executorResult(input);
          if (mode === 'partial') return null;
          if (mode === 'mismatched') {
            return executorResult(input, {
              evidence: { binding: { ...BINDING, repoSha: '9'.repeat(40) } },
            });
          }
          return executorResult(input, { evidence: { rawPrompt: 'must never persist' } });
        },
      });

      const result = await runBehavioralEvaluation(run.input);
      expect(result.status).toBe('INCOMPLETE');
      expect(result.incompleteRuns).toBeGreaterThan(0);
      expect(run.appended.every((item) => !JSON.stringify(item).includes('must never persist'))).toBe(true);
    }
  });

  test('returns FAIL only for complete evidence that fails the corpus oracle', async () => {
    let calls = 0;
    const run = options({
      executor: async (input) => {
        calls += 1;
        if (calls === 1) {
          return executorResult(input, {
            evidence: { observation: { ...input.packet.oracle.expected, hardFailure: true } },
          });
        }
        return executorResult(input);
      },
    });

    const result = await runBehavioralEvaluation(run.input);
    expect(result.status).toBe('FAIL');
    expect(result.failedRuns).toBe(1);
    expect(result.incompleteRuns).toBe(0);
  });

  test('missing executor fails closed without appending evidence', async () => {
    const run = options({ executor: undefined });
    const result = await runBehavioralEvaluation(run.input);
    expect(result.status).toBe('INCOMPLETE');
    expect(result.completedRuns).toBe(0);
    expect(run.appended).toHaveLength(0);
  });
});
