'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hooksCommand = require('../../lib/commands/hooks');

// `forge hooks install --global` — the consent-guarded, opt-in path that projects
// Forge's native hook enforcement into the GLOBAL (home-dir) configs of the two
// harnesses project setup can never write: Codex ($CODEX_HOME/config.toml) and
// Hermes (~/.hermes/config.yaml). Kernel issue 66dd5a1f, epic 90f2f631.

let tmpHome;
let projectRoot;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hooks-cmd-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hooks-proj-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function run(args, flags = {}) {
  // env/homeDir are threaded through the command-opts (4th handler arg) so tests
  // never touch the real home directory.
  return hooksCommand.handler(args, flags, projectRoot, { env: {}, homeDir: tmpHome });
}

describe('command surface', () => {
  test('registers as `hooks` with the registry contract', () => {
    expect(hooksCommand.name).toBe('hooks');
    expect(typeof hooksCommand.description).toBe('string');
    expect(typeof hooksCommand.handler).toBe('function');
    expect(hooksCommand.usage).toContain('--global');
  });

  test('no action → refuses with usage', async () => {
    const res = await run([]);
    expect(res.success).toBe(false);
    expect(res.error).toContain('install');
  });

  test('unknown action → refuses with usage', async () => {
    const res = await run(['uninstall']);
    expect(res.success).toBe(false);
    expect(res.error).toContain('install');
  });
});

describe('consent guard — global config is NEVER written silently', () => {
  test('install without --global refuses with guidance and writes nothing', async () => {
    const res = await run(['install']);
    expect(res.success).toBe(false);
    expect(res.error).toContain('--global');
    expect(res.error.toLowerCase()).toContain('global');
    expect(fs.readdirSync(tmpHome)).toEqual([]); // nothing written
  });

  test('invalid --harness value refuses with the allowed set', async () => {
    const res = await run(['install', '--global', '--harness', 'claude']);
    expect(res.success).toBe(false);
    expect(res.error).toContain('codex');
    expect(res.error).toContain('hermes');
    expect(fs.readdirSync(tmpHome)).toEqual([]);
  });
});

describe('install --global', () => {
  test('writes both global configs by default and prints exactly what went where', async () => {
    const res = await run(['install', '--global']);
    expect(res.success).toBe(true);

    const codexFile = path.join(tmpHome, '.codex', 'config.toml');
    const hermesFile = path.join(tmpHome, '.hermes', 'config.yaml');
    expect(fs.existsSync(codexFile)).toBe(true);
    expect(fs.existsSync(hermesFile)).toBe(true);
    expect(fs.readFileSync(codexFile, 'utf-8')).toContain('forge-native-hook.js');
    expect(fs.readFileSync(hermesFile, 'utf-8')).toContain('forge-native-hook.js');

    // The output names each file and shows the block that was merged in.
    expect(res.output).toContain(codexFile);
    expect(res.output).toContain(hermesFile);
    expect(res.output).toContain('[[hooks.PreToolUse]]');
    expect(res.output).toContain('pre_tool_call:');
    // Documents the workspace-root adapter resolution caveat.
    expect(res.output).toContain('.forge/hooks/forge-native-hook.js');
  });

  test('--harness codex limits the install to the codex global config', async () => {
    const res = await run(['install', '--global', '--harness', 'codex']);
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.codex', 'config.toml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.hermes', 'config.yaml'))).toBe(false);
  });

  test('--harness=hermes (equals form) limits the install to hermes', async () => {
    const res = await run(['install', '--global', '--harness=hermes']);
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.hermes', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.codex', 'config.toml'))).toBe(false);
  });

  test('--harness all installs both', async () => {
    const res = await run(['install', '--global', '--harness', 'all']);
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.codex', 'config.toml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.hermes', 'config.yaml'))).toBe(true);
  });

  test('--dry-run previews the writes and touches NOTHING', async () => {
    const res = await run(['install', '--global', '--dry-run'], { dryRun: true });
    expect(res.success).toBe(true);
    expect(res.output.toLowerCase()).toContain('dry-run');
    expect(res.output).toContain('[[hooks.PreToolUse]]');
    expect(fs.readdirSync(tmpHome)).toEqual([]); // no files, no dirs, no backups
  });

  test('unmergeable existing config is reported as backed-up + skipped, not overwritten', async () => {
    const hermesFile = path.join(tmpHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(hermesFile), { recursive: true });
    fs.writeFileSync(hermesFile, 'hooks: {}\n', 'utf-8');

    const res = await run(['install', '--global', '--harness', 'hermes']);
    expect(res.success).toBe(true); // the run completed; the skip is surfaced per-target
    expect(res.output.toLowerCase()).toContain('skip');
    expect(res.output).toContain('.bak');
    expect(fs.readFileSync(hermesFile, 'utf-8')).toBe('hooks: {}\n');
  });
});
