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
});
