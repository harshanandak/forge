'use strict';

const { describe, expect, test } = require('bun:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const {
  createSkillEvalFixture,
  formatPhaseDiagnostics,
} = require('../helpers/skill-eval-fixture');

const FORGE_BIN = path.resolve(__dirname, '../../bin/forge.js');

describe('forge skill eval behavioral CLI', () => {
  test('real node subprocess rejects a nonexistent issue before runtime or fake PR attribution', () => {
    let fixture;
    const phases = {};
    try {
      fixture = createSkillEvalFixture();
      Object.assign(phases, fixture.phases);
      const root = fixture.root;
      const started = performance.now();
      const result = spawnSync(process.execPath, [
        FORGE_BIN, 'skill', 'eval', 'demo', '--full', '--tier', '30', '--json',
      ], {
        cwd: root,
        encoding: 'utf8',
        timeout: 20000,
        env: {
          ...process.env,
          FORGE_EVAL_RUNTIME: 'forge-eval-runtime-does-not-exist',
          FORGE_EVAL_MODELS: 'model-one,model-two',
          FORGE_EVAL_ISSUE_ID: '11111111-1111-4111-8111-111111111111',
          FORGE_EVAL_PR: '500',
          FORGE_EVAL_PR_HEAD: 'a'.repeat(40),
        },
      });
      phases.cli = {
        phase: 'cli',
        elapsedMs: Math.round(performance.now() - started),
        status: result.status === null ? 'null' : result.status,
        signal: result.signal || 'none',
        error: result.error?.message,
      };
      if (result.status === null) {
        throw new Error('skill-eval CLI did not exit cleanly');
      }

      expect(result.status).toBe(1);
      const output = JSON.parse(result.stdout);
      expect(output.status).toBe('INCOMPLETE');
      expect(output.findings[0].failures).toEqual(['attribution.issue_unavailable']);
      expect(output.arms).toHaveLength(0);
      expect(output.issueId).toBeUndefined();
      expect(output.pr).toBeUndefined();
      expect(result.stderr).not.toContain('arms.invalid');
    } catch (error) {
      const diagnostics = formatPhaseDiagnostics(phases);
      throw new Error(`${error.message}${diagnostics ? ` [${diagnostics}]` : ''}`);
    } finally {
      fixture?.cleanup();
    }
  }, 30000);
});
