'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _internal } = require('../../scripts/lib/behavioral-eval-runtime');
const { loadTier } = require('../../scripts/lib/immutable-eval-corpus');

describe('behavioral eval production runtime', () => {
  test('freezes a deterministic two-model current/bounded routing matrix', () => {
    const input = {
      tier: 30,
      skillName: 'dev',
      skillText: 'bounded contract',
      models: ['model-one', 'model-two'],
      command: ['claude'],
      env: {},
    };
    const first = _internal.buildConfig(input);
    const second = _internal.buildConfig(input);

    expect(second).toEqual(first);
    expect(first.arms.map(({ model, config }) => `${model}:${config}`)).toEqual([
      'model-one:current', 'model-one:bounded',
      'model-two:current', 'model-two:bounded',
    ]);
    expect(new Set(first.arms.map((arm) => arm.id)).size).toBe(4);

    const differentEffort = _internal.buildConfig({
      ...input,
      env: { FORGE_EVAL_EFFORT: 'max' },
    });
    expect(differentEffort.configHash).not.toBe(first.configHash);
    expect(() => _internal.buildConfig({
      ...input,
      env: { FORGE_EVAL_EFFORT: 'unsupported' },
    })).toThrow('effort.invalid');
  });

  test('live-loads an active relevant issue and live-verifies the PR exact head', async () => {
    const issueId = '198bec40-0d65-42a8-b2c2-c682f44fdb22';
    const head = 'a'.repeat(40);
    const branch = 'codex/beta5-eval-seam';
    const prCalls = [];
    const deps = {
      execFileSync: (command, args) => {
        expect(command).toBe('git');
        expect(args).toEqual(['branch', '--show-current']);
        return `${branch}\n`;
      },
      kernelDriver: {
        listWorktrees: () => [{ branch, issue_id: issueId, state: 'active' }],
        loadKernelEntity: async (type, id) => (
          type === 'issue' && id === issueId ? { id, status: 'in_progress' } : null
        ),
      },
      prAdapter: {
        readState: async (pr) => {
          prCalls.push(pr);
          return { state: 'OPEN', headSha: head };
        },
      },
    };

    await expect(_internal.resolveAttribution('/repo', head, {
      FORGE_EVAL_ISSUE_ID: issueId,
      FORGE_EVAL_PR: '500',
      FORGE_EVAL_PR_HEAD: head,
    }, deps)).resolves.toEqual({ issueId, pr: 500 });
    expect(prCalls).toEqual([500]);

    let rejectedPrCalls = 0;
    await expect(_internal.resolveAttribution('/repo', head, {
      FORGE_EVAL_ISSUE_ID: '11111111-1111-4111-8111-111111111111',
      FORGE_EVAL_PR: '500',
      FORGE_EVAL_PR_HEAD: head,
    }, {
      ...deps,
      prAdapter: { readState: async () => { rejectedPrCalls += 1; } },
    })).rejects.toThrow('attribution.issue_unavailable');
    expect(rejectedPrCalls).toBe(0);

    await expect(_internal.resolveAttribution('/repo', head, {
      FORGE_EVAL_ISSUE_ID: issueId,
      FORGE_EVAL_PR: '500',
      FORGE_EVAL_PR_HEAD: head,
    }, {
      ...deps,
      prAdapter: { readState: async () => ({ state: 'OPEN', headSha: 'b'.repeat(40) }) },
    })).rejects.toThrow('attribution.pr_mismatch');
  });

  test('builds exact zero-tool, effort-controlled production argv', () => {
    expect(_internal.buildRuntimeArgv({
      command: ['claude'], prompt: 'opaque prompt', model: 'model-one', effort: 'max',
    })).toEqual([
      'claude',
      '-p', 'opaque prompt',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--tools', '',
      '--model', 'model-one',
      '--effort', 'max',
    ]);
  });

  test('executes the existing stream-json command shape without persisting raw runtime output', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-behavioral-runtime-'));
    const runtimePath = path.join(root, 'runtime.js');
    try {
      fs.writeFileSync(runtimePath, [
        "const observation = JSON.parse(process.env.FORGE_TEST_OBSERVATION);",
        "const text = JSON.stringify(observation);",
        "console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text}],usage:{input_tokens:3,output_tokens:2,cache_read_input_tokens:1}}}));",
        "console.log(JSON.stringify({type:'result',result:text}));",
      ].join('\n'));
      const packet = loadTier(30).cases[0];
      const env = {
        FORGE_TEST_OBSERVATION: JSON.stringify(packet.oracle.expected),
        FORGE_EVAL_EFFORT: 'high',
      };
      const executor = _internal.createExecutor({
        projectRoot: root,
        skillName: 'dev',
        skillText: 'bounded contract',
        command: [process.execPath, runtimePath],
        budget: { timeoutMs: 10000, maxTokens: 8192 },
        skillHash: 'a'.repeat(64),
        env,
      });
      const binding = {
        repoSha: 'b'.repeat(40), configHash: 'c'.repeat(64), budgetHash: 'd'.repeat(64),
      };
      const result = await executor({
        armId: 'opaque-a', model: 'model-one', config: 'bounded', budget: 'tier-30',
        packet, trialIndex: 0, binding,
      });

      expect(result.evidence).toMatchObject({
        caseId: packet.caseId,
        observation: packet.oracle.expected,
        metrics: { tokensUsed: 5 },
      });
      expect(result.attribution).toMatchObject({
        model: 'model-one', effort: 'high', role: 'behavioral-eval',
        tokens: { input: 3, output: 2, cached: 1 },
      });
      expect(fs.readdirSync(root)).toEqual(['runtime.js']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when usage is missing or exceeds the applied post-run token budget', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-behavioral-budget-'));
    const runtimePath = path.join(root, 'runtime.js');
    try {
      fs.writeFileSync(runtimePath, [
        "const observation = JSON.parse(process.env.FORGE_TEST_OBSERVATION);",
        "const text = JSON.stringify(observation);",
        "if (process.env.FORGE_TEST_USAGE !== 'missing') console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text}],usage:{input_tokens:8,output_tokens:5}}}));",
        "console.log(JSON.stringify({type:'result',result:text}));",
      ].join('\n'));
      const packet = loadTier(30).cases[0];
      const base = {
        projectRoot: root,
        skillName: 'dev',
        skillText: 'bounded contract',
        command: [process.execPath, runtimePath],
        budget: { timeoutMs: 10000, maxTokens: 10 },
        skillHash: 'a'.repeat(64),
      };
      const input = {
        armId: 'opaque-a', model: 'model-one', config: 'bounded', budget: 'tier-30',
        packet, trialIndex: 0,
        binding: { repoSha: 'b'.repeat(40), configHash: 'c'.repeat(64), budgetHash: 'd'.repeat(64) },
      };
      const overBudget = _internal.createExecutor({
        ...base,
        effort: 'high',
        env: { FORGE_TEST_OBSERVATION: JSON.stringify(packet.oracle.expected) },
      });
      await expect(overBudget(input)).rejects.toThrow('runtime.token_budget_exceeded');

      const missingUsage = _internal.createExecutor({
        ...base,
        effort: 'high',
        env: {
          FORGE_TEST_OBSERVATION: JSON.stringify(packet.oracle.expected),
          FORGE_TEST_USAGE: 'missing',
        },
      });
      await expect(missingUsage(input)).rejects.toThrow('runtime.usage_unparseable');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
