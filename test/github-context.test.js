'use strict';

const { describe, test, expect } = require('bun:test');

const {
  createGithubContext,
  prepareGithubContext,
  readGithubAccount,
  unsetGithubAccount,
  validateGithubLogin,
  writeGithubAccount,
} = require('../lib/github-context');

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
    throw new Error(`unexpected ${command}`);
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

    expect(calls[0]).toMatchObject({ command: 'git', args: ['config', '--local', '--get', 'github.account'] });
    expect(calls[1]).toMatchObject({ command: 'git', args: ['config', '--local', 'github.account', 'Work-Login'] });
    expect(calls[2]).toMatchObject({ command: 'git', args: ['config', '--local', '--unset', 'github.account'] });
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
    expect(calls[2].options.env).toMatchObject({ GH_TOKEN: 'token-canary', GITHUB_TOKEN: 'token-canary', GH_HOST: 'github.com', Path: 'kept' });
    expect(JSON.stringify(context)).not.toContain('token-canary');
  });

  test('private child helpers use selected variables without exposing the token in public values', () => {
    const calls = [];
    const context = prepareGithubContext('/repo', {
      runner: fakeRunner(calls, { account: 'octo', liveLogin: 'octo', token: 'token-canary' }),
      baseEnv: { PATH: 'kept', GH_TOKEN: 'ambient' },
    });
    const childEnv = context.buildChildEnv({ CUSTOM: 'value' });

    expect(childEnv).toMatchObject({ PATH: 'kept', CUSTOM: 'value', GH_TOKEN: 'token-canary', GITHUB_TOKEN: 'token-canary', GH_HOST: 'github.com' });
    expect(context).not.toHaveProperty('token');
    expect(JSON.stringify(context)).not.toContain('token-canary');
    expect(() => JSON.stringify(context)).not.toThrow();
  });

  test('redacts selected credentials from gh output and leaves process.env unchanged', () => {
    const before = { ...process.env };
    const calls = [];
    const runner = (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (command === 'git') return 'octo\n';
      if (args[0] === 'auth') return 'token-canary\n';
      if (args[0] === 'api' && args[1] === '--hostname') return 'octo\n';
      return 'token-canary\n';
    };
    const context = createGithubContext('/repo', { runner, baseEnv: { GH_TOKEN: 'ambient' } });

    expect(context.runGh(['api', 'user'])).toBe('[REDACTED]\n');
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
