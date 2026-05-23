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
      const codexSkill = path.join(root, '.codex', 'skills', 'guard-rails-audit', 'SKILL.md');

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

  test('reports explicit slash invocation for the canonical skill across all harnesses', () => {
    const result = runParity({ cleanup: true });

    expect(result.harnesses.map((harness) => [harness.harness, harness.explicitInvocation])).toEqual([
      ['claude-code', '/guard-rails-audit'],
      ['cursor', '/guard-rails-audit'],
      ['codex-cli', '/guard-rails-audit'],
    ]);
  });

  test('refuses to materialize into a non-empty fixture directory', () => {
    const root = makeTempDir();
    try {
      fs.writeFileSync(path.join(root, 'keep.txt'), 'do not delete\n');

      expect(() => materializeFixture(root)).toThrow('fixture directory must be empty');
      expect(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8')).toBe('do not delete\n');
    } finally {
      cleanup(root);
    }
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
    expect(codex.target).toBe('.codex/skills/guard-rails-audit/SKILL.md');
    expect(codex.target).not.toContain('prompt');
    expect(codex.target).not.toContain('slash');
  });

  test('reports source labels and proof boundary for machine-readable evidence', () => {
    const result = runParity({ cleanup: true });

    expect(result.proofBoundary).toEqual({
      level: 'metadata-surface',
      liveAgentInvocation: 'not-run',
      codexRuntimeDiscovery: 'not-run',
      reason: 'closed-source harness model invocation is outside this deterministic fixture; .codex/skills is the Forge repository packaging surface, not proof of direct Codex runtime discovery',
    });
    expect(result.harnesses.map((harness) => [harness.harness, harness.sourceLabel])).toEqual([
      ['claude-code', 'S1'],
      ['cursor', 'S2'],
      ['codex-cli', 'S4'],
    ]);
    expect(result.sources.map((source) => source.label)).toEqual(['S1', 'S2', 'S3', 'S4']);
  });

  test('committed evidence resolves every harness source label', () => {
    const evidence = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'work', '2026-05-23-cross-harness-skill-parity', 'evidence.json'),
      'utf8',
    ));
    const sourceLabels = new Set(evidence.sources.map((source) => source.label));

    expect(evidence.harnesses.every((harness) => sourceLabels.has(harness.sourceLabel))).toBe(true);
    expect(evidence.proofBoundary.codexRuntimeDiscovery).toBe('not-run');
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
    expect(parsed.harnesses.every((harness) => harness.explicitInvocation === '/guard-rails-audit')).toBe(true);
    expect(parsed.harnesses.every((harness) => typeof harness.sourceLabel === 'string')).toBe(true);
    expect(parsed.proofBoundary.level).toBe('metadata-surface');
  });

  test('CLI ignores missing string flag values instead of consuming the next flag', () => {
    const accidentalFixture = path.join(__dirname, '..', '--json');
    fs.rmSync(accidentalFixture, { recursive: true, force: true });

    const result = spawnSync(process.execPath, ['scripts/spikes/skill-auto-invoke-parity.js', '--fixture-dir', '--json'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).passed).toBe(true);
    expect(fs.existsSync(accidentalFixture)).toBe(false);
  });
});
