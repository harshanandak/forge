'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSkillEvalFixture } = require('./skill-eval-fixture');

describe('createSkillEvalFixture', () => {
  test('creates an isolated behavioral fixture without Git process phases', () => {
    const helperSource = fs.readFileSync(require.resolve('./skill-eval-fixture'), 'utf8');
    expect(helperSource).not.toMatch(/node:child_process|execFileSync|spawnSync|\bbun\b/i);

    const fixture = createSkillEvalFixture();
    const repositoryRoot = path.resolve(__dirname, '../..');
    try {
      expect(fixture.root).not.toBe(repositoryRoot);
      expect(path.relative(os.tmpdir(), fixture.root)).not.toStartWith('..');
      expect(fixture.gitCommonDir).toBe(path.join(fixture.root, '.git'));
      expect(fs.statSync(fixture.gitCommonDir).isDirectory()).toBe(true);
      expect(fixture.kernelDatabasePath).toBe(path.join(fixture.gitCommonDir, 'forge', 'kernel.sqlite'));
      expect(fs.existsSync(fixture.kernelDatabasePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, 'skills', fixture.skillName, 'SKILL.md'))).toBe(true);
      expect(fixture.phases.gitInit).toBeUndefined();
      expect(fixture.phases.gitCommit).toBeUndefined();
      expect(fixture.setupMs).toBeGreaterThanOrEqual(0);
    } finally {
      fixture.cleanup();
    }
    expect(fs.existsSync(fixture.root)).toBe(false);
  });
});
