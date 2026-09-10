// forge-test-resource: exclusive
'use strict';

const { afterAll, describe, expect, test } = require('bun:test');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { createGithubContext } = require('../../lib/github-context');
const { executeCommand } = require('../../lib/commands/_registry');
const { createCliSandboxes, FORGE_BIN } = require('../helpers/cli-subprocess');

const sandboxes = createCliSandboxes('forge-account-integration-');
afterAll(() => sandboxes.cleanup());
const fakeToken = login => `test-only-account-session-${login}`;
const canaries = [fakeToken('personal'), fakeToken('work'), 'test-only-wrong-ambient'];
function clean(value) {
  const text = JSON.stringify(value);
  expect(canaries.every(canary => !text.includes(canary))).toBe(true);
}
function environment(root) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|comspec|pathext|temp|tmp)$/i.test(key)) env[key] = value;
  }
  return { ...env, INIT_CWD: root, FORGE_SHEPHERD_DISABLE: '1',
    GH_TOKEN: canaries[2], GITHUB_TOKEN: canaries[2], GH_HOST: 'wrong.example' };
}
function repository(login) {
  const root = fs.realpathSync(sandboxes.makeSandbox());
  if (login) execFileSync('git', ['config', '--local', 'github.account', login], {
    cwd: root, env: environment(root), stdio: 'pipe', windowsHide: true, timeout: 10000,
  });
  return root;
}

// This runs BEFORE the real public CLI imports child_process. Only local Git
// reads and the explicitly trusted probe executable can reach native processes.
function providerPreload() {
  const cp = require('node:child_process');
  const nativeExec = cp.execFileSync;
  const nativeSpawn = cp.spawn;
  const fail = () => { throw new Error('Unexpected provider boundary'); };
  cp.exec = fail; cp.execSync = fail; cp.execFile = fail; cp.spawnSync = fail;
  cp.spawn = (command, args, options) => {
    if (command !== process.execPath) return fail();
    return nativeSpawn(command, args, options);
  };
  cp.execFileSync = (command, args, options = {}) => {
    if (command === 'git' && ['config', 'rev-parse'].includes(args[0])) {
      if (args[0] === 'config' && !args.includes('--get')) return fail();
      return nativeExec(command, args, { ...options, timeout: 10000 });
    }
    if (command !== 'gh') return fail();
    const token = login => `test-only-account-session-${login}`;
    if (args[0] === 'auth') {
      if (args.join(' ') !== 'auth token --hostname github.com --user personal'
        && args.join(' ') !== 'auth token --hostname github.com --user work') return fail();
      if (Object.keys(options.env).some(key => /^(gh_token|github_token|gh_host)$/i.test(key))) return fail();
      return token(args.at(-1));
    }
    if (args.join(' ') !== 'api --hostname github.com user --jq .login') return fail();
    const login = ['personal', 'work'].find(name => options.env.GH_TOKEN === token(name));
    if (!login || options.env.GITHUB_TOKEN !== token(login) || options.env.GH_HOST !== 'github.com') return fail();
    return login;
  };
}
function sessionProbe() {
  const login = ['personal', 'work'].find(name => process.env.GH_TOKEN === `test-only-account-session-${name}`) || 'native';
  const native = login === 'native';
  const valid = native
    ? process.env.GH_TOKEN === 'test-only-wrong-ambient' && process.env.GITHUB_TOKEN === process.env.GH_TOKEN && process.env.GH_HOST === 'wrong.example'
    : process.env.GITHUB_TOKEN === process.env.GH_TOKEN && process.env.GH_HOST === 'github.com';
  const send = event => console.log(JSON.stringify({ event, login, valid, cwd: process.cwd(), args: process.argv.slice(2) }));
  send('ready');
  const timeout = setTimeout(() => process.exit(91), 10000);
  process.stdin.once('data', () => { clearTimeout(timeout); send('done'); process.exit(valid ? 0 : 92); });
}
function launchSession(cwd, projectRoot, pathForm = 'short', native = false) {
  const preload = path.join(cwd, 'provider-preload.cjs');
  const probe = path.join(cwd, 'session-probe.cjs');
  if (!fs.existsSync(preload)) fs.writeFileSync(preload, `(${providerPreload.toString()})();\n`);
  if (!fs.existsSync(probe)) fs.writeFileSync(probe, `(${sessionProbe.toString()})();\n`);
  const tail = ['--help', '--version', '-p', 'child path', '--path=child-only', 'a&b', ''];
  const route = pathForm === 'none' ? [] : pathForm === 'short' ? ['-p', projectRoot] : [`--path=${projectRoot}`];
  const argv = native ? [probe, ...tail]
    : ['--require', preload, FORGE_BIN, 'github', ...route, 'run', '--', process.execPath, probe, ...tail];
  const child = spawn(process.execPath, argv, {
    cwd, env: environment(cwd), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = ''; let stderr = ''; let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    const record = stdout.split(/\r?\n/).slice(0, -1).find(line => line.startsWith('{') && line.includes('"ready"'));
    if (record) readyResolve(JSON.parse(record));
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => {
    const timer = setTimeout(() => child.kill(), 15000);
    child.once('error', () => { clearTimeout(timer); readyResolve(null); resolve({ status: -1, stdout, stderr: 'Spawn failed' }); });
    child.once('close', status => { clearTimeout(timer); readyResolve(null); resolve({ status, stdout, stderr }); });
  });
  return { child, ready, done, tail };
}

describe('simultaneous clone-local GitHub sessions', () => {
  test('public CLI isolates two overlapping bound sessions and preserves child flags and selected roots', async () => {
    const before = { ...process.env };
    const personal = repository('personal'); const work = repository('work');
    // Each CLI starts in the OTHER clone; only its public path flag selects the account.
    const sessions = [launchSession(work, personal), launchSession(personal, work, 'equals')];
    const ready = await Promise.all(sessions.map(session => session.ready));
    // Record overlap before release; reap both sessions before any assertion can throw.
    const overlapping = sessions.every(session => session.child.exitCode === null);
    for (const session of sessions) session.child.stdin.end('continue\n');
    const results = await Promise.all(sessions.map(session => session.done));
    clean({ ready, results });
    expect(ready.map(value => value?.login)).toEqual(['personal', 'work']);
    expect(ready.map(value => value?.cwd)).toEqual([personal, work]);
    expect(ready.every(value => value?.valid)).toBe(true);
    expect(ready.map(value => value?.args)).toEqual(sessions.map(session => session.tail));
    expect(overlapping).toBe(true);
    expect(results.map(result => result.status)).toEqual([0, 0]);
    expect(results.every(result => result.stderr === '')).toBe(true);
    for (let index = 0; index < results.length; index++) {
      const records = results[index].stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      expect(records.map(record => record.login)).toEqual([ready[index].login, ready[index].login]);
      expect(records.map(record => record.event)).toEqual(['ready', 'done']);
    }
    expect(isDeepStrictEqual({ ...process.env }, before)).toBe(true);
  });

  test('unbound public launch matches direct native child behavior, including ambient gh variables', async () => {
    const root = repository();
    const sessions = [launchSession(root, root, 'none'), launchSession(root, root, 'none', true)];
    const ready = await Promise.all(sessions.map(session => session.ready));
    for (const session of sessions) session.child.stdin.end('continue\n');
    const results = await Promise.all(sessions.map(session => session.done));
    clean({ ready, results });
    expect(ready[0]).toEqual(ready[1]);
    expect(ready[0]).toMatchObject({ login: 'native', valid: true, cwd: root });
    expect(results.map(result => result.status)).toEqual([0, 0]);
    expect(results[0].stdout).toBe(results[1].stdout);
    expect(results.every(result => result.stderr === '')).toBe(true);
  });

  test.each(['mismatch', 'provider-error'])('%s blocks the guarded handler and keeps diagnostics private', async mode => {
    const root = repository('work'); let started = 0;
    const result = await executeCommand(new Map([['guarded', {
      name: 'guarded', description: 'test', githubAuth: true,
      handler: () => { started++; return { success: true }; },
    }]]), 'guarded', [], {}, root, {
      skipEnsureHome: true,
      prepareGithubContext: projectRoot => createGithubContext(projectRoot, {
        baseEnv: environment(root), runner: (command, args, options) => {
          if (command === 'git') return execFileSync(command, args, { ...options, env: environment(root), timeout: 10000 });
          if (args[0] === 'auth') return fakeToken('work');
          if (mode === 'provider-error') throw Object.assign(new Error(canaries[0]), { stdout: canaries[1], stderr: canaries[2] });
          return 'personal';
        },
      }),
    });
    expect(started).toBe(0);
    expect(result.success).toBe(false);
    clean(result);
  });
});
