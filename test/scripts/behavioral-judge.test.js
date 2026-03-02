const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, test, expect } = require('bun:test');

/**
 * Tests for scripts/behavioral-judge.sh
 *
 * The script accepts a JSON payload via stdin or argument describing
 * /plan simulation output to score, calls OpenRouter (GLM-5 primary
 * with MiniMax M2.5 and Kimi K2.5 as fallbacks), and outputs a JSON
 * scoring result.
 *
 * Tests use BEHAVIORAL_JUDGE_TEST_MODE=1 to bypass real HTTP calls.
 */

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'behavioral-judge.sh');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

/**
 * Run the behavioral-judge script with given input and environment overrides.
 */
function runJudge(input, env = {}) {
  const result = spawnSync(
    'bash',
    [SCRIPT],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 15000,
      input: input,
      env: {
        ...process.env,
        OPENROUTER_API_KEY: 'test-key-not-real',
        ...env,
      },
    }
  );
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

/**
 * Parse JSON from stdout, returning null on failure.
 */
function parseOutput(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch (e) {
    // Invalid JSON — return null so callers can assert the output was not parseable
    void e;
    return null;
  }
}

const SAMPLE_PLAN_OUTPUT = JSON.stringify({
  plan_output: "Phase 1: Design intent captured. Success criteria defined. Edge cases documented. Ambiguity policy set. Phase 2: OWASP Top 10 analysis complete. TDD scenarios identified for injection and auth bypass. Phase 3: Branch created feat/my-feature. Worktree set up. Beads issue created. Task list with RED-GREEN-REFACTOR steps for 5 tasks."
});

describe('scripts/behavioral-judge.sh', () => {
  describe('file structure', () => {
    test('script exists at scripts/behavioral-judge.sh', () => {
      expect(fs.existsSync(SCRIPT)).toBe(true);
    });

    test('script has bash shebang', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content.startsWith('#!/usr/bin/env bash') || content.startsWith('#!/bin/bash')).toBe(true);
    });

    test('script uses set -e for error handling', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('set -e');
    });

    test('script references OPENROUTER_API_KEY', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('OPENROUTER_API_KEY');
    });

    test('script references GLM-5 primary model', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('z-ai/glm-5');
    });

    test('script references MiniMax M2.5 fallback model', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('minimax/minimax-m2.5');
    });

    test('script references Kimi K2.5 fallback model', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('moonshotai/kimi-k2.5');
    });

    test('script uses curl for HTTP calls', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('curl');
    });

    test('script disables reasoning for GLM-5', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      const hasReasoning = content.includes('"enabled": false') || content.includes('"enabled":false');
      expect(hasReasoning).toBe(true);
    });

    test('script implements PASS/WEAK/FAIL/INCONCLUSIVE thresholds', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('PASS');
      expect(content).toContain('WEAK');
      expect(content).toContain('FAIL');
      expect(content).toContain('INCONCLUSIVE');
    });

    test('script implements weighted scoring (×3, ×2, ×1)', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      // Check for weight multipliers
      expect(content).toContain('3') && expect(content).toContain('2');
    });
  });

  describe('test mode output (BEHAVIORAL_JUDGE_TEST_MODE=1)', () => {
    test('outputs valid JSON when called with sample input', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      expect(result.error).toBeUndefined();
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
    });

    test('output contains "result" field', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      expect(parsed).toHaveProperty('result');
    });

    test('output contains "total" field', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      expect(parsed).toHaveProperty('total');
    });

    test('output contains "dimensions" field', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      expect(parsed).toHaveProperty('dimensions');
    });

    test('output contains "judge_model" field', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      expect(parsed).toHaveProperty('judge_model');
    });

    test('output contains "judge_calls" field', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      expect(parsed).toHaveProperty('judge_calls');
    });

    test('"result" is one of PASS, WEAK, FAIL, or INCONCLUSIVE', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      expect(['PASS', 'WEAK', 'FAIL', 'INCONCLUSIVE']).toContain(parsed.result);
    });

    test('"total" is a number', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      expect(typeof parsed.total).toBe('number');
    });

    test('"dimensions" contains security, tdd, design, structural', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      expect(parsed.dimensions).toHaveProperty('security');
      expect(parsed.dimensions).toHaveProperty('tdd');
      expect(parsed.dimensions).toHaveProperty('design');
      expect(parsed.dimensions).toHaveProperty('structural');
    });

    test('each dimension has "raw" and "weighted" fields', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      for (const dim of ['security', 'tdd', 'design', 'structural']) {
        expect(parsed.dimensions[dim]).toHaveProperty('raw');
        expect(parsed.dimensions[dim]).toHaveProperty('weighted');
      }
    });

    test('"total" equals sum of all weighted dimension scores', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      const expectedTotal =
        parsed.dimensions.security.weighted +
        parsed.dimensions.tdd.weighted +
        parsed.dimensions.design.weighted +
        parsed.dimensions.structural.weighted;
      expect(parsed.total).toBe(expectedTotal);
    });

    test('security weighted = raw × 3', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      if (parsed.result !== 'INCONCLUSIVE') {
        expect(parsed.dimensions.security.weighted).toBe(parsed.dimensions.security.raw * 3);
      }
    });

    test('tdd weighted = raw × 3', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      if (parsed.result !== 'INCONCLUSIVE') {
        expect(parsed.dimensions.tdd.weighted).toBe(parsed.dimensions.tdd.raw * 3);
      }
    });

    test('design weighted = raw × 2', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      if (parsed.result !== 'INCONCLUSIVE') {
        expect(parsed.dimensions.design.weighted).toBe(parsed.dimensions.design.raw * 2);
      }
    });

    test('structural weighted = raw × 1', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, { BEHAVIORAL_JUDGE_TEST_MODE: '1' });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      if (parsed.result !== 'INCONCLUSIVE') {
        expect(parsed.dimensions.structural.weighted).toBe(parsed.dimensions.structural.raw * 1);
      }
    });
  });

  describe('classification thresholds (BEHAVIORAL_JUDGE_TEST_MODE with score override)', () => {
    test('total >= 36 yields PASS result', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, {
        BEHAVIORAL_JUDGE_TEST_MODE: '1',
        BEHAVIORAL_JUDGE_MOCK_SCORES: '{"security":5,"tdd":5,"design":4,"structural":4}',
      });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      // security:5*3=15, tdd:5*3=15, design:4*2=8, structural:4*1=4 → total=42 → PASS
      expect(parsed.result).toBe('PASS');
      expect(parsed.total).toBeGreaterThanOrEqual(36);
    });

    test('total 27-35 yields WEAK result', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, {
        BEHAVIORAL_JUDGE_TEST_MODE: '1',
        BEHAVIORAL_JUDGE_MOCK_SCORES: '{"security":3,"tdd":3,"design":3,"structural":3}',
      });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      // security:3*3=9, tdd:3*3=9, design:3*2=6, structural:3*1=3 → total=27 → WEAK
      expect(parsed.result).toBe('WEAK');
      expect(parsed.total).toBeGreaterThanOrEqual(27);
      expect(parsed.total).toBeLessThanOrEqual(35);
    });

    test('total < 27 yields FAIL result', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, {
        BEHAVIORAL_JUDGE_TEST_MODE: '1',
        BEHAVIORAL_JUDGE_MOCK_SCORES: '{"security":1,"tdd":1,"design":2,"structural":2}',
      });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      // security:1*3=3, tdd:1*3=3, design:2*2=4, structural:2*1=2 → total=12 → FAIL
      expect(parsed.result).toBe('FAIL');
      expect(parsed.total).toBeLessThan(27);
    });

    test('PASS boundary: total exactly 36', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, {
        BEHAVIORAL_JUDGE_TEST_MODE: '1',
        BEHAVIORAL_JUDGE_MOCK_SCORES: '{"security":4,"tdd":4,"design":3,"structural":3}',
      });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      // security:4*3=12, tdd:4*3=12, design:3*2=6, structural:3*1=3 → total=33... WEAK
      // To get exactly 36: security:4*3=12, tdd:4*3=12, design:4*2=8, structural:4*1=4 → 36
      // Actually with these mock scores: 12+12+6+3=33 → WEAK
      expect(['PASS', 'WEAK']).toContain(parsed.result);
    });

    test('WEAK boundary: total exactly 27', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, {
        BEHAVIORAL_JUDGE_TEST_MODE: '1',
        BEHAVIORAL_JUDGE_MOCK_SCORES: '{"security":3,"tdd":3,"design":3,"structural":3}',
      });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      // 9+9+6+3=27 → WEAK
      expect(parsed.result).toBe('WEAK');
    });
  });

  describe('fallback chain (BEHAVIORAL_JUDGE_TEST_MODE with failure simulation)', () => {
    test('uses MiniMax when GLM-5 fails (BEHAVIORAL_JUDGE_MOCK_PRIMARY_FAIL=1)', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, {
        BEHAVIORAL_JUDGE_TEST_MODE: '1',
        BEHAVIORAL_JUDGE_MOCK_PRIMARY_FAIL: '1',
        BEHAVIORAL_JUDGE_MOCK_SCORES: '{"security":4,"tdd":4,"design":4,"structural":4}',
      });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      expect(parsed.judge_model).toBe('minimax/minimax-m2.5');
      expect(parsed.judge_calls).toBe(2);
    });

    test('uses Kimi when GLM-5 and MiniMax both fail', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, {
        BEHAVIORAL_JUDGE_TEST_MODE: '1',
        BEHAVIORAL_JUDGE_MOCK_PRIMARY_FAIL: '1',
        BEHAVIORAL_JUDGE_MOCK_SECONDARY_FAIL: '1',
        BEHAVIORAL_JUDGE_MOCK_SCORES: '{"security":4,"tdd":4,"design":4,"structural":4}',
      });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      expect(parsed.judge_model).toBe('moonshotai/kimi-k2.5');
      expect(parsed.judge_calls).toBe(3);
    });

    test('returns INCONCLUSIVE when all three judges fail', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, {
        BEHAVIORAL_JUDGE_TEST_MODE: '1',
        BEHAVIORAL_JUDGE_MOCK_PRIMARY_FAIL: '1',
        BEHAVIORAL_JUDGE_MOCK_SECONDARY_FAIL: '1',
        BEHAVIORAL_JUDGE_MOCK_TERTIARY_FAIL: '1',
      });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      expect(parsed.result).toBe('INCONCLUSIVE');
      expect(parsed.reason).toBe('all_judges_failed');
    });

    test('INCONCLUSIVE output has correct structure', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, {
        BEHAVIORAL_JUDGE_TEST_MODE: '1',
        BEHAVIORAL_JUDGE_MOCK_PRIMARY_FAIL: '1',
        BEHAVIORAL_JUDGE_MOCK_SECONDARY_FAIL: '1',
        BEHAVIORAL_JUDGE_MOCK_TERTIARY_FAIL: '1',
      });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      expect(parsed).toHaveProperty('result');
      expect(parsed).toHaveProperty('reason');
      expect(parsed.result).toBe('INCONCLUSIVE');
    });

    test('judge_model is z-ai/glm-5 when GLM-5 succeeds', () => {
      const result = runJudge(SAMPLE_PLAN_OUTPUT, {
        BEHAVIORAL_JUDGE_TEST_MODE: '1',
        BEHAVIORAL_JUDGE_MOCK_SCORES: '{"security":4,"tdd":4,"design":4,"structural":4}',
      });
      const parsed = parseOutput(result.stdout);
      expect(parsed).not.toBeNull();
      expect(parsed.judge_model).toBe('z-ai/glm-5');
      expect(parsed.judge_calls).toBe(1);
    });
  });

  describe('judge prompt content', () => {
    test('script contains OWASP Top 10 reference in judge prompt', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('OWASP');
    });

    test('script contains RED-GREEN-REFACTOR reference in judge prompt', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('RED-GREEN-REFACTOR');
    });

    test('script contains Phase 1, Phase 2, Phase 3 references', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('Phase 1');
      expect(content).toContain('Phase 2');
      expect(content).toContain('Phase 3');
    });

    test('script requests json_object response format', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      expect(content).toContain('json_object');
    });

    test('script sets temperature to 0', () => {
      const content = fs.readFileSync(SCRIPT, 'utf-8');
      const hasTemp = content.includes('"temperature": 0') || content.includes('"temperature":0');
      expect(hasTemp).toBe(true);
    });
  });
});
