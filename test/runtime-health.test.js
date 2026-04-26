const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkRuntimeHealth, resolveShellRuntime } = require('../lib/runtime-health');
const { checkLefthookStatus } = require('../lib/lefthook-check');

function createProjectRoot({ lefthookDependency = true, lefthookBinary = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-health-'));
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  writeLefthookEntries(root);

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

function writeLefthookEntries(root, hooksDir = path.join(root, '.lefthook', 'hooks')) {
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const hook of ['pre-commit', 'pre-push']) {
    const hookPath = path.join(hooksDir, hook);
    fs.writeFileSync(hookPath, `#!/bin/sh\nlefthook run ${hook}\n`);
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch {
      // chmod may be unavailable on some Windows filesystems; Windows hook checks ignore execute bits.
    }
  }
}

function createExecStub({ missing = new Set(), hooksPath = '.lefthook/hooks', resolvedHooksDir = null, gitRoot = null } = {}) {
  return (command, args = []) => {
    if (command === 'git' && args[0] === 'config' && args[1] === '--get' && args[2] === 'core.hooksPath') {
      return `${hooksPath}\n`;
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      if (gitRoot) return `${gitRoot}\n`;
      throw new Error('not a git repository');
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--git-path' && args[2] === 'hooks') {
      if (resolvedHooksDir) return `${resolvedHooksDir}\n`;
      return '.git/hooks\n';
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
      _exec: createExecStub({ hooksPath: '.git/hooks-empty' }),
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

  test('missing lefthook binary produces a hard-stop diagnostic with the worktree repair hint', () => {
    const projectRoot = createProjectRoot({ lefthookDependency: true, lefthookBinary: false });

    const lefthookStatus = checkLefthookStatus(projectRoot);
    expect(lefthookStatus.state).toBe('missing-binary');

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub({ hooksPath: '.git/hooks-empty', resolvedHooksDir: path.join(projectRoot, '.git', 'hooks-empty') }),
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
    expect(result.checks.lefthook.state).toBe('missing-binary');
    expect(result.checks.lefthook.message).toContain('bun install');
  });

  test('bun-created lefthook exe and bunx shims count as an installed binary', () => {
    const projectRoot = createProjectRoot({ lefthookDependency: true, lefthookBinary: false });
    const binDir = path.join(projectRoot, 'node_modules', '.bin');
    fs.writeFileSync(path.join(binDir, 'lefthook.exe'), '');
    fs.writeFileSync(path.join(binDir, 'lefthook.bunx'), '');

    const lefthookStatus = checkLefthookStatus(projectRoot);

    expect(lefthookStatus.state).toBe('installed');
    expect(lefthookStatus.binaryAvailable).toBe(true);
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
      _canExecuteHook: () => true,
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
      _canExecuteHook: () => true,
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
        _canExecuteHook: () => true,
        shellRuntime: { available: true, command: '/bin/sh', policy: 'system-shell' }
      });

      expect(result.hardStop).toBe(false);
      expect(result.checks.hooks.active).toBe(true);
    }
  });

  test('Windows hook-path comparisons are case-insensitive', () => {
    const projectRoot = createProjectRoot();
    const windowsRoot = projectRoot.replace(/\//g, '\\').toUpperCase();
    const hooksPath = `${windowsRoot}\\.LEFTHOOK\\HOOKS`;

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub({ hooksPath }),
      platform: 'win32',
      shellRuntime: { available: true, command: 'C:\\Program Files\\Git\\bin\\bash.exe', policy: 'git-bash' }
    });

    expect(result.hardStop).toBe(false);
    expect(result.checks.hooks.active).toBe(true);
    expect(result.checks.hooks.state).toBe('active');
  });

  test('configured lefthook hooksPath requires lefthook hook entries', () => {
    const projectRoot = createProjectRoot();
    fs.rmSync(path.join(projectRoot, '.lefthook', 'hooks'), { recursive: true, force: true });

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub({ hooksPath: '.lefthook/hooks' }),
      platform: 'linux',
      shellRuntime: { available: true, command: '/bin/sh', policy: 'system-shell' }
    });

    expect(result.hardStop).toBe(true);
    expect(result.checks.hooks).toEqual(
      expect.objectContaining({
        active: false,
        state: 'inactive',
        verification: 'core.hooksPath',
        missingHooks: ['pre-commit', 'pre-push']
      })
    );
  });

  test('relative lefthook hooksPath is resolved from the git root', () => {
    const projectRoot = createProjectRoot();
    const nestedRoot = path.join(projectRoot, 'packages', 'api');
    fs.mkdirSync(nestedRoot, { recursive: true });

    const result = checkRuntimeHealth(nestedRoot, {
      _exec: createExecStub({ hooksPath: '.lefthook/hooks', gitRoot: projectRoot }),
      platform: 'linux',
      _canExecuteHook: () => true,
      shellRuntime: { available: true, command: '/bin/sh', policy: 'system-shell' }
    });

    expect(result.hardStop).toBe(false);
    expect(result.checks.hooks.active).toBe(true);
    expect(result.checks.hooks.hooksDir).toBe(path.join(projectRoot, '.lefthook', 'hooks'));
  });

  test('worktree fallback marks hooks active when core.hooksPath is unset but resolved hook files exist', () => {
    const projectRoot = createProjectRoot();
    const hooksDir = path.join(projectRoot, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nlefthook run pre-commit\n');
    fs.writeFileSync(path.join(hooksDir, 'pre-push'), '#!/bin/sh\nlefthook run pre-push\n');

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub({ hooksPath: '', resolvedHooksDir: hooksDir }),
      platform: 'win32',
      shellRuntime: { available: true, command: 'C:\\Program Files\\Git\\bin\\bash.exe', policy: 'git-bash' }
    });

    expect(result.hardStop).toBe(false);
    expect(result.checks.hooks.active).toBe(true);
  });

  test('worktree fallback requires executable lefthook hook files on POSIX', () => {
    const projectRoot = createProjectRoot();
    const hooksDir = path.join(projectRoot, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nlefthook run pre-commit\n', { mode: 0o644 });
    fs.writeFileSync(path.join(hooksDir, 'pre-push'), '#!/bin/sh\nlefthook run pre-push\n', { mode: 0o644 });

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub({ hooksPath: '', resolvedHooksDir: hooksDir }),
      platform: 'linux',
      _canExecuteHook: () => false,
      shellRuntime: { available: true, command: '/bin/sh', policy: 'system-shell' }
    });

    expect(result.hardStop).toBe(true);
    expect(result.checks.hooks.active).toBe(false);
    expect(result.checks.hooks.missingHooks).toEqual(['pre-commit', 'pre-push']);
  });

  test('explicit non-lefthook hooksPath stays inactive even when default hooks exist', () => {
    const projectRoot = createProjectRoot();
    const hooksDir = path.join(projectRoot, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nlefthook run pre-commit\n');
    fs.writeFileSync(path.join(hooksDir, 'pre-push'), '#!/bin/sh\nlefthook run pre-push\n');

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub({ hooksPath: 'custom-hooks', resolvedHooksDir: hooksDir }),
      platform: 'linux',
      shellRuntime: { available: true, command: '/bin/sh', policy: 'system-shell' }
    });

    expect(result.hardStop).toBe(true);
    expect(result.checks.hooks).toEqual(
      expect.objectContaining({
        active: false,
        state: 'inactive',
        verification: 'core.hooksPath',
        hooksPath: 'custom-hooks'
      })
    );
    expect(result.checks.hooks.message).toContain('custom-hooks');
  });

  test('worktree fallback rejects non-lefthook hook files', () => {
    const projectRoot = createProjectRoot();
    const hooksDir = path.join(projectRoot, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nnpm test\n');
    fs.writeFileSync(path.join(hooksDir, 'pre-push'), '#!/bin/sh\nnpm run lint\n');

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub({ hooksPath: '', resolvedHooksDir: hooksDir }),
      platform: 'win32',
      shellRuntime: { available: true, command: 'C:\\Program Files\\Git\\bin\\bash.exe', policy: 'git-bash' }
    });

    expect(result.hardStop).toBe(true);
    expect(result.checks.hooks.active).toBe(false);
    expect(result.checks.hooks.verification).toBe('git-path-hooks');
    expect(result.checks.hooks.missingHooks).toEqual(['pre-commit', 'pre-push']);
  });

  test('worktree fallback preserves missing-binary lefthook hard-stop when effective hooks are active', () => {
    const projectRoot = createProjectRoot({ lefthookDependency: true, lefthookBinary: false });
    const hooksDir = path.join(projectRoot, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nlefthook run pre-commit\n');
    fs.writeFileSync(path.join(hooksDir, 'pre-push'), '#!/bin/sh\nlefthook run pre-push\n');

    const result = checkRuntimeHealth(projectRoot, {
      _exec: createExecStub({ hooksPath: '', resolvedHooksDir: hooksDir }),
      platform: 'win32',
      shellRuntime: { available: true, command: 'C:\\Program Files\\Git\\bin\\bash.exe', policy: 'git-bash' }
    });

    expect(result.hardStop).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'LEFTHOOK_MISSING',
        severity: 'hard-stop'
      })
    );
    expect(result.checks.lefthook.state).toBe('missing-binary');
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
