const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  CANONICAL_SKILL,
  descriptionMatches,
  materializeFixture,
  runParity,
} = require('../scripts/spikes/skill-auto-invoke-parity');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-w0-parity-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('W0 cross-harness skill auto-invoke parity fixture', () => {
  test('materializes the same skill description to Claude, Cursor, and Codex target surfaces', () => {
    const root = makeTempDir();
    try {
      materializeFixture(root);

      const claudeSkill = path.join(root, '.claude', 'skills', 'guard-rails-audit', 'SKILL.md');
      const cursorRule = path.join(root, '.cursor', 'rules', 'guard-rails-audit.mdc');
      const codexSkill = path.join(root, '.agents', 'skills', 'guard-rails-audit', 'SKILL.md');

      expect(fs.existsSync(claudeSkill)).toBe(true);
      expect(fs.existsSync(cursorRule)).toBe(true);
      expect(fs.existsSync(codexSkill)).toBe(true);

      for (const filePath of [claudeSkill, cursorRule, codexSkill]) {
        expect(fs.readFileSync(filePath, 'utf8')).toContain(CANONICAL_SKILL.description);
      }
    } finally {
      cleanup(root);
    }
  });

  test('matches the positive prompt and rejects unrelated prompts consistently', () => {
    const result = runParity({ cleanup: true });

    expect(result.passed).toBe(true);
    expect(result.knownIssues).toEqual([]);
    expect(result.harnesses.map((harness) => [harness.harness, harness.passed])).toEqual([
      ['claude-code', true],
      ['cursor', true],
      ['codex-cli', true],
    ]);
  });

  test('uses Cursor rule metadata and Codex Agent Skills without undocumented slash prompt files', () => {
    const result = runParity({ cleanup: true });
    const cursor = result.harnesses.find((harness) => harness.harness === 'cursor');
    const codex = result.harnesses.find((harness) => harness.harness === 'codex-cli');

    expect(cursor.frontmatter).toEqual({
      description: CANONICAL_SKILL.description,
      globs: null,
      alwaysApply: false,
    });
    expect(codex.target).toBe('.agents/skills/guard-rails-audit/SKILL.md');
    expect(codex.target).not.toContain('prompt');
    expect(codex.target).not.toContain('slash');
    expect(codex.target).not.toContain('.codex');
  });

  test('description matcher has a positive and negative control', () => {
    expect(descriptionMatches(CANONICAL_SKILL.description, 'Check audit events for protected path policy.')).toBe(true);
    expect(descriptionMatches(CANONICAL_SKILL.description, 'Format a changelog entry.')).toBe(false);
  });

  test('CLI reports pass/fail per harness as JSON', () => {
    const result = spawnSync(process.execPath, ['scripts/spikes/skill-auto-invoke-parity.js', '--json'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.passed).toBe(true);
    expect(parsed.harnesses.map((harness) => harness.harness)).toEqual(['claude-code', 'cursor', 'codex-cli']);
    expect(parsed.harnesses.every((harness) => harness.passed)).toBe(true);
  });
});
