'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FORGE_HOOK_CONTRACT, HookConfigParseError } = require('../lib/hook-renderer');
const {
  GLOBAL_HOOK_HARNESSES,
  resolveGlobalHookFile,
  mergeCodexGlobalConfigToml,
  mergeHermesGlobalConfigYaml,
  installGlobalHooks,
} = require('../lib/hook-global-installer');

// The opt-in global-config install path for the two harnesses whose native hook
// surface lives in HOME-dir config (Codex → $CODEX_HOME/config.toml, Hermes →
// ~/.hermes/config.yaml). Project `forge setup` intentionally never writes global
// config; `forge hooks install --global` is the consent-guarded delivery path
// (kernel issue 66dd5a1f, epic 90f2f631).

const FORGE_MARK = 'forge-native-hook.js';

let tmpHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-global-hooks-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('resolveGlobalHookFile', () => {
  test('codex resolves to $CODEX_HOME/config.toml when CODEX_HOME is set', () => {
    const file = resolveGlobalHookFile('codex', { env: { CODEX_HOME: tmpHome }, homeDir: '/elsewhere' });
    expect(file).toBe(path.join(path.resolve(tmpHome), 'config.toml'));
  });

  test('codex defaults to ~/.codex/config.toml', () => {
    const file = resolveGlobalHookFile('codex', { env: {}, homeDir: tmpHome });
    expect(file).toBe(path.join(tmpHome, '.codex', 'config.toml'));
  });

  test('hermes resolves to ~/.hermes/config.yaml', () => {
    const file = resolveGlobalHookFile('hermes', { env: {}, homeDir: tmpHome });
    expect(file).toBe(path.join(tmpHome, '.hermes', 'config.yaml'));
  });

  test('rejects harnesses without a global hook surface', () => {
    expect(() => resolveGlobalHookFile('claude', { homeDir: tmpHome })).toThrow(/global hook/i);
  });
});

describe('mergeCodexGlobalConfigToml (read -> merge -> write, preserve user config)', () => {
  test('writes the Forge [[hooks.PreToolUse]] groups into an empty config', () => {
    const merged = mergeCodexGlobalConfigToml('', FORGE_HOOK_CONTRACT);
    expect(merged).toContain('[[hooks.PreToolUse]]');
    expect(merged).toContain('--intent protected-path');
    expect(merged).toContain('--intent tdd-gate');
    expect(merged).toContain(FORGE_MARK);
    expect(merged.endsWith('\n')).toBe(true);
  });

  test('preserves ALL existing user config, including user hook groups', () => {
    const existing = [
      'model = "gpt-5.3-codex"',
      'sandbox_mode = "workspace-write"',
      '',
      '[mcp_servers.docs]',
      'command = "docs-server"',
      '',
      '[[hooks.PreToolUse]]',
      'matcher = "Bash"',
      '',
      '[[hooks.PreToolUse.hooks]]',
      'type = "command"',
      'command = "node my-own-guard.js"',
      '',
      '[projects."/home/me/repo"]',
      'trust_level = "trusted"',
    ].join('\n');

    const merged = mergeCodexGlobalConfigToml(existing, FORGE_HOOK_CONTRACT);
    expect(merged).toContain('model = "gpt-5.3-codex"');
    expect(merged).toContain('[mcp_servers.docs]');
    expect(merged).toContain('command = "node my-own-guard.js"'); // user hook group preserved
    expect(merged).toContain('[projects."/home/me/repo"]');
    expect(merged).toContain(FORGE_MARK);
  });

  test('is idempotent — re-merging does not duplicate Forge groups', () => {
    const once = mergeCodexGlobalConfigToml('model = "gpt-5.3"', FORGE_HOOK_CONTRACT);
    const twice = mergeCodexGlobalConfigToml(once, FORGE_HOOK_CONTRACT);
    expect(twice).toBe(once);
    const count = (twice.match(/--intent protected-path/g) || []).length;
    expect(count).toBe(1);
  });

  test('refuses (HookConfigParseError) when hooks.PreToolUse exists in a non-array shape', () => {
    // Appending [[hooks.PreToolUse]] after a plain [hooks.PreToolUse] table would
    // produce invalid TOML — never corrupt the user\'s global config.
    const existing = '[hooks.PreToolUse]\nmatcher = "Bash"\n';
    expect(() => mergeCodexGlobalConfigToml(existing, FORGE_HOOK_CONTRACT)).toThrow(HookConfigParseError);
  });
});

describe('mergeHermesGlobalConfigYaml (read -> merge -> write, preserve user config)', () => {
  test('writes the full hooks: block into an empty config', () => {
    const merged = mergeHermesGlobalConfigYaml('', FORGE_HOOK_CONTRACT);
    expect(merged).toContain('hooks:');
    expect(merged).toContain('pre_tool_call:');
    expect(merged).toContain('--harness hermes');
    expect(merged).toContain(FORGE_MARK);
  });

  test('appends a hooks: block after existing config when none exists', () => {
    const existing = 'model: hermes-4\napi_key_env: NOUS_API_KEY\n';
    const merged = mergeHermesGlobalConfigYaml(existing, FORGE_HOOK_CONTRACT);
    expect(merged).toContain('model: hermes-4');
    expect(merged).toContain('api_key_env: NOUS_API_KEY');
    // exactly one top-level hooks: key (duplicate keys are invalid YAML)
    expect(merged.split('\n').filter(l => /^hooks:/.test(l)).length).toBe(1);
    expect(merged).toContain(FORGE_MARK);
  });

  test('merges into an existing hooks:/pre_tool_call: block, preserving user entries', () => {
    const existing = [
      'model: hermes-4',
      'hooks:',
      '  pre_tool_call:',
      '    - matcher: "terminal"',
      '      command: "node my-own-guard.js"',
      '  post_tool_call:',
      '    - matcher: ".*"',
      '      command: "node my-audit.js"',
      'theme: dark',
      '',
    ].join('\n');

    const merged = mergeHermesGlobalConfigYaml(existing, FORGE_HOOK_CONTRACT);
    expect(merged).toContain('model: hermes-4');
    expect(merged).toContain('command: "node my-own-guard.js"');   // user pre_tool_call entry preserved
    expect(merged).toContain('command: "node my-audit.js"');       // user post_tool_call block preserved
    expect(merged).toContain('theme: dark');
    expect(merged.split('\n').filter(l => /^hooks:/.test(l)).length).toBe(1);
    expect(merged.split('\n').filter(l => /^\s+pre_tool_call:/.test(l)).length).toBe(1);
    expect(merged).toContain('--intent protected-path');
    expect(merged).toContain('--intent tdd-gate');
  });

  test('is idempotent — re-merging does not duplicate Forge entries', () => {
    const once = mergeHermesGlobalConfigYaml('model: hermes-4\n', FORGE_HOOK_CONTRACT);
    const twice = mergeHermesGlobalConfigYaml(once, FORGE_HOOK_CONTRACT);
    expect(twice).toBe(once);
    expect((twice.match(/--intent tdd-gate/g) || []).length).toBe(1);
  });

  test('refuses (HookConfigParseError) on an inline hooks: value it cannot merge into', () => {
    expect(() => mergeHermesGlobalConfigYaml('hooks: {}\n', FORGE_HOOK_CONTRACT)).toThrow(HookConfigParseError);
  });

  test('refuses (HookConfigParseError) when the config uses tabs (YAML forbids tab indentation)', () => {
    const existing = 'hooks:\n\tpre_tool_call: []\n';
    expect(() => mergeHermesGlobalConfigYaml(existing, FORGE_HOOK_CONTRACT)).toThrow(HookConfigParseError);
  });
});

describe('installGlobalHooks (consent-guarded writer)', () => {
  test('covers exactly the two global-config harnesses by default', () => {
    expect(GLOBAL_HOOK_HARNESSES).toEqual(['codex', 'hermes']);
  });

  test('writes merged global config for codex and hermes under the given home', () => {
    const results = installGlobalHooks({ env: {}, homeDir: tmpHome });
    expect(results.length).toBe(2);
    for (const res of results) {
      expect(res.wrote).toBe(true);
      expect(res.skipped).toBe(false);
      expect(fs.existsSync(res.file)).toBe(true);
      expect(fs.readFileSync(res.file, 'utf-8')).toContain(FORGE_MARK);
    }
  });

  test('preserves existing user config on install (read -> merge -> write)', () => {
    const codexFile = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(codexFile), { recursive: true });
    fs.writeFileSync(codexFile, 'model = "gpt-5.3-codex"\n', 'utf-8');

    const results = installGlobalHooks({ harnesses: ['codex'], env: {}, homeDir: tmpHome });
    expect(results[0].existed).toBe(true);
    const written = fs.readFileSync(codexFile, 'utf-8');
    expect(written).toContain('model = "gpt-5.3-codex"');
    expect(written).toContain(FORGE_MARK);
  });

  test('is idempotent on disk — a second install leaves the files byte-identical', () => {
    installGlobalHooks({ env: {}, homeDir: tmpHome });
    const first = GLOBAL_HOOK_HARNESSES.map(h =>
      fs.readFileSync(resolveGlobalHookFile(h, { env: {}, homeDir: tmpHome }), 'utf-8'));
    const results = installGlobalHooks({ env: {}, homeDir: tmpHome });
    const second = GLOBAL_HOOK_HARNESSES.map(h =>
      fs.readFileSync(resolveGlobalHookFile(h, { env: {}, homeDir: tmpHome }), 'utf-8'));
    expect(second).toEqual(first);
    expect(results.every(r => r.changed === false)).toBe(true);
  });

  test('dry-run returns previews and writes NOTHING to disk', () => {
    const results = installGlobalHooks({ dryRun: true, env: {}, homeDir: tmpHome });
    for (const res of results) {
      expect(res.dryRun).toBe(true);
      expect(res.wrote).toBe(false);
      expect(res.preview).toContain(FORGE_MARK);
      expect(fs.existsSync(res.file)).toBe(false);
    }
    // No directories or backups sneak in either.
    expect(fs.readdirSync(tmpHome)).toEqual([]);
  });

  test('unmergeable existing config is BACKED UP and left untouched (never overwritten)', () => {
    const hermesFile = path.join(tmpHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(hermesFile), { recursive: true });
    const unmergeable = 'hooks: {}\n';
    fs.writeFileSync(hermesFile, unmergeable, 'utf-8');

    const results = installGlobalHooks({ harnesses: ['hermes'], env: {}, homeDir: tmpHome });
    expect(results[0].skipped).toBe(true);
    expect(results[0].wrote).toBe(false);
    expect(typeof results[0].backup).toBe('string');
    expect(fs.existsSync(results[0].backup)).toBe(true);
    expect(fs.readFileSync(hermesFile, 'utf-8')).toBe(unmergeable); // untouched
  });

  test('dry-run over an unmergeable config reports the skip WITHOUT creating a backup', () => {
    const hermesFile = path.join(tmpHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(hermesFile), { recursive: true });
    fs.writeFileSync(hermesFile, 'hooks: {}\n', 'utf-8');

    const results = installGlobalHooks({ harnesses: ['hermes'], dryRun: true, env: {}, homeDir: tmpHome });
    expect(results[0].skipped).toBe(true);
    expect(results[0].backup).toBeUndefined();
    expect(fs.readdirSync(path.dirname(hermesFile))).toEqual(['config.yaml']); // no .bak
  });

  test('CODEX_HOME is honored for the codex target', () => {
    const codexHome = path.join(tmpHome, 'custom-codex-home');
    const results = installGlobalHooks({ harnesses: ['codex'], env: { CODEX_HOME: codexHome }, homeDir: tmpHome });
    expect(results[0].file).toBe(path.join(path.resolve(codexHome), 'config.toml'));
    expect(fs.existsSync(results[0].file)).toBe(true);
  });
});
