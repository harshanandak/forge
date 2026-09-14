'use strict';

const { afterEach, describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const spawn = require('cross-spawn');
const { findForgeBinDir, getGithubRouterStatus, helperPathFromValue, installGithubRouter, isOwnedCredentialHelperValue, uninstallGithubRouter } = require('../lib/github-router');

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-github-router-'));
  roots.push(root);
  return root;
}

describe('opt-in GitHub router installation', () => {
  test('installs marked Windows launchers beside Forge and returns an absolute helper command', () => {
    const binDir = tempRoot();
    const result = installGithubRouter({
      platform: 'win32', binDir,
      runtimeCommand: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Forge App\\bin\\forge.js'],
    });

    expect(result.credentialHelperValue).toBe(`!'${path.join(binDir, 'forge-github-credential-v1').replaceAll('\\', '/')}'`);
    for (const name of ['gh', 'gh.cmd', 'gh.ps1', 'forge-github-credential-v1']) {
      expect(fs.readFileSync(path.join(binDir, name), 'utf8')).toContain('forge-gh-router-v1');
    }
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(binDir, 'gh')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(binDir, 'gh.cmd')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(binDir, 'gh.ps1')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(binDir, 'forge-github-credential-v1')).mode & 0o777).toBe(0o700);
    }
    const cmdLauncher = fs.readFileSync(path.join(binDir, 'gh.cmd'), 'utf8');
    const psLauncher = fs.readFileSync(path.join(binDir, 'gh.ps1'), 'utf8');
    expect(cmdLauncher).toContain('github proxy --');
    expect(cmdLauncher).toContain('setlocal');
    expect(psLauncher).toContain('finally');
    expect(psLauncher).toContain('Remove-Item Env:FORGE_GH_PROXY_ACTIVE');
    expect(fs.readFileSync(path.join(binDir, 'forge-github-credential-v1'), 'utf8')).toContain('github credential "$@"');
    result.commit();
  });

  test('recognizes native and Windows absolute helper paths only for the Forge helper', () => {
    expect(helperPathFromValue("!'/opt/forge/forge-github-credential-v1'")).toBe('/opt/forge/forge-github-credential-v1');
    expect(helperPathFromValue("!'C:/Forge/forge-github-credential-v1'")).toBe('C:/Forge/forge-github-credential-v1');
    expect(helperPathFromValue("!'C:\\Forge\\forge-github-credential-v1'")).toBe('C:\\Forge\\forge-github-credential-v1');
    expect(helperPathFromValue("!'relative/forge-github-credential-v1'")).toBeNull();
    expect(helperPathFromValue("!'C:/Forge/other-helper'")).toBeNull();
  });

  test('refuses to overwrite a non-Forge gh launcher without partial writes', () => {
    const binDir = tempRoot();
    const existing = path.join(binDir, 'gh.cmd');
    fs.writeFileSync(existing, '@echo native\r\n');
    expect(() => installGithubRouter({ platform: 'win32', binDir, runtimeCommand: ['C:\\forge.exe'] }))
      .toThrow(/already exists|refus/i);
    expect(fs.readFileSync(existing, 'utf8')).toBe('@echo native\r\n');
    expect(fs.existsSync(path.join(binDir, 'gh.ps1'))).toBe(false);
  });

  test('rollback removes attempted new files without deleting untouched router files', () => {
    const binDir = tempRoot();
    const untouched = path.join(binDir, 'gh.ps1');
    const originalContent = `# forge-gh-router-v1\nkeep me\n`;
    fs.writeFileSync(untouched, originalContent);
    const originalWrite = fs.writeFileSync;
    let failed = false;
    fs.writeFileSync = (target, ...args) => {
      if (!failed && target.startsWith(`${path.join(binDir, 'gh.cmd')}.`) && target.endsWith('.tmp')) {
        failed = true;
        throw Object.assign(new Error('injected write failure'), { code: 'EACCES' });
      }
      return originalWrite(target, ...args);
    };
    try {
      expect(() => installGithubRouter({ platform: 'win32', binDir, runtimeCommand: ['C:\\forge.exe'] }))
        .toThrow(/cannot write/i);
    } finally {
      fs.writeFileSync = originalWrite;
    }
    expect(fs.readFileSync(untouched, 'utf8')).toBe(originalContent);
    expect(fs.existsSync(path.join(binDir, 'gh'))).toBe(false);
    expect(fs.existsSync(path.join(binDir, 'forge-github-credential-v1'))).toBe(false);
  });

  test('refuses a PATH order where native gh shadows Forge and reports router reachability', () => {
    const root = tempRoot();
    const forgeDir = path.join(root, 'forge');
    const ghDir = path.join(root, 'github');
    fs.mkdirSync(forgeDir);
    fs.mkdirSync(ghDir);
    fs.writeFileSync(path.join(forgeDir, 'forge.cmd'), '@echo off\r\n');
    fs.writeFileSync(path.join(ghDir, 'gh.exe'), 'fake');
    const pathEnv = [ghDir, forgeDir].join(path.delimiter);
    expect(() => installGithubRouter({ platform: 'win32', pathEnv })).toThrow(/before Forge|PATH/i);
    expect(getGithubRouterStatus({ platform: 'win32', pathEnv })).toBe('shadowed');
  });

  test('rejects transient package-runner shims and accepts a stable Forge launcher', () => {
    const root = tempRoot();
    const transientDir = path.join(root, 'node_modules', '.bin');
    const stableDir = path.join(root, 'global-bin');
    fs.mkdirSync(transientDir, { recursive: true });
    fs.mkdirSync(stableDir);
    const shim = '@node C:\\global\\node_modules\\forge-workflow\\bin\\forge.js %*\r\n';
    fs.writeFileSync(path.join(transientDir, 'forge.cmd'), shim);
    fs.writeFileSync(path.join(stableDir, 'forge.cmd'), shim);

    const entrypointPath = 'C:\\global\\node_modules\\forge-workflow\\bin\\forge.js';
    expect(() => findForgeBinDir({ platform: 'win32', pathEnv: [transientDir, stableDir].join(path.delimiter), entrypointPath }))
      .toThrow(/npx and bunx/i);
    expect(findForgeBinDir({ platform: 'win32', pathEnv: stableDir, entrypointPath })).toBe(stableDir);
  });

  test('skips an unrelated forge executable and selects the active forge-workflow launcher', () => {
    const root = tempRoot();
    const unrelatedDir = path.join(root, 'unrelated');
    const workflowDir = path.join(root, 'workflow');
    fs.mkdirSync(unrelatedDir);
    fs.mkdirSync(workflowDir);
    fs.writeFileSync(path.join(unrelatedDir, 'forge.cmd'), '@node C:\\stale\\node_modules\\forge-workflow\\bin\\forge.js %*\r\n');
    fs.writeFileSync(path.join(workflowDir, 'forge-workflow.cmd'), '@node C:\\global\\node_modules\\forge-workflow\\bin\\forge.js %*\r\n');

    expect(findForgeBinDir({ platform: 'win32', pathEnv: [unrelatedDir, workflowDir].join(path.delimiter),
      entrypointPath: 'C:\\global\\node_modules\\forge-workflow\\bin\\forge.js' }))
      .toBe(workflowDir);
  });

  test('uninstall removes only marked Forge launchers', () => {
    const binDir = tempRoot();
    installGithubRouter({ platform: 'linux', binDir, runtimeCommand: ['/opt/forge/bin/forge'] }).commit();
    fs.writeFileSync(path.join(binDir, 'keep-me'), 'native');
    const result = uninstallGithubRouter({ platform: 'linux', binDir });
    expect(result.removed.sort()).toEqual(['forge-github-credential-v1', 'gh']);
    expect(fs.readFileSync(path.join(binDir, 'keep-me'), 'utf8')).toBe('native');
  });

  test('failed uninstall restores files removed earlier in the operation', () => {
    const binDir = tempRoot();
    installGithubRouter({ platform: 'linux', binDir, runtimeCommand: ['/opt/forge/bin/forge'] }).commit();
    const helper = path.join(fs.realpathSync(binDir), 'forge-github-credential-v1');
    const fileSystem = Object.create(fs);
    let injected = false;
    fileSystem.unlinkSync = target => {
      if (target === helper) {
        injected = true;
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return fs.unlinkSync(target);
    };

    expect(() => uninstallGithubRouter({ platform: 'linux', binDir, fileSystem }))
      .toThrow(/cannot remove/i);
    expect(injected).toBe(true);
    expect(fs.existsSync(path.join(binDir, 'gh'))).toBe(true);
    expect(fs.existsSync(helper)).toBe(true);
  });

  test('compiled installs discover their own executable directory and rollback restores router files', () => {
    const binDir = tempRoot();
    const executablePath = path.join(binDir, 'forge-bin.exe');
    fs.writeFileSync(executablePath, 'fake binary');
    expect(findForgeBinDir({ compiled: true, executablePath })).toBe(binDir);
    const installed = installGithubRouter({ platform: 'win32', compiled: true, executablePath, pathEnv: binDir });
    expect(isOwnedCredentialHelperValue(installed.credentialHelperValue)).toBe(true);
    installed.rollback();
    expect(fs.existsSync(path.join(binDir, 'gh.cmd'))).toBe(false);
    expect(fs.existsSync(path.join(binDir, 'forge-github-credential-v1'))).toBe(false);
  });

  test('serializes install rollback and uninstall in one launcher directory', () => {
    const binDir = tempRoot();
    const first = installGithubRouter({ platform: 'linux', binDir, runtimeCommand: ['/opt/forge/bin/forge'] });
    expect(() => installGithubRouter({ platform: 'linux', binDir, runtimeCommand: ['/opt/forge/bin/forge'] }))
      .toThrow(/operation is in progress/i);
    expect(() => uninstallGithubRouter({ platform: 'linux', binDir })).toThrow(/operation is in progress/i);

    first.rollback();
    const second = installGithubRouter({ platform: 'linux', binDir, runtimeCommand: ['/opt/forge/bin/forge'] });
    second.commit();
    expect(uninstallGithubRouter({ platform: 'linux', binDir }).removed.sort())
      .toEqual(['forge-github-credential-v1', 'gh']);
  });

  test('reclaims a valid abandoned lock only when its owner is demonstrably dead', () => {
    const binDir = tempRoot();
    const lock = path.join(binDir, '.forge-github-router.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
      marker: 'forge-gh-router-v1', pid: 999999, token: 'abandoned',
    }));

    const installed = installGithubRouter({
      platform: 'linux', binDir, runtimeCommand: ['/opt/forge/bin/forge'], isProcessRunning: () => false,
    });
    installed.commit();
    expect(fs.existsSync(lock)).toBe(false);
  });

  test('publishes lock ownership atomically', () => {
    const binDir = tempRoot();
    const lock = path.join(binDir, '.forge-github-router.lock');
    const originalWrite = fs.writeFileSync;
    let observed = false;
    fs.writeFileSync = (target, ...args) => {
      if (path.basename(target) === 'owner.json') {
        observed = true;
        expect(fs.existsSync(lock)).toBe(false);
      }
      return originalWrite(target, ...args);
    };
    let installed;
    try {
      installed = installGithubRouter({ platform: 'linux', binDir, runtimeCommand: ['/opt/forge'] });
    } finally {
      fs.writeFileSync = originalWrite;
    }
    installed.commit();
    expect(observed).toBe(true);
  });

  test('keeps a malformed abandoned lock fail closed', () => {
    const binDir = tempRoot();
    fs.mkdirSync(path.join(binDir, '.forge-github-router.lock'));
    expect(() => installGithubRouter({
      platform: 'linux', binDir, runtimeCommand: ['/opt/forge/bin/forge'], isProcessRunning: () => false,
    })).toThrow(/confirming its owner is gone/i);
  });

  test('atomic refresh failure preserves the previous launcher and cleans temporary files', () => {
    const binDir = tempRoot();
    installGithubRouter({ platform: 'linux', binDir, runtimeCommand: ['/old/forge'] }).commit();
    const launcher = path.join(binDir, 'gh');
    const previous = fs.readFileSync(launcher, 'utf8');
    const originalRename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (target === launcher) throw Object.assign(new Error('rename denied'), { code: 'EACCES' });
      return originalRename(source, target);
    };
    try {
      expect(() => installGithubRouter({ platform: 'linux', binDir, runtimeCommand: ['/new/forge'] }))
        .toThrow(/cannot write/i);
    } finally {
      fs.renameSync = originalRename;
    }
    expect(fs.readFileSync(launcher, 'utf8')).toBe(previous);
    expect(fs.readdirSync(binDir).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  test('atomically refreshes existing launchers', () => {
    const binDir = tempRoot();
    installGithubRouter({ platform: 'linux', binDir, runtimeCommand: ['/old/forge'] }).commit();
    const refreshed = installGithubRouter({ platform: 'linux', binDir, runtimeCommand: ['/new/forge'] });
    refreshed.commit();
    refreshed.rollback();
    expect(fs.readFileSync(path.join(binDir, 'gh'), 'utf8')).toContain("'/new/forge'");
    expect(fs.readdirSync(binDir).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  test('reports lock release failure without rolling back committed router files', () => {
    const binDir = tempRoot();
    const installed = installGithubRouter({ platform: 'linux', binDir, runtimeCommand: ['/opt/forge'] });
    const originalRename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (source === path.join(binDir, '.forge-github-router.lock')) throw Object.assign(new Error('release denied'), { code: 'EACCES' });
      return originalRename(source, target);
    };
    let result;
    try { result = installed.commit(); } finally { fs.renameSync = originalRename; }
    installed.rollback();
    expect(result.warning).toContain('Configuration applied');
    expect(fs.existsSync(path.join(binDir, 'gh'))).toBe(true);
  });

  test('uninstall locks each owned router directory once and ignores unrelated PATH directories', () => {
    const root = tempRoot();
    const binDir = path.join(root, 'forge-bin');
    const alias = path.join(root, 'forge-alias');
    const unrelated = path.join(root, 'unrelated');
    fs.mkdirSync(binDir);
    fs.mkdirSync(unrelated);
    fs.symlinkSync(binDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    installGithubRouter({ platform: 'linux', binDir, runtimeCommand: ['/opt/forge/bin/forge'] }).commit();

    const locked = [];
    const fileSystem = Object.create(fs);
    fileSystem.mkdirSync = target => { locked.push(target); return fs.mkdirSync(target); };
    const result = uninstallGithubRouter({
      platform: 'linux', pathEnv: [binDir, alias, unrelated].join(path.delimiter), fileSystem,
    });

    expect(result.removed.sort()).toEqual(['forge-github-credential-v1', 'gh']);
    expect(locked).toHaveLength(1);
    expect(path.dirname(locked[0])).toBe(fs.realpathSync(binDir));
  });

  test('generated router and absolute credential helper execute through paths with spaces', () => {
    const root = tempRoot();
    const binDir = path.join(root, 'bin with spaces');
    const repo = path.join(root, 'repo');
    const fakeForge = path.join(root, 'fake forge.js');
    fs.mkdirSync(binDir);
    fs.mkdirSync(repo);
    fs.writeFileSync(fakeForge, [
      "const args = process.argv.slice(2);",
      "if (args[0] === 'github' && args[1] === 'credential') process.stdout.write('username=work\\npassword=test-only-canary\\n\\n');",
      "else if (args[0] === 'github' && args[1] === 'proxy') process.stdout.write(JSON.stringify(args.slice(3)));",
      "else process.exitCode = 2;",
    ].join('\n'));
    const installed = installGithubRouter({ platform: process.platform, binDir, runtimeCommand: [process.execPath, fakeForge] });

    execFileSync('git', ['init', '--quiet'], { cwd: repo, windowsHide: true });
    execFileSync('git', ['config', '--local', '--replace-all', 'credential.https://github.com.helper', ''], { cwd: repo, windowsHide: true });
    execFileSync('git', ['config', '--local', '--add', 'credential.https://github.com.helper', installed.credentialHelperValue], { cwd: repo, windowsHide: true });
    const credential = execFileSync('git', ['credential', 'fill'], {
      cwd: repo, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true,
    });
    expect(credential).toContain('username=work');
    expect(credential).toContain('password=test-only-canary');

    const launcher = path.join(binDir, process.platform === 'win32' ? 'gh.cmd' : 'gh');
    const routed = spawn.sync(launcher, ['repo', 'view', 'two words'], { encoding: 'utf8', shell: false });
    expect(routed.status).toBe(0);
    expect(routed.stdout).toBe(JSON.stringify(['repo', 'view', 'two words']));
  });
});
