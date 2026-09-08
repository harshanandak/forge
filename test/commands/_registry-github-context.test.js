'use strict';

const { describe, test, expect } = require('bun:test');
const { isDeepStrictEqual } = require('node:util');
const { executeCommand, validateCommand } = require('../../lib/commands/_registry');
const { createGithubContext, GithubContextError } = require('../../lib/github-context');

function command(extra = {}) {
  return { name: 'example', description: 'Test command', handler: () => ({ success: true }), ...extra };
}

function execute(mod, args = [], flags = {}, options = {}) {
  return executeCommand(new Map([[mod.name, mod]]), mod.name, args, flags, '/repo', { skipEnsureHome: true, ...options });
}

describe('registry GitHub context', () => {
  test.each([undefined, true, false, () => true])('accepts absent, boolean, or function metadata: %s', githubAuth => {
    expect(validateCommand(command({ githubAuth })).valid).toBe(true);
  });

  test.each([null, 'true', 1, {}, []].map(value => [value]))('rejects malformed metadata: %j', githubAuth => {
    expect(validateCommand(command({ githubAuth })).valid).toBe(false);
  });

  test('prepares once after stage/home and before handler; preserves caller options and environment', async () => {
    const order = [];
    const context = { bound: true, account: 'work' };
    const callerOptions = Object.freeze({ retained: 42 });
    const before = { ...process.env };
    let passedOptions;
    const mod = command({ name: 'ship', githubAuth: true, mutating: true,
      handler: (_args, _flags, _root, opts) => { order.push('handler'); passedOptions = opts; return { success: true }; } });
    const result = await execute(mod, [], {}, {
      skipEnsureHome: false,
      commandOpts: callerOptions,
      enforceStage: () => { order.push('stage'); return { allowed: true, recordCompletion: () => order.push('completion') }; },
      ensureForgeHome: () => order.push('home'),
      prepareGithubContext: root => { expect(root).toBe('/repo'); order.push('context'); return context; },
    });
    expect(result.success).toBe(true);
    expect(order).toEqual(['stage', 'home', 'context', 'handler', 'completion']);
    expect(passedOptions).toEqual({ retained: 42, githubContext: context });
    expect(passedOptions).not.toBe(callerOptions);
    expect(callerOptions).toEqual({ retained: 42 });
    expect(isDeepStrictEqual({ ...process.env }, before)).toBe(true);
  });

  test.each([undefined, false, () => false])('unmarked/false routes do no preparation: %s', githubAuth => {
    return execute(command({ githubAuth }), [], {}, { prepareGithubContext: () => { throw new Error('must not prepare'); } })
      .then(result => expect(result.success).toBe(true));
  });

  test('predicate receives original args and flags plus command context', async () => {
    const args = Object.freeze(['ship', '--json']);
    const flags = Object.freeze({ json: true });
    let count = 0;
    const mod = command({ githubAuth: (a, f, info) => {
      expect(a).toBe(args); expect(f).toBe(flags);
      expect(info).toMatchObject({ commandName: 'example', projectRoot: '/repo' });
      expect(info.command).toBe(mod);
      return true;
    } });
    expect((await execute(mod, args, flags, { prepareGithubContext: () => { count++; return {}; } })).success).toBe(true);
    expect(count).toBe(1);
  });

  test.each([
    [['--help'], {}], [['-h'], {}], [['help'], {}], [['--path', '/repo', 'help'], {}], [[], { help: true }], [[], { '--help': true }],
  ])('help bypasses predicate and preparation: %j', async (args, flags) => {
    const mod = command({ githubAuth: () => { throw new Error('predicate must not run'); } });
    expect((await execute(mod, args, flags, { prepareGithubContext: () => { throw new Error('must not prepare'); } })).success).toBe(true);
  });

  test('child help after a delimiter is not a registry help bypass', async () => {
    let prepared = false;
    await execute(command({ githubAuth: true }), ['run', '--', 'program', '--help'], {}, {
      prepareGithubContext: () => { prepared = true; return {}; },
    });
    expect(prepared).toBe(true);
  });

  test('stage denial happens before account preparation and handler entry', async () => {
    let entered = false;
    const result = await execute(command({ name: 'ship', githubAuth: true, handler: () => { entered = true; } }), [], {}, {
      enforceStage: () => ({ allowed: false, error: 'stage blocked' }),
      prepareGithubContext: () => { throw new Error('must not prepare'); },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('stage blocked');
    expect(entered).toBe(false);
  });

  test.each([
    () => new Error('test-only-secret-canary'),
    () => new GithubContextError('GITHUB_ACCOUNT_MISMATCH', 'test-only-secret-canary'),
  ])('preparation failure is safe and blocks handler/completion', async makeError => {
    let entered = false;
    let completed = false;
    const result = await execute(command({ name: 'ship', githubAuth: true, handler: () => { entered = true; } }), [], {}, {
      enforceStage: () => ({ allowed: true, recordCompletion: () => { completed = true; } }),
      prepareGithubContext: () => { throw makeError(); },
    });
    expect(result.success).toBe(false);
    expect(entered).toBe(false);
    expect(completed).toBe(false);
    expect(JSON.stringify(result).includes('test-only-secret-canary')).toBe(false);
    expect(result.error).toContain('forge github status');
  });

  test('unbound route performs one local lookup and hands through the private native context', async () => {
    const calls = [];
    const context = () => createGithubContext('/repo', { baseEnv: {}, runner: (program, args) => {
      calls.push({ program, args }); return '';
    } });
    const result = await execute(command({ githubAuth: true, handler: (_a, _f, _r, opts) => ({ success: !opts.githubContext.bound }) }), [], {}, {
      prepareGithubContext: context,
    });
    expect(result.success).toBe(true);
    expect(calls).toEqual([{ program: 'git', args: ['config', '--local', '--get', 'github.account'] }]);
  });

  test('predicate failures never expose raw diagnostics or enter the handler', async () => {
    const result = await execute(command({ githubAuth: () => { throw new Error('test-only-secret-canary'); } }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result).includes('test-only-secret-canary')).toBe(false);
  });

  test('non-boolean predicate results fail closed before preparation or handler', async () => {
    let entered = false;
    const result = await execute(command({ githubAuth: () => 'yes', handler: () => { entered = true; } }), [], {}, {
      prepareGithubContext: () => { entered = true; },
    });
    expect(result.success).toBe(false);
    expect(entered).toBe(false);
  });

  test('verified context replaces only the copy of a caller-supplied context', async () => {
    const staleContext = { bound: false };
    const verifiedContext = { bound: true };
    const callerOptions = Object.freeze({ githubContext: staleContext, retained: 42 });
    let passedOptions;
    await execute(command({ githubAuth: true, handler: (_a, _f, _r, opts) => { passedOptions = opts; } }), [], {}, {
      commandOpts: callerOptions, prepareGithubContext: () => verifiedContext,
    });
    expect(passedOptions).toEqual({ retained: 42, githubContext: verifiedContext });
    expect(callerOptions.githubContext).toBe(staleContext);
  });
});
