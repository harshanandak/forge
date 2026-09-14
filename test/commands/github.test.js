'use strict';

const { describe, test, expect } = require('bun:test');
const { handler } = require('../../lib/commands/github');
const { getTestCandidatesForChangedFile } = require('../../lib/commands/test');
const { classifyPushTests } = require('../../scripts/test');
const path = require('node:path');

const CANARY = 'test-only-sensitive-canary';

function fixture(overrides = {}) {
  const calls = [];
  let account = overrides.account ?? 'personal';
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'git') {
      if (args.join(' ') === 'config --local --get github.account') return account;
      if (args.join(' ') === 'config --local --get-all github.auto') {
        return overrides.automaticValue ?? (overrides.automatic ? 'true' : '');
      }
      if (args.join(' ') === 'config --local --get-all credential.https://github.com.helper') {
        return overrides.automatic ? '\n!forge-git-credential' : '';
      }
      if (args[2] === '--replace-all' && args[3] === 'github.account') { account = args[4]; return ''; }
      if (args[2] === '--unset-all') {
        if (!account) throw Object.assign(new Error(CANARY), { status: 5 });
        account = ''; return '';
      }
      if (args.includes('user.name')) return 'Example Author';
      if (args.includes('user.email')) return 'author@example.test';
      if (args.includes('credential.helper')) return overrides.scopedHelper ?? overrides.helper ?? `!gh auth git-credential # ${CANARY}`;
      if (args[0] === 'remote') return overrides.remote || 'https://github.com/org/project.git';
    }
    if (command === 'ssh') return `hostname ${overrides.sshHostname || 'github.com'}\nuser git\n`;
    if (command === 'gh') {
      if (args[0] === 'auth') {
        if (overrides.authError) throw new Error(CANARY);
        return CANARY;
      }
      if (args[0] === 'api') return overrides.login || 'work';
      if (args[0] === 'repo') {
        if (overrides.noAccess) throw Object.assign(new Error(CANARY), { stdout: CANARY, stderr: CANARY });
        return '{"nameWithOwner":"org/project"}';
      }
    }
    throw new Error(`Unexpected fixture call: ${command}`);
  };
  return { calls, options: { runner, routerStatus: () => overrides.routerState || 'ready',
    registerRouterClone: () => {}, unregisterRouterClone: () => {},
    baseEnv: { GH_TOKEN: 'ambient-canary', GH_HOST: 'other.example' } }, account: () => account };
}

describe('forge github lifecycle', () => {
  test('use verifies the requested account and repository before writing only the local binding', async () => {
    const f = fixture();
    const result = await handler(['use', 'work'], {}, '/repo', f.options);
    expect(result.success).toBe(true);
    expect(f.account()).toBe('work');
    expect(f.calls.map(c => [c.command, c.args[0]])).toEqual([
      ['gh', 'auth'], ['gh', 'api'], ['git', 'remote'], ['gh', 'repo'], ['git', 'config'], ['git', 'config'],
    ]);
    expect(f.calls[0].options.env.GH_TOKEN).toBeUndefined();
    expect(f.calls[3].options.env.GH_TOKEN === CANARY).toBe(true);
    expect(f.calls[3].args).toEqual(['repo', 'view', 'github.com/org/project', '--json', 'nameWithOwner']);
    expect(f.calls[5].args).toEqual(['config', '--local', '--replace-all', 'github.account', 'work']);
    expect(JSON.stringify(result).includes(CANARY)).toBe(false);
  });

  test('plain use preserves and reports an existing automatic mode', async () => {
    const f = fixture({ automatic: true });
    const registered = [];
    f.options.registerRouterClone = root => registered.push(root);
    const result = await handler(['use', 'work'], {}, '/repo', f.options);
    expect(result).toMatchObject({ success: true, account: 'work', automatic: true });
    expect(result.output).toContain('with automatic routing');
    expect(f.calls.some(call => call.args.includes('--unset-all'))).toBe(false);
    expect(registered).toEqual(['/repo']);
  });

  test('plain use fails closed without changing an invalid automatic clone', async () => {
    const f = fixture({ automaticValue: 'true\ntrue' });
    const result = await handler(['use', 'work'], {}, '/repo', f.options);

    expect(result).toMatchObject({ success: false, code: 'GITHUB_AUTO_INVALID' });
    expect(f.account()).toBe('personal');
    expect(f.calls.some(call => call.args.includes('--replace-all'))).toBe(false);
  });

  test('switches an automatic clone through native gh instead of its existing router', async () => {
    const f = fixture({ automatic: true });
    const simulated = f.options.runner;
    const executables = [];
    delete f.options.runner;
    f.options.resolveRealGh = () => '/native/gh';
    f.options.execFileSync = (command, args, options) => {
      executables.push(command);
      return simulated(command === '/native/gh' ? 'gh' : command, args, options);
    };

    const result = await handler(['use', 'work'], {}, '/repo', f.options);

    expect(result).toMatchObject({ success: true, account: 'work', automatic: true });
    expect(executables.filter(command => command === '/native/gh')).toHaveLength(3);
    expect(f.account()).toBe('work');
  });

  test('does not change the binding when native gh is unavailable', async () => {
    const f = fixture({ automatic: true });
    delete f.options.runner;
    f.options.resolveRealGh = () => null;
    f.options.execFileSync = () => { throw new Error('must not execute'); };

    const result = await handler(['use', 'work'], {}, '/repo', f.options);

    expect(result.success).toBe(false);
    expect(f.account()).toBe('personal');
  });

  test('use --auto explicitly enables clone-local gh and HTTPS Git routing', async () => {
    const config = new Map([['github.account', ['personal']]]);
    const calls = [];
    let liveLogin = 'work';
    let failAutoWrite = false;
    let failAccountWrite = false;
    let routerCommits = 0;
    let routerRollbacks = 0;
    const runner = (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'gh' && args[0] === 'auth') return CANARY;
      if (command === 'gh' && args[0] === 'api') return liveLogin;
      if (command === 'gh' && args[0] === 'repo') return '{"nameWithOwner":"org/project"}';
      if (command === 'git' && args[0] === 'remote') return 'https://github.com/org/project.git';
      if (command !== 'git' || args[0] !== 'config') throw new Error(`Unexpected call: ${command}`);
      const verb = args[2];
      const key = args[3];
      if (verb === '--get' || verb === '--get-all') {
        const values = config.get(key);
        if (!values?.length) throw Object.assign(new Error('missing'), { status: 1 });
        return verb === '--get' ? values.at(-1) : values.join('\n');
      }
      if (verb === '--replace-all') {
        if (key === 'github.account' && failAccountWrite) { failAccountWrite = false; throw new Error('account write failure'); }
        if (key === 'github.auto' && failAutoWrite) { failAutoWrite = false; throw new Error('write failure'); }
        config.set(key, [args[4]]); return '';
      }
      if (verb === '--add') { config.set(key, [...(config.get(key) || []), args[4]]); return '';
      }
      throw new Error(`Unexpected git config call: ${args.join(' ')}`);
    };

    const helper = "!'C:/Users/example/forge-github-credential-v1'";
    const result = await handler(['use', 'work', '--auto'], {}, '/repo', {
      runner, baseEnv: {}, installRouter: () => ({ credentialHelperValue: helper, commit: () => { routerCommits += 1; } }),
      isOwnedCredentialHelper: () => true,
    });

    expect(result).toMatchObject({ success: true, account: 'work', automatic: true });
    expect(config.get('github.account')).toEqual(['work']);
    expect(config.get('github.auto')).toEqual(['true']);
    expect(config.get('credential.https://github.com.helper')).toEqual(['', helper]);
    expect(routerCommits).toBe(1);
    expect(JSON.stringify(result)).not.toContain(CANARY);

    const cleanupWarning = 'Configuration applied; router lock cleanup failed.';
    const autoResult = await handler(['auto'], {}, '/repo', {
      runner, baseEnv: {}, routerStatus: () => 'ready',
      installRouter: () => ({ credentialHelperValue: helper, commit: () => ({ warning: cleanupWarning }) }),
      isOwnedCredentialHelper: () => true,
    });
    expect(autoResult).toMatchObject({ success: true, warning: cleanupWarning });
    expect(config.get('github.auto')).toEqual(['true']);

    liveLogin = 'personal';
    failAutoWrite = true;
    const failed = await handler(['use', 'personal', '--auto'], {}, '/repo', {
      runner, baseEnv: {},
      installRouter: () => ({ credentialHelperValue: helper, rollback: () => { routerRollbacks += 1; } }),
      isOwnedCredentialHelper: () => true,
    });
    expect(failed.success).toBe(false);
    expect(config.get('github.account')).toEqual(['work']);
    expect(routerRollbacks).toBe(1);

    failAccountWrite = true;
    const failedAccount = await handler(['use', 'personal', '--auto'], {}, '/repo', {
      runner, baseEnv: {},
      installRouter: () => ({ credentialHelperValue: helper, rollback: () => { routerRollbacks += 1; } }),
      isOwnedCredentialHelper: () => true,
    });
    expect(failedAccount.success).toBe(false);
    expect(config.get('github.account')).toEqual(['work']);
    expect(routerRollbacks).toBe(2);
  });

  test('use --auto refuses to replace a pre-existing clone helper before account work', async () => {
    const calls = [];
    const runner = (command, args) => {
      calls.push({ command, args });
      if (command === 'git' && args.join(' ') === 'config --local --get-all credential.https://github.com.helper') {
        return 'manager-core';
      }
      throw new Error('should stop after helper preflight');
    };

    const result = await handler(['use', 'work', '--auto'], {}, '/repo', { runner });

    expect(result).toMatchObject({ success: false, code: 'GIT_CREDENTIAL_HELPER_CONFLICT' });
    expect(calls).toHaveLength(1);
  });

  test('use --auto reads the previous binding before installing router files', async () => {
    let installs = 0;
    const runner = (command, args) => {
      if (command === 'gh' && args[0] === 'auth') return CANARY;
      if (command === 'gh' && args[0] === 'api') return 'work';
      if (command === 'gh' && args[0] === 'repo') return '{"nameWithOwner":"org/project"}';
      if (command === 'git' && args[0] === 'remote') return 'https://github.com/org/project.git';
      if (command === 'git' && args.join(' ') === 'config --local --get-all credential.https://github.com.helper') {
        throw Object.assign(new Error('missing'), { status: 1 });
      }
      if (command === 'git' && args.join(' ') === 'config --local --get github.account') {
        throw Object.assign(new Error('config failed'), { status: 2 });
      }
      throw new Error(`Unexpected fixture call: ${command} ${args.join(' ')}`);
    };

    const result = await handler(['use', 'work', '--auto'], {}, '/repo', {
      runner, baseEnv: {}, installRouter: () => { installs += 1; return {}; },
    });

    expect(result.success).toBe(false);
    expect(installs).toBe(0);
  });

  test.each([{ authError: true }, { login: 'wrong' }, { noAccess: true }])('failed use preserves previous binding and never logs in or switches: %j', async failure => {
    const f = fixture(failure);
    const result = await handler(['use', 'work'], {}, '/repo', f.options);
    expect(result.success).toBe(false);
    expect(f.account()).toBe('personal');
    expect(f.calls.some(c => c.command === 'git' && c.args[0] === 'config')).toBe(false);
    expect(f.calls.some(c => ['login', 'switch'].includes(c.args[1]))).toBe(false);
    expect(JSON.stringify(result).includes(CANARY)).toBe(false);
  });

  test.each(['-work', 'work;whoami', 'x'.repeat(40), ''])('invalid use never spawns: %s', async account => {
    const f = fixture();
    expect((await handler(['use', account], {}, '/repo', f.options)).success).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  test('status JSON is read-only and classifies remote and helper without exposing either', async () => {
    const f = fixture({ account: 'Work', login: 'work' });
    const result = await handler(['status', '--json'], {}, '/repo', f.options);
    const status = JSON.parse(result.output);
    expect(status).toMatchObject({ state: 'ready', account: 'Work', source: 'clone-local', login: 'work', repositoryAccess: true,
      author: { name: 'Example Author', email: 'author@example.test' }, transport: 'https', credentialHelper: 'github-cli' });
    expect(JSON.stringify(result).includes(CANARY)).toBe(false);
    expect(JSON.stringify(result).includes('https://user:')).toBe(false);
    expect(f.account()).toBe('Work');
    expect(f.calls.every(c => c.command !== 'git' || c.args[0] === 'remote' || c.args.includes('--get')
      || c.args.includes('--get-all') || c.args.includes('--get-urlmatch'))).toBe(true);
  });

  test('human status shows whether automatic routing is active', async () => {
    const f = fixture({ account: 'Work', login: 'work', automatic: true, helper: 'manager-core',
      scopedHelper: "!'C:/Forge/forge-github-credential-v1'" });
    f.options.isOwnedCredentialHelper = () => true;
    const result = await handler(['status'], {}, '/repo', f.options);
    expect(result.output).toContain('Automatic routing: on');
    expect(result.output).toContain('Router: ready');
    expect(result.status.credentialHelper).toBe('forge');
    expect(result.output).toContain("HTTPS Git credentials use this clone's Forge-selected GitHub account.");
    expect(result.output).not.toContain('selected separately');
  });

  test('status reports a missing or unowned Forge credential helper as stale', async () => {
    const f = fixture({ account: 'Work', login: 'work', automatic: true,
      scopedHelper: "!'C:/Moved/forge-github-credential-v1'" });
    f.options.isOwnedCredentialHelper = () => false;
    const result = await handler(['status'], {}, '/repo', f.options);
    expect(result.status.credentialHelper).toBe('forge-stale');
    expect(result.output).toContain('missing or unowned');
    expect(result.output).not.toContain('HTTPS Git credentials use this clone');
  });

  test('router uninstall requires machine-wide confirmation and a disabled current clone', async () => {
    let uninstalls = 0;
    const unconfirmed = await handler(['router', '--uninstall'], {}, '/repo', {
      uninstallRouter: () => { uninstalls += 1; return { removed: [] }; },
    });
    const enabled = await handler(['router', '--uninstall', '--force'], { force: true }, '/repo', {
      readAuto: () => true,
      uninstallRouter: () => { uninstalls += 1; return { removed: [] }; },
    });
    expect(unconfirmed).toMatchObject({ success: false, code: 'GITHUB_ROUTER_CONFIRMATION' });
    expect(enabled).toMatchObject({ success: false, code: 'GITHUB_ROUTER_IN_USE' });
    expect(uninstalls).toBe(0);

    const result = await handler(['router', '--uninstall', '--force'], { force: true }, '/repo', {
      readAuto: () => false,
      uninstallRouter: () => ({ removed: ['gh', 'gh.cmd'], warning: 'Router cleanup needs attention.' }),
    });
    expect(result).toMatchObject({ success: true, removed: ['gh', 'gh.cmd'], warning: 'Router cleanup needs attention.' });
    expect(result.output).toContain('Router cleanup needs attention.');
  });

  test('router lock contention is a retryable safe failure', async () => {
    const result = await handler(['router', '--uninstall', '--force'], { force: true }, '/repo', {
      readAuto: () => false,
      uninstallRouter: () => { throw Object.assign(new Error(CANARY), { code: 'GITHUB_ROUTER_BUSY' }); },
    });
    expect(result).toMatchObject({ success: false, code: 'GITHUB_ROUTER_BUSY' });
    expect(result.error).toMatch(/retry/i);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  test.each([
    [{ authError: true }, 'unauthenticated'],
    [{ login: 'wrong' }, 'mismatch'],
    [{ noAccess: true }, 'no_repository_access'],
  ])('status distinguishes failure and keeps diagnostic output safe: %j', async (failure, state) => {
    const f = fixture({ account: 'work', ...failure });
    const result = await handler(['status'], {}, '/repo', f.options);
    expect(result.status.state).toBe(state);
    expect(JSON.stringify(result).includes(CANARY)).toBe(false);
    expect(f.account()).toBe('work');
  });

  test('unbound status makes no gh calls and explains independent SSH selection', async () => {
    const f = fixture({ account: '', remote: `github-work:org/${CANARY}.git` });
    const result = await handler(['status'], {}, '/repo', f.options);
    expect(result.status).toMatchObject({ state: 'unbound', account: null, source: null, login: null, transport: 'ssh', repositoryAccess: null });
    expect(f.calls.some(c => c.command === 'gh')).toBe(false);
    expect(result.output).toContain('SSH');
    expect(result.output.includes(CANARY)).toBe(false);
  });

  test('unset is idempotent and removes every local value', async () => {
    const f = fixture({ account: ['personal', 'work'] });
    let unregistered = 0;
    f.options.unregisterRouterClone = () => { unregistered += 1; };
    expect((await handler(['unset'], {}, '/repo', f.options)).success).toBe(true);
    expect((await handler(['unset'], {}, '/repo', f.options)).success).toBe(true);
    expect(f.account()).toBe('');
    expect(f.calls.filter(c => c.args.join(' ') === 'config --local --unset-all github.account')).toHaveLength(2);
    expect(f.calls.every(c => c.command === 'git')).toBe(true);
    expect(unregistered).toBe(2);
  });

  test('disable removes the clone from the machine registry after local routing is off', async () => {
    const f = fixture({ automatic: true });
    const events = [];
    const runner = f.options.runner;
    f.options.runner = (...args) => {
      const result = runner(...args);
      if (args[0] === 'git' && args[1].includes('--unset-all')) events.push('disabled');
      return result;
    };
    f.options.unregisterRouterClone = () => events.push('unregistered');

    expect(await handler(['auto', '--disable'], {}, '/repo', f.options)).toMatchObject({ success: true, automatic: false });
    expect(events).toEqual(['disabled', 'unregistered']);
  });

  test('help, malformed commands, and missing launcher delimiter perform no context work', async () => {
    const f = fixture();
    expect((await handler(['help'], {}, '/repo', f.options)).success).toBe(true);
    expect((await handler(['run', 'codex'], {}, '/repo', f.options)).success).toBe(false);
    expect((await handler(['use', 'work', 'extra'], {}, '/repo', f.options)).success).toBe(false);
    expect((await handler(['unknown'], {}, '/repo', f.options)).success).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  test.each([
    { host: 'github-work', remote: 'git@github-work:org/project.git' },
    { host: 'github-work', remote: 'github-work:org/project.git' },
    { host: 'github_work', remote: 'git@github_work:org/project.git' },
    { host: 'github-personal', remote: 'git@github-personal:org/project.git' },
    { host: 'github-personal', remote: 'github-personal:org/project.git' },
  ])('use and bound status resolve SSH alias before querying an explicit GitHub repository: %j', async ({ host, remote }) => {
    const f = fixture({ account: 'work', remote });
    expect((await handler(['use', 'work'], {}, '/repo', f.options)).success).toBe(true);
    expect((await handler(['status', '--json'], {}, '/repo', f.options)).status).toMatchObject({ state: 'ready', transport: 'ssh' });
    const ssh = f.calls.filter(c => c.command === 'ssh');
    expect(ssh).toHaveLength(2);
    expect(ssh.every(c => c.args.join(' ') === `-G ${host}`)).toBe(true);
    expect(ssh.every(c => c.options.env?.GH_TOKEN === undefined)).toBe(true);
    expect(f.calls.filter(c => c.command === 'gh' && c.args[0] === 'repo').every(c => c.args[2] === 'github.com/org/project')).toBe(true);
  });

  test.each([
    { remote: 'http://github.com/org/project.git' },
    { remote: 'git://github.com/org/project.git' },
    { remote: 'https://gitlab.com/org/project.git' },
    { remote: 'https://github.com/org/project/extra' },
    { remote: `https://user:${CANARY}@github.com/org/project.git` },
    { remote: 'git@github-work:org/project.git', sshHostname: 'gitlab.com' },
    { remote: 'git@github-work:org/project.git', sshHostname: CANARY },
    { remote: 'C:org/project.git', sshHostname: 'github.com' },
  ])('invalid or non-GitHub origins fail safely without querying or changing the binding: %j', async remote => {
    const f = fixture(remote);
    const result = await handler(['use', 'work'], {}, '/repo', f.options);
    expect(result.success).toBe(false);
    expect(result.code).toBe('GITHUB_REPOSITORY_INVALID');
    expect(f.account()).toBe('personal');
    expect(f.calls.some(c => c.command === 'gh' && c.args[0] === 'repo')).toBe(false);
    expect(JSON.stringify(result).includes(CANARY)).toBe(false);
    const bound = fixture({ account: 'work', ...remote });
    const report = await handler(['status', '--json'], {}, '/repo', bound.options);
    expect(report.status.state).toBe('no_repository_access');
    expect(report.status.repositoryAccess).toBe(false);
    expect(JSON.stringify(report).includes(CANARY)).toBe(false);
  });

  test.each([
    ['bin/forge.js', 'test/github-launcher.test.js'],
    ['bin/forge-gh-proxy.js', 'test/bin/forge-gh-proxy.test.js'],
    ['bin/forge-github-credential.js', 'test/bin/forge-github-credential.test.js'],
    ['lib/commands/github.js', 'test/commands/github.test.js'],
    ['lib/github-credential.js', 'test/github-credential.test.js'],
    ['lib/github-router.js', 'test/github-router.test.js'],
    ['lib/gh-proxy.js', 'test/gh-proxy.test.js'],
  ])('targeted selection covers %s', (file, expectedTest) => {
    expect(getTestCandidatesForChangedFile(file)).toContain(expectedTest);
    const plan = classifyPushTests(path.resolve(__dirname, '../..'), (_command, args) => args[0] === 'diff' ? `${file}\n` : 'origin/feature');
    expect(plan.runFullSuite).toBe(false);
    expect(plan.testTargets).toContain(expectedTest);
  });
});
