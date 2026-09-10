'use strict';

const { describe, test, expect } = require('bun:test');

const {
  createGithubContext,
  prepareGithubAccount,
  prepareGithubContext,
  readGithubAccount,
  unsetGithubAccount,
  validateGithubLogin,
  writeGithubAccount,
} = require('../lib/github-context');
const { classifyAuthError } = require('../lib/adapters/pr-state-adapter');

function fakeRunner(calls, { account = null, liveLogin = account, token = 'token-canary' } = {}) {
  return (command, args, options = {}) => {
    calls.push({ command, args: [...args], options: { ...options, env: options.env && { ...options.env } } });
    if (command === 'git' && args[0] === 'config' && args.includes('--get')) {
      return account ? `${account}\n` : '';
    }
    if (command === 'git' && args[0] === 'config' && args.includes('--unset')) return '';
    if (command === 'git' && args[0] === 'config') return '';
    if (command === 'gh' && args[0] === 'auth') return `${token}\n`;
    if (command === 'gh' && args[0] === 'api') return `${liveLogin}\n`;
    return '';
  };
}

describe('github context', () => {
  test('accepts bounded GitHub logins and rejects malformed values', () => {
    expect(validateGithubLogin('octo-user')).toBe(true);
    expect(validateGithubLogin('a')).toBe(true);
    expect(validateGithubLogin('')).toBe(false);
    expect(validateGithubLogin('-octo')).toBe(false);
    expect(validateGithubLogin('octo-')).toBe(false);
    expect(validateGithubLogin('octo user')).toBe(false);
    expect(validateGithubLogin('x'.repeat(40))).toBe(false);
  });

  test('reads and writes only clone-local github.account using argument arrays', () => {
    const calls = [];
    const runner = fakeRunner(calls, { account: 'Work-Login' });
    expect(readGithubAccount('/repo', { runner })).toBe('Work-Login');
    writeGithubAccount('/repo', 'Work-Login', { runner });
    unsetGithubAccount('/repo', { runner });

    expect(calls[0]).toMatchObject({ command: 'git', args: ['config', '--local', '--get', 'github.account'], options: { cwd: '/repo' } });
    expect(calls[1]).toMatchObject({ command: 'git', args: ['config', '--local', 'github.account', 'Work-Login'], options: { cwd: '/repo' } });
    expect(calls[2]).toMatchObject({ command: 'git', args: ['config', '--local', '--unset-all', 'github.account'], options: { cwd: '/repo' } });
  });

  test('unbound preparation performs one local lookup and no gh or environment work', () => {
    const calls = [];
    const before = { ...process.env };
    const context = createGithubContext('/repo', {
      runner: fakeRunner(calls),
      baseEnv: { GH_TOKEN: 'ambient-token', GITHUB_TOKEN: 'ambient-token', GH_HOST: 'evil.example' },
    });

    expect(context.status).toEqual({ state: 'unbound', account: null, login: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('git');
    expect(JSON.stringify(context)).not.toContain('ambient-token');
    expect({ ...process.env }).toEqual(before);
  });

  test('retrieves a named token without ambient GitHub variables and verifies live login case-insensitively', () => {
    const calls = [];
    const context = createGithubContext('/repo', {
      runner: fakeRunner(calls, { account: 'Work-Login', liveLogin: 'work-login', token: 'token-canary' }),
      baseEnv: { Path: 'kept', GH_TOKEN: 'wrong-token', GITHUB_TOKEN: 'wrong-token', GH_HOST: 'evil.example', gh_token: 'also-wrong' },
    });

    expect(context.status).toEqual({ state: 'ready', account: 'Work-Login', login: 'work-login' });
    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatchObject({
      command: 'gh',
      args: ['auth', 'token', '--hostname', 'github.com', '--user', 'Work-Login'],
    });
    expect(calls[1].options.env).not.toHaveProperty('GH_TOKEN');
    expect(calls[1].options.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(calls[1].options.env).not.toHaveProperty('GH_HOST');
    expect(calls[1].options.env).not.toHaveProperty('gh_token');
    expect(calls[2]).toMatchObject({
      args: ['api', '--hostname', 'github.com', 'user', '--jq', '.login'],
      options: { env: { GH_TOKEN: 'token-canary', GITHUB_TOKEN: 'token-canary', GH_HOST: 'github.com', Path: 'kept' } },
    });
    expect(JSON.stringify(context)).not.toContain('token-canary');
  });

  test('prepares a supplied account without reading or writing Git config', () => {
    const calls = [];
    const context = prepareGithubAccount('/repo', 'Work-Login', {
      runner: fakeRunner(calls, { account: 'unused', liveLogin: 'work-login', token: 'token-canary' }),
      baseEnv: { PATH: 'kept', GH_TOKEN: 'ambient' },
    });

    expect(context.status).toEqual({ state: 'ready', account: 'Work-Login', login: 'work-login' });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.command !== 'git')).toBe(true);
    expect(calls[0]).toMatchObject({
      command: 'gh',
      args: ['auth', 'token', '--hostname', 'github.com', '--user', 'Work-Login'],
    });
  });

  test('validates a supplied account before any subprocess', () => {
    const calls = [];
    expect(() => prepareGithubAccount('/repo', 'bad value', { runner: fakeRunner(calls) })).toThrow(/login|account/i);
    expect(calls).toHaveLength(0);
  });

  test('keeps supplied-account mismatch failures secret-clean', () => {
    const calls = [];
    let failure;
    try {
      prepareGithubAccount('/repo', 'octo', {
        runner: fakeRunner(calls, { account: 'unused', liveLogin: 'other', token: 'token-canary' }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'GITHUB_ACCOUNT_MISMATCH' });
    expect(failure.message).not.toContain('token-canary');
    expect(calls.every((call) => call.command !== 'git')).toBe(true);
  });

  test('private child helpers use selected variables without exposing the token in public values', () => {
    const calls = [];
    const context = prepareGithubContext('/repo', {
      runner: fakeRunner(calls, { account: 'octo', liveLogin: 'octo', token: 'token-canary' }),
      baseEnv: { PATH: 'kept', GH_TOKEN: 'ambient' },
    });
    context.runChild('trusted-agent', ['--flag'], { env: { CUSTOM: 'value' } });

    expect(calls.at(-1).options.env).toMatchObject({ PATH: 'kept', CUSTOM: 'value', GH_TOKEN: 'token-canary', GITHUB_TOKEN: 'token-canary', GH_HOST: 'github.com' });
    expect(context).not.toHaveProperty('buildChildEnv');
    expect(context).not.toHaveProperty('token');
    expect(JSON.stringify(context)).not.toContain('token-canary');
    expect(() => JSON.stringify(context)).not.toThrow();
  });

  test('generic child execution uses the injected child runner, preserves stdio, and returns its result', () => {
    const calls = [];
    const childResult = { sentinel: true };
    const childRunner = (command, args, options) => {
      calls.push({ command, args, options });
      return childResult;
    };
    const context = createGithubContext('/repo', {
      runner: fakeRunner([], { account: 'octo', liveLogin: 'octo', token: 'token-canary' }),
      childRunner,
      baseEnv: { PATH: 'kept', GH_TOKEN: 'ambient' },
    });

    const result = context.runChild('codex', ['--interactive'], { stdio: 'inherit', env: { CUSTOM: 'value' } });

    expect(result).toBe(childResult);
    expect(calls[0]).toMatchObject({ command: 'codex', args: ['--interactive'], options: { stdio: 'inherit' } });
    expect(calls[0].options.env).toMatchObject({ PATH: 'kept', CUSTOM: 'value', GH_TOKEN: 'token-canary', GITHUB_TOKEN: 'token-canary', GH_HOST: 'github.com' });
  });

  test('unbound child execution preserves the injected base environment without account overrides', () => {
    const calls = [];
    const baseEnv = { PATH: 'kept', GH_TOKEN: 'ambient-token', GITHUB_TOKEN: 'ambient-token-2', GH_HOST: 'ambient.example' };
    const childResult = { sentinel: true };
    const context = createGithubContext('/repo', {
      runner: fakeRunner(calls),
      childRunner: (_command, _args, options) => { calls.push({ options }); return childResult; },
      baseEnv,
    });

    expect(context.runChild('codex', ['--interactive'], { stdio: 'inherit' })).toBe(childResult);
    expect(calls[1].options.env).toEqual(baseEnv);
    expect(JSON.stringify(context)).not.toContain('ambient-token');
  });

  test('redacts selected credentials from gh output and leaves process.env unchanged', () => {
    const before = { ...process.env };
    const calls = [];
    const runner = (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (command === 'git') return 'octo\n';
      if (args[0] === 'auth') return 'token-canary\n';
      if (args[0] === 'api' && args[1] === '--hostname') return 'octo\n';
      return 'https://github.com/octo/project token-canary ambient\n';
    };
    const context = createGithubContext('/repo', { runner, baseEnv: { GH_TOKEN: 'ambient', GH_HOST: 'github.com' } });

    expect(context.runGh(['api', 'user'])).toBe('https://github.com/octo/project [REDACTED] [REDACTED]\n');
    expect(JSON.stringify(context.runGh(['api', 'user']))).not.toContain('token-canary');
    expect({ ...process.env }).toEqual(before);
    expect(calls.at(-1).options.env).toMatchObject({ GH_TOKEN: 'token-canary', GITHUB_TOKEN: 'token-canary', GH_HOST: 'github.com' });
  });

  test('fails safely on wrong live account, missing token, and unsupported named-token capability', () => {
    const mismatchCalls = [];
    let mismatchError;
    try {
      createGithubContext('/repo', {
      runner: fakeRunner(mismatchCalls, { account: 'octo', liveLogin: 'other', token: 'token-canary' }),
      });
    } catch (error) {
      mismatchError = error;
    }
    expect(mismatchError).toMatchObject({ code: 'GITHUB_ACCOUNT_MISMATCH' });
    expect(mismatchError.message).toMatch(/octo.*other/i);
    expect(mismatchError.message).not.toContain('token-canary');

    const missingCalls = [];
    expect(() => createGithubContext('/repo', {
      runner: fakeRunner(missingCalls, { account: 'octo', token: '' }),
    })).toThrow(/gh auth login/i);

    const unsupportedCalls = [];
    const unsupported = () => {
      unsupportedCalls.push('called');
      throw new Error('unknown flag: --user');
    };
    expect(() => createGithubContext('/repo', {
      runner: (command, args, options) => {
        if (command === 'git') return 'octo\n';
        return unsupported(command, args, options);
      },
    })).toThrow(/upgrade|GitHub CLI|gh auth login/i);
    expect(unsupportedCalls).toHaveLength(1);
  });

  test('redacts token-bearing live-login and child failures without changing process.env', () => {
    const before = { ...process.env };
    let phase = 'token';
    const runner = (command, args) => {
      if (command === 'git') return 'octo\n';
      if (args[0] === 'auth') return 'token-canary\n';
      if (phase === 'live') {
        const error = new Error('token-canary in message');
        error.stdout = Buffer.from('token-canary');
        error.stderr = Buffer.from('token-canary');
        throw error;
      }
      return 'octo\n';
    };
    phase = 'live';
    let liveError;
    try {
      createGithubContext('/repo', { runner, baseEnv: { GH_TOKEN: 'ambient' } });
    } catch (error) {
      liveError = error;
    }
    expect(liveError).toMatchObject({ code: 'GITHUB_AUTH_FAILED' });
    expect(liveError.message).not.toContain('token-canary');
    expect({ ...process.env }).toEqual(before);

    phase = 'child';
    const childErrorRunner = (command, args) => {
      if (command === 'git') return 'octo\n';
      if (args[0] === 'auth') return 'token-canary\n';
      if (args[0] === 'api' && args[1] === '--hostname') return 'octo\n';
      const error = new Error('HTTP 429 rate limit token-canary in message');
      error.httpStatus = 429;
      error.retryAfter = 60;
      error.stdout = Buffer.from('token-canary');
      error.stderr = Buffer.from('token-canary');
      throw error;
    };
    const childContext = createGithubContext('/repo', { runner: childErrorRunner, baseEnv: { GH_TOKEN: 'ambient' } });
    let childError;
    try {
      childContext.runGh(['api', 'user']);
    } catch (error) {
      childError = error;
    }
    expect(childError).toMatchObject({ code: 'GITHUB_COMMAND_FAILED' });
    expect(childError.message).not.toContain('token-canary');
    expect(classifyAuthError(childError)).toEqual({ class: 'rate-limit', retryAfter: 60 });
    expect({ ...process.env }).toEqual(before);
  });

  test('validates account before named-token subprocess and redacts credential-bearing failures', () => {
    const calls = [];
    expect(() => createGithubContext('/repo', {
      runner: fakeRunner(calls, { account: 'bad value' }),
    })).toThrow(/login|account/i);
    expect(calls).toHaveLength(1);

    const failureCalls = [];
    expect(() => createGithubContext('/repo', {
      runner: (command, args, options) => {
        failureCalls.push({ command, args, options });
        if (command === 'git') return 'octo\n';
        const error = new Error('token-canary leaked in stderr');
        error.stderr = Buffer.from('token-canary');
        error.stdout = Buffer.from('token-canary');
        throw error;
      },
    })).toThrow(/gh auth login|GitHub CLI|upgrade/i);
    expect(failureCalls.some(call => JSON.stringify(call).includes('token-canary'))).toBe(false);
  });
});
