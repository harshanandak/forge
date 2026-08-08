'use strict';

const { describe, expect, test } = require('bun:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FORGE_BIN = path.resolve(__dirname, '../../bin/forge.js');

describe('forge skill eval behavioral CLI', () => {
  test('real node subprocess rejects a nonexistent issue before runtime or fake PR attribution', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skill-eval-cli-'));
    try {
      fs.mkdirSync(path.join(root, 'skills', 'demo'), { recursive: true });
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '# test\n');
      fs.writeFileSync(
        path.join(root, 'skills', 'demo', 'SKILL.md'),
        '---\nname: demo\ndescription: behavioral demo\n---\nbody\n',
      );
      for (const args of [
        ['init', '-q'],
        ['config', 'user.email', 'eval@example.test'],
        ['config', 'user.name', 'Eval Test'],
        ['add', '.'],
        ['commit', '-qm', 'fixture'],
      ]) {
        const git = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        expect(git.status).toBe(0);
      }
      const result = spawnSync(process.execPath, [
        FORGE_BIN, 'skill', 'eval', 'demo', '--full', '--tier', '30', '--json',
      ], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          FORGE_EVAL_RUNTIME: 'forge-eval-runtime-does-not-exist',
          FORGE_EVAL_MODELS: 'model-one,model-two',
          FORGE_EVAL_ISSUE_ID: '11111111-1111-4111-8111-111111111111',
          FORGE_EVAL_PR: '500',
          FORGE_EVAL_PR_HEAD: 'a'.repeat(40),
        },
      });

      expect(result.status).toBe(1);
      const output = JSON.parse(result.stdout);
      expect(output.status).toBe('INCOMPLETE');
      expect(output.findings[0].failures).toEqual(['attribution.issue_unavailable']);
      expect(output.arms).toHaveLength(0);
      expect(output.issueId).toBeUndefined();
      expect(output.pr).toBeUndefined();
      expect(result.stderr).not.toContain('arms.invalid');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
