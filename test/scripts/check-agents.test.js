const { describe, test, expect, afterEach } = require('bun:test');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Tests for scripts/check-agents.js (skills-only surface).
 *
 * The module exports:
 * - checkAgents(repoRoot) -> { errors: string[], warnings: string[] }
 *
 * check-agents now validates: (1) skill drift between canonical skills/ and the
 * generated agent mirrors (.codex/skills), and (2) plugin.json schema/parity.
 * The old .claude/commands sync-drift surface was removed in PR-A0.
 */

const { checkAgents } = require('../../scripts/check-agents.js');
const { populateAgentSkills } = require('../../lib/skills-sync.js');

const tmpDirs = [];

function defaultPlugin() {
  return {
    id: 'codex',
    name: 'Codex',
    version: '1.0.0',
    capabilities: { skills: true },
    directories: { skills: '.codex/skills' },
  };
}

/**
 * Create a temp repo with canonical skills/, generated .codex/skills mirror,
 * and lib/agents/*.plugin.json files.
 */
function createTempRepo({ skills = { plan: 'plan body\n' }, plugins, populate = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-check-agents-'));
  tmpDirs.push(tmpDir);

  for (const [name, body] of Object.entries(skills)) {
    const dir = path.join(tmpDir, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
  }

  const agentsDir = path.join(tmpDir, 'lib', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const pluginList = plugins || [defaultPlugin()];
  for (const p of pluginList) {
    fs.writeFileSync(path.join(agentsDir, `${p.id || 'x'}.plugin.json`), JSON.stringify(p), 'utf8');
  }

  if (populate) {
    populateAgentSkills({ sourceRoot: tmpDir, targetSkillsDir: path.join(tmpDir, '.codex', 'skills') });
  }
  return tmpDir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (_e) {
      /* best effort */
    }
  }
});

describe('checkAgents — happy path', () => {
  test('returns no errors when skills are in sync and plugins are valid', () => {
    const tmpDir = createTempRepo();
    const result = checkAgents(tmpDir);
    expect(result.errors).toHaveLength(0);
  });

  test('returns correct shape with current repo root', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const result = checkAgents(repoRoot);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

describe('checkAgents — skill drift', () => {
  test('reports error when a mirrored skill file is modified', () => {
    const tmpDir = createTempRepo();
    fs.writeFileSync(path.join(tmpDir, '.codex', 'skills', 'plan', 'SKILL.md'), 'tampered', 'utf8');
    const result = checkAgents(tmpDir);
    expect(result.errors.some((e) => e.includes('Out of sync') && e.includes('plan'))).toBe(true);
  });

  test('reports stale mirror dir with no canonical source', () => {
    const tmpDir = createTempRepo();
    fs.mkdirSync(path.join(tmpDir, '.codex', 'skills', 'ghost'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.codex', 'skills', 'ghost', 'SKILL.md'), 'x', 'utf8');
    const result = checkAgents(tmpDir);
    expect(result.errors.some((e) => e.includes('Out of sync') && e.includes('stale'))).toBe(true);
  });

  test('reports missing canonical skill in the mirror', () => {
    const tmpDir = createTempRepo({ skills: { plan: 'p\n', dev: 'd\n' } });
    fs.rmSync(path.join(tmpDir, '.codex', 'skills', 'dev'), { recursive: true, force: true });
    const result = checkAgents(tmpDir);
    expect(result.errors.some((e) => e.includes('Out of sync') && e.includes('dev'))).toBe(true);
  });

  test('warns (no error) when no agent skill dirs exist yet', () => {
    const tmpDir = createTempRepo({ populate: false });
    const result = checkAgents(tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('skipped'))).toBe(true);
  });

  test('errors when no canonical skills/ exist', () => {
    const tmpDir = createTempRepo({ skills: {}, populate: false });
    const result = checkAgents(tmpDir);
    expect(result.errors.some((e) => e.includes('No canonical skills'))).toBe(true);
  });
});

describe('checkAgents — plugin catalog', () => {
  test('reports error when plugin support metadata is invalid', () => {
    const tmpDir = createTempRepo({
      plugins: [{
        id: 'codex',
        name: 'Codex',
        version: '1.0.0',
        capabilities: { skills: true },
        directories: { skills: '.codex/skills' },
        support: { status: 'bogus-tier' },
      }],
    });
    const result = checkAgents(tmpDir);
    expect(result.errors.some((e) => e.includes('support.status'))).toBe(true);
  });

  test('reports error when rules capability has no scaffold path', () => {
    const tmpDir = createTempRepo({
      plugins: [{
        id: 'codex',
        name: 'Codex',
        version: '1.0.0',
        capabilities: { rules: true },
        directories: { skills: '.codex/skills' },
      }],
    });
    const result = checkAgents(tmpDir);
    expect(result.errors.some((e) => e.includes('rules'))).toBe(true);
  });

  test('reports error when skills capability has no scaffold path', () => {
    const tmpDir = createTempRepo({
      plugins: [{
        id: 'codex',
        name: 'Codex',
        version: '1.0.0',
        capabilities: { skills: true },
        directories: { rules: '.codex/rules' },
      }],
    });
    const result = checkAgents(tmpDir);
    expect(result.errors.some((e) => e.includes('skills'))).toBe(true);
  });

  test('reports error when deprecated plugin still claims skill parity', () => {
    const tmpDir = createTempRepo({
      plugins: [{
        id: 'legacy',
        name: 'Legacy',
        version: '1.0.0',
        capabilities: { skills: true },
        directories: { skills: '.legacy/skills' },
        support: { status: 'deprecated' },
      }],
    });
    const result = checkAgents(tmpDir);
    expect(result.errors.some((e) => e.includes('deprecated') && e.includes('skills'))).toBe(true);
  });

  test('accepts a valid skills-only plugin', () => {
    const tmpDir = createTempRepo({
      plugins: [{
        id: 'codex',
        name: 'Codex',
        version: '1.0.0',
        capabilities: { skills: true },
        directories: { skills: '.codex/skills' },
      }],
    });
    const result = checkAgents(tmpDir);
    expect(result.errors).toHaveLength(0);
  });
});
