const fs = require('node:fs');
const path = require('node:path');
const { describe, expect, test } = require('bun:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const pluginRoot = path.join(repoRoot, 'plugin');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('plugin manifest', () => {
  const manifest = readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));

  test('lives at <plugin-root>/.claude-plugin/plugin.json (Claude Code format)', () => {
    expect(fs.existsSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  test('declares the required name/version/description (matches superpowers/beads shape)', () => {
    expect(manifest.name).toBe('forge');
    expect(typeof manifest.version).toBe('string');
    expect(manifest.version.length).toBeGreaterThan(0);
    expect(typeof manifest.description).toBe('string');
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  test('carries exactly one new skill: activation (does NOT repackage canonical skills)', () => {
    const skillsDir = path.join(pluginRoot, 'skills');
    const entries = fs.readdirSync(skillsDir).filter(e =>
      fs.statSync(path.join(skillsDir, e)).isDirectory());
    expect(entries).toEqual(['activation']);
  });
});

describe('activation skill', () => {
  const skillPath = path.join(pluginRoot, 'skills', 'activation', 'SKILL.md');
  const body = fs.readFileSync(skillPath, 'utf8');

  test('has YAML frontmatter with name + description (the whole trigger surface)', () => {
    const fm = body.match(/^---\n([\s\S]*?)\n---/);
    expect(fm).not.toBeNull();
    expect(fm[1]).toContain('name: activation');
    expect(fm[1]).toContain('description:');
  });

  test('is orient-first and offers without forcing', () => {
    expect(body).toContain('Orient first');
    expect(body.toLowerCase()).toContain('never force');
  });

  test('declares a terminal state + next step', () => {
    expect(body).toContain('Terminal state');
    expect(body).toContain('/plan');
  });
});

describe('SessionStart hook (read-only, Windows-safe)', () => {
  const hooks = readJson(path.join(pluginRoot, 'hooks', 'hooks.json'));

  test('wires SessionStart through the quoted run-hook.cmd wrapper', () => {
    const entry = hooks.hooks.SessionStart[0].hooks[0];
    expect(entry.type).toBe('command');
    expect(entry.command).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(entry.command).toContain('run-hook.cmd');
    // Quoted because install paths contain spaces (C:\Users\...\.claude\...).
    expect(entry.command).toContain('"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd"');
  });

  test('ships the run-hook.cmd wrapper and the session-start script', () => {
    expect(fs.existsSync(path.join(pluginRoot, 'hooks', 'run-hook.cmd'))).toBe(true);
    expect(fs.existsSync(path.join(pluginRoot, 'hooks', 'session-start'))).toBe(true);
  });

  test('the session-start script creates nothing (no writes/mkdir/init)', () => {
    const script = fs.readFileSync(path.join(pluginRoot, 'hooks', 'session-start'), 'utf8');
    expect(script).not.toMatch(/\bmkdir\b/);
    expect(script).not.toMatch(/>\s*\.forge/);
    expect(script).not.toMatch(/forge (init|setup)/);
  });
});

describe('self-marketplace', () => {
  const marketplace = readJson(path.join(repoRoot, '.claude-plugin', 'marketplace.json'));

  test('points the forge plugin source at the ./plugin subtree that actually exists', () => {
    const entry = marketplace.plugins.find(p => p.name === 'forge');
    expect(entry).toBeDefined();
    expect(entry.source).toBe('./plugin');
    const resolved = path.join(repoRoot, entry.source, '.claude-plugin', 'plugin.json');
    expect(fs.existsSync(resolved)).toBe(true);
  });
});
