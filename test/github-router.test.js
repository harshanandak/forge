'use strict';

const { afterEach, describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const spawn = require('cross-spawn');
const { findForgeBinDir, getGithubRouterStatus, installGithubRouter, isOwnedCredentialHelperValue, uninstallGithubRouter } = require('../lib/github-router');

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
    expect(fs.readFileSync(path.join(binDir, 'gh.cmd'), 'utf8')).toContain('github proxy --');
    expect(fs.readFileSync(path.join(binDir, 'forge-github-credential-v1'), 'utf8')).toContain('github credential "$@"');
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

  test('uninstall removes only marked Forge launchers', () => {
    const binDir = tempRoot();
    installGithubRouter({ platform: 'linux', binDir, runtimeCommand: ['/opt/forge/bin/forge'] });
    fs.writeFileSync(path.join(binDir, 'keep-me'), 'native');
    const result = uninstallGithubRouter({ platform: 'linux', binDir });
    expect(result.removed.sort()).toEqual(['forge-github-credential-v1', 'gh']);
    expect(fs.readFileSync(path.join(binDir, 'keep-me'), 'utf8')).toBe('native');
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
