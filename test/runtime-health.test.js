const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkRuntimeHealth, resolveShellRuntime } = require('../lib/runtime-health');
const { checkLefthookStatus } = require('../lib/lefthook-check');

function createProjectRoot({ lefthookDependency = true, lefthookBinary = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-health-'));
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });

  const packageJson = {
    name: 'runtime-health-fixture',
    version: '1.0.0',
    devDependencies: lefthookDependency ? { lefthook: '^2.1.4' } : {}
  };

  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

  if (lefthookBinary) {
    fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'lefthook.cmd'), '@echo off\r\necho lefthook\r\n');
    fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'lefthook'), '#!/bin/sh\necho lefthook\n');
  }

  return root;
}

function createExecStub({ missing = new Set(), hooksPath = '.lefthook/hooks' } = {}) {
  return (command, args = []) => {
    if (command === 'git' && args[0] === 'config' && args[1] === '--get' && args[2] === 'core.hooksPath') {
      return `${hooksPath}\n`;
    }

    if (missing.has(command)) {
      throw new Error(`${command}: command not found`);
    }

    if (command === 'bd' && args[0] === '--version') return 'bd 1.0.0\n';
    if (command === 'gh' && args[0] === '--version') return 'gh version 2.0.0\n';
    if (command === 'jq' && args[0] === '--version') return 'jq-1.7\n';

    if (command === 'bash' && args[0] === '--version') return 'GNU bash, version 5.2.0\n';
    if (command === 'sh' && args[0] === '--version') return 'sh 1.0.0\n';

    return '';
  };
}

describe('runtime health checks', () => {
  test('missing lefthook produces a hard-stop diagnostic with explicit installation state', () => {
    const projectRoot = createProjectRoot({ lefthookDependency: false, lefthookBinary: false });

    const lefthookStatus = checkLefthookStatus(projectRoot);
    expect(lefthookStatus.state).toBe('missing-dependency');

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub(),
      platform: 'linux',
      shellRuntime: { available: true, command: '/bin/sh', policy: 'system-shell' }
    });

    expect(result.healthy).toBe(false);
    expect(result.hardStop).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'LEFTHOOK_MISSING',
        severity: 'hard-stop'
      })
    );
    expect(result.checks.lefthook.state).toBe('missing-dependency');
  });

  test('missing bd produces a hard-stop diagnostic', () => {
    const projectRoot = createProjectRoot();

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub({ missing: new Set(['bd']) }),
      platform: 'linux',
      shellRuntime: { available: true, command: '/bin/sh', policy: 'system-shell' }
    });

    expect(result.healthy).toBe(false);
    expect(result.hardStop).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'BD_MISSING',
        severity: 'hard-stop'
      })
    );
    expect(result.checks.bd.available).toBe(false);
  });

  test('missing jq produces a hard-stop diagnostic', () => {
    const projectRoot = createProjectRoot();

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub({ missing: new Set(['jq']) }),
      platform: 'linux',
      shellRuntime: { available: true, command: '/bin/sh', policy: 'system-shell' }
    });

    expect(result.healthy).toBe(false);
    expect(result.hardStop).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'JQ_MISSING',
        severity: 'hard-stop'
      })
    );
    expect(result.checks.jq.available).toBe(false);
  });

  test('missing Windows shell runtime produces a hard-stop diagnostic', () => {
    const projectRoot = createProjectRoot();

    const shellRuntime = resolveShellRuntime({
      platform: 'win32',
      candidates: []
    });

    expect(shellRuntime.available).toBe(false);
    expect(shellRuntime.policy).toBe('git-bash');

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub(),
      platform: 'win32',
      shellRuntime
    });

    expect(result.healthy).toBe(false);
    expect(result.hardStop).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'SHELL_RUNTIME_MISSING',
        severity: 'hard-stop'
      })
    );
    expect(result.checks.shell.available).toBe(false);
  });

  test('Windows shell runtime must be executable, not just present on disk', () => {
    const projectRoot = createProjectRoot();

    const shellRuntime = resolveShellRuntime({
      platform: 'win32',
      candidates: ['C:\\Program Files\\Git\\bin\\bash.exe'],
      _exists: () => true,
      _canExecute: () => false
    });

    expect(shellRuntime.available).toBe(false);
    expect(shellRuntime.state).toBe('unusable');
    expect(shellRuntime.command).toBe('C:\\Program Files\\Git\\bin\\bash.exe');

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub(),
      platform: 'win32',
      shellRuntime
    });

    expect(result.healthy).toBe(false);
    expect(result.hardStop).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'SHELL_RUNTIME_MISSING',
        severity: 'hard-stop'
      })
    );
    expect(result.checks.shell.available).toBe(false);
    expect(result.checks.shell.state).toBe('unusable');
  });

  test('healthy runtime passes with no hard-stop diagnostics', () => {
    const projectRoot = createProjectRoot();

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub(),
      platform: 'linux',
      shellRuntime: { available: true, command: '/bin/sh', policy: 'system-shell' }
    });

    expect(result.healthy).toBe(true);
    expect(result.hardStop).toBe(false);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.checks.lefthook.state).toBe('installed');
    expect(result.checks.bd.available).toBe(true);
    expect(result.checks.gh.available).toBe(true);
    expect(result.checks.jq.available).toBe(true);
    expect(result.checks.shell.available).toBe(true);
  });

  test('absolute hooksPath that targets .lefthook/hooks is accepted as active', () => {
    const projectRoot = createProjectRoot();

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub({ hooksPath: path.join(projectRoot, '.lefthook', 'hooks') }),
      platform: 'linux',
      shellRuntime: { available: true, command: '/bin/sh', policy: 'system-shell' }
    });

    expect(result.hardStop).toBe(false);
    expect(result.checks.hooks.active).toBe(true);
    expect(result.checks.hooks.state).toBe('active');
  });

  test('normalized relative hooksPath variants are accepted as active', () => {
    const projectRoot = createProjectRoot();

    for (const hooksPath of ['./.lefthook/hooks', '.lefthook/hooks/']) {
      const result = checkRuntimeHealth(projectRoot, {
        _exec: createExecStub({ hooksPath }),
        platform: 'linux',
        shellRuntime: { available: true, command: '/bin/sh', policy: 'system-shell' }
      });

      expect(result.hardStop).toBe(false);
      expect(result.checks.hooks.active).toBe(true);
    }
  });

  test('missing project root falls back to process.cwd()', () => {
    const result = checkRuntimeHealth(undefined, {
      _exec: createExecStub(),
      platform: 'linux',
      shellRuntime: { available: true, command: '/bin/sh', policy: 'system-shell' }
    });

    expect(result.checks.projectRoot).toBe(process.cwd());
    expect(result.checks.lefthook).toBeDefined();
    expect(result.checks.bd).toBeDefined();
  });
});
