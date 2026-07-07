'use strict';

const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { renderHookConfig } = require('../lib/hook-renderer');
const setup = require('../lib/commands/setup');

// Native hook configs are AUTO-WIRED by `forge setup` (mirrors the MCP renderer):
// Forge writes .claude/settings.json (hooks block) and .cursor/hooks.json,
// projecting its TDD-gate + protected-path enforcement onto native surfaces while
// preserving any existing user hooks and backing up unparseable configs.

const created = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hooks-'));
  created.push(d);
  return d;
}
afterEach(() => {
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
});

describe('renderHookConfig on disk (read -> merge -> write, data-loss safe)', () => {
  test('claude: fresh project writes .claude/settings.json with a Forge hooks block', () => {
    const root = tmp();
    const res = renderHookConfig({ harness: 'claude', targetRoot: root });
    expect(res.wrote).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf-8'));
    const cmds = cfg.hooks.PreToolUse.flatMap(g => g.hooks.map(h => h.command));
    expect(cmds.some(c => c.includes('forge-native-hook.js'))).toBe(true);
  });

  test('cursor: fresh project writes .cursor/hooks.json (version 1)', () => {
    const root = tmp();
    renderHookConfig({ harness: 'cursor', targetRoot: root });
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf-8'));
    expect(cfg.version).toBe(1);
    expect(cfg.hooks.beforeShellExecution.length).toBeGreaterThan(0);
  });

  test('claude: existing settings.json is MERGED, preserving user keys and hooks', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet', hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'node u.js' }] }] } }, null, 2),
    );
    renderHookConfig({ harness: 'claude', targetRoot: root });
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf-8'));
    expect(cfg.model).toBe('sonnet'); // unrelated key preserved
    const cmds = cfg.hooks.PreToolUse.flatMap(g => g.hooks.map(h => h.command));
    expect(cmds).toContain('node u.js');                             // user hook preserved
    expect(cmds.some(c => c.includes('forge-native-hook.js'))).toBe(true);
  });

  test('malformed config is NOT clobbered — backed up and left untouched', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    const original = '{\n  // jsonc\n  "version": 1,\n}\n';
    fs.writeFileSync(path.join(root, '.cursor', 'hooks.json'), original);
    const res = renderHookConfig({ harness: 'cursor', targetRoot: root });
    expect(res.skipped).toBe(true);
    expect(res.wrote).toBe(false);
    expect(fs.readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf-8')).toBe(original);
    expect(fs.existsSync(path.join(root, '.cursor', 'hooks.json.bak'))).toBe(true);
  });

  test('codex is global-config scope — NOTHING is written at project setup', () => {
    const root = tmp();
    const res = renderHookConfig({ harness: 'codex', targetRoot: root });
    expect(res.scope).toBe('global-config');
    expect(res.wrote).toBe(false);
    expect(fs.existsSync(path.join(root, '.codex', 'config.toml'))).toBe(false);
  });
});

describe('setup wiring (mirrors setupClaudeMcpConfig / setupCursorMcpConfig)', () => {
  test('setupClaudeHooksConfig writes the .claude/settings.json hooks block', () => {
    const root = tmp();
    setup._setState({ projectRoot: root });
    setup.setupClaudeHooksConfig();
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf-8'));
    expect(cfg.hooks.PreToolUse.length).toBeGreaterThan(0);
  });

  test('setupCursorHooksConfig writes .cursor/hooks.json and preserves user hooks', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.cursor', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: { beforeReadFile: [{ command: 'node s.js' }] } }, null, 2),
    );
    setup._setState({ projectRoot: root });
    setup.setupCursorHooksConfig();
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf-8'));
    expect(cfg.hooks.beforeReadFile[0].command).toBe('node s.js'); // preserved
    expect(cfg.hooks.beforeShellExecution.length).toBeGreaterThan(0);
  });
});
