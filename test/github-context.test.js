'use strict';

const { describe, test, expect } = require('bun:test');

const {
  createGithubContext,
  createGithubTokenContext,
  disableGithubAuto,
  enableGithubAuto,
  prepareGithubAccount,
  prepareGithubContext,
  assertGithubAutoAvailable,
  readGithubAccount,
  readGithubAuto,
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
  test('reads automatic routing as absent, enabled, or invalid', () => {
    const config = new Map();
    const runner = (command, args) => {
      if (command !== 'git' || args[0] !== 'config') throw new Error('unexpected command');
      const values = config.get(args.at(-1));
      if (!values) throw Object.assign(new Error('missing'), { status: 1 });
      return `${values.join('\n')}\n`;
    };

    expect(readGithubAuto('/repo', { runner })).toBe(false);
    config.set('github.auto', ['true']);
    expect(readGithubAuto('/repo', { runner })).toBe(true);
    config.set('github.auto', ['false']);
    expect(readGithubAuto('/repo', { runner })).toBe(false);
    config.set('github.auto', ['true', 'true']);
    expect(readGithubAuto('/repo', { runner })).toBe(null);
    config.set('github.auto', ['enabled']);
    expect(readGithubAuto('/repo', { runner })).toBe(null);
    config.set('github.auto', ['']);
    expect(readGithubAuto('/repo', { runner })).toBe(null);
    config.set('github.auto', [' ']);
    expect(readGithubAuto('/repo', { runner })).toBe(null);
    config.set('github.auto', ['true', '']);
    expect(readGithubAuto('/repo', { runner })).toBe(null);
  });

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
    expect(calls[1]).toMatchObject({ command: 'git', args: ['config', '--local', '--replace-all', 'github.account', 'Work-Login'], options: { cwd: '/repo' } });
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
      baseEnv: { Path: 'kept', GH_TOKEN: 'wrong-token', GITHUB_TOKEN: 'wrong-token', GH_ENTERPRISE_TOKEN: 'wrong-token', GITHUB_ENTERPRISE_TOKEN: 'wrong-token', GH_HOST: 'evil.example', GH_REPO: 'wrong/repository', gh_token: 'also-wrong' },
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
    expect(calls[1].options.env).not.toHaveProperty('GH_REPO');
    expect(calls[1].options.env).not.toHaveProperty('GH_ENTERPRISE_TOKEN');
    expect(calls[1].options.env).not.toHaveProperty('GITHUB_ENTERPRISE_TOKEN');
    expect(calls[1].options.env).not.toHaveProperty('gh_token');
    expect(calls[2]).toMatchObject({
      args: ['api', '--hostname', 'github.com', 'user', '--jq', '.login'],
      options: { env: { GH_TOKEN: 'token-canary', GITHUB_TOKEN: 'token-canary', GH_HOST: 'github.com', Path: 'kept' } },
    });
    expect(JSON.stringify(context)).not.toContain('token-canary');
  });

  test('creates a routing context from the named token without live identity verification', () => {
    const calls = [];
    const childCalls = [];
    const context = createGithubTokenContext('/repo', {
      runner: fakeRunner(calls, { account: 'Work-Login', token: 'token-canary' }),
      childRunner: (command, args, options) => { childCalls.push({ command, args, options }); return 0; },
      baseEnv: { PATH: 'kept', GH_TOKEN: 'ambient-token', GH_HOST: 'evil.example' },
    });

    expect(context.status).toEqual({ state: 'selected', account: 'Work-Login', login: null });
    context.runChild('gh', ['api', 'user']);
    const ghCalls = calls.filter(call => call.command === 'gh');
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0].args).toEqual(['auth', 'token', '--hostname', 'github.com', '--user', 'Work-Login']);
    expect(childCalls[0].options.env).toMatchObject({ PATH: 'kept', GH_TOKEN: 'token-canary', GITHUB_TOKEN: 'token-canary', GH_HOST: 'github.com' });
    expect(JSON.stringify(context)).not.toContain('token-canary');
  });

  test('automatic routing rolls back partial config writes and disable removes only Forge-owned state', () => {
    const config = new Map();
    let failAutoWrite = true;
    let failHelperUnset = false;
    const runner = (command, args) => {
      expect(command).toBe('git');
      const verb = args[2];
      const key = args[3];
      if (verb === '--get-all') {
        const values = config.get(key);
        if (!values?.length) throw Object.assign(new Error('missing'), { status: 1 });
        return values.join('\n');
      }
      if (verb === '--replace-all') {
        if (key === 'github.auto' && failAutoWrite) { failAutoWrite = false; throw new Error('write failed'); }
        config.set(key, [args[4]]);
        return '';
      }
      if (verb === '--add') { config.set(key, [...(config.get(key) || []), args[4]]); return ''; }
      if (verb === '--unset-all') {
        if (key === 'credential.https://github.com.helper' && failHelperUnset) {
          failHelperUnset = false;
          throw new Error('helper unset failed');
        }
        if (!config.delete(key)) throw Object.assign(new Error('missing'), { status: 1 });
        return '';
      }
      throw new Error(`unexpected git config args: ${args.join(' ')}`);
    };
    const credentialHelperValue = "!'C:/Forge/forge-github-credential-v1'";

    let markerPresent = true;
    const options = { runner, credentialHelperValue, isOwnedCredentialHelper: () => markerPresent,
      isManagedCredentialHelper: value => value === credentialHelperValue };
    expect(() => enableGithubAuto('/repo', options)).toThrow(/enable|config/i);
    expect(config.size).toBe(0);
    enableGithubAuto('/repo', options);
    failHelperUnset = true;
    expect(() => disableGithubAuto('/repo', options)).toThrow(/disable/i);
    expect(config.get('github.auto')).toEqual(['true']);
    expect(config.get('credential.https://github.com.helper')).toEqual(['', credentialHelperValue]);
    config.set('github.account', ['work']);
    markerPresent = false;
    expect(() => assertGithubAutoAvailable('/repo', options)).not.toThrow();
    disableGithubAuto('/repo', options);
    expect(config.get('github.account')).toEqual(['work']);
    expect(config.has('github.auto')).toBe(false);
    expect(config.has('credential.https://github.com.helper')).toBe(false);

    const replacement = "!'C:/Moved/forge-github-credential-v1'";
    options.credentialHelperValue = replacement;
    options.isOwnedCredentialHelper = value => value === replacement;
    enableGithubAuto('/repo', options);
    expect(config.get('credential.https://github.com.helper')).toEqual(['', replacement]);

    config.set('credential.https://github.com.helper', ['', "!'C:/Custom/helper'"]);
    expect(() => assertGithubAutoAvailable('/repo', options)).toThrow(/credential helper/i);
    disableGithubAuto('/repo', options);
    expect(config.get('credential.https://github.com.helper')).toEqual(['', "!'C:/Custom/helper'"]);

    const reservedCustom = "!'C:/Custom/forge-github-credential-v1'";
    config.set('credential.https://github.com.helper', ['', reservedCustom]);
    expect(() => assertGithubAutoAvailable('/repo', options)).toThrow(/credential helper/i);
    disableGithubAuto('/repo', options);
    expect(config.get('credential.https://github.com.helper')).toEqual(['', reservedCustom]);
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
      baseEnv: { PATH: 'kept', GH_TOKEN: 'ambient', GH_REPO: 'wrong/repository' },
    });
    context.runChild('trusted-agent', ['--flag'], { env: { CUSTOM: 'value', gh_repo: 'other/repository' } });

    expect(calls.at(-1).options.env).toMatchObject({ PATH: 'kept', CUSTOM: 'value', GH_TOKEN: 'token-canary', GITHUB_TOKEN: 'token-canary', GH_HOST: 'github.com' });
    expect(calls.at(-1).options.env).not.toHaveProperty('GH_REPO');
    expect(calls.at(-1).options.env).not.toHaveProperty('gh_repo');
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

  test('unbound gh execution redacts credentials that remain in its native environment', () => {
    const baseEnv = { GH_TOKEN: 'ambient-token', GITHUB_TOKEN: 'ambient-token-2', GH_HOST: 'github.com' };
    const runner = (command, args, options = {}) => {
      if (command === 'git') return '';
      expect(options.env).toEqual(baseEnv);
      return 'ambient-token ambient-token-2 public-output\n';
    };
    const context = createGithubContext('/repo', { runner, baseEnv });

    expect(context.runGh(['api', 'user'])).toBe('[REDACTED] [REDACTED] public-output\n');
  });

  test('redacts selected credentials from gh output and leaves process.env unchanged', () => {
    const before = { ...process.env };
    const calls = [];
    const runner = (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (command === 'git') return 'octo\n';
      if (args[0] === 'auth') return 'token-canary\n';
      if (args[0] === 'api' && args[1] === '--hostname') return 'octo\n';
      return '{"nameWithOwner":"org/project","token":"token-canary"}\n';
    };
    const context = createGithubContext('/repo', { runner, baseEnv: { GH_TOKEN: 'org', GH_HOST: 'github.com' } });

    expect(context.runGh(['api', 'user'])).toBe('{"nameWithOwner":"org/project","token":"[REDACTED]"}\n');
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
