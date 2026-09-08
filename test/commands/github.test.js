'use strict';

const { describe, test, expect } = require('bun:test');
const { handler } = require('../../lib/commands/github');

const CANARY = 'test-only-sensitive-canary';

function fixture(overrides = {}) {
  const calls = [];
  let account = overrides.account ?? 'personal';
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'git') {
      if (args.join(' ') === 'config --local --get github.account') return account;
      if (args[2] === 'github.account') { account = args[3]; return ''; }
      if (args[2] === '--unset') {
        if (!account) throw Object.assign(new Error(CANARY), { status: 5 });
        account = ''; return '';
      }
      if (args.includes('user.name')) return 'Example Author';
      if (args.includes('user.email')) return 'author@example.test';
      if (args.includes('credential.helper')) return `!gh auth git-credential # ${CANARY}`;
      if (args[0] === 'remote') return overrides.remote || `https://user:${CANARY}@github.com/org/project.git`;
    }
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
  return { calls, options: { runner, baseEnv: { GH_TOKEN: 'ambient-canary', GH_HOST: 'other.example' } }, account: () => account };
}

describe('forge github lifecycle', () => {
  test('use verifies the requested account and repository before writing only the local binding', async () => {
    const f = fixture();
    const result = await handler(['use', 'work'], {}, '/repo', f.options);
    expect(result.success).toBe(true);
    expect(f.account()).toBe('work');
    expect(f.calls.map(c => [c.command, c.args[0]])).toEqual([
      ['gh', 'auth'], ['gh', 'api'], ['gh', 'repo'], ['git', 'config'],
    ]);
    expect(f.calls[0].options.env.GH_TOKEN).toBeUndefined();
    expect(f.calls[2].options.env.GH_TOKEN === CANARY).toBe(true);
    expect(f.calls[3].args).toEqual(['config', '--local', 'github.account', 'work']);
    expect(JSON.stringify(result).includes(CANARY)).toBe(false);
  });

  test.each([{ authError: true }, { login: 'wrong' }, { noAccess: true }])('failed use preserves previous binding and never logs in or switches: %j', async failure => {
    const f = fixture(failure);
    const result = await handler(['use', 'work'], {}, '/repo', f.options);
    expect(result.success).toBe(false);
    expect(f.account()).toBe('personal');
    expect(f.calls.some(c => c.command === 'git')).toBe(false);
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
    expect(f.calls.every(c => c.command !== 'git' || c.args[0] === 'remote' || c.args.includes('--get') || c.args.includes('--get-all'))).toBe(true);
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
    const f = fixture({ account: '', remote: `git@github-work:org/${CANARY}.git` });
    const result = await handler(['status'], {}, '/repo', f.options);
    expect(result.status).toMatchObject({ state: 'unbound', account: null, source: null, login: null, transport: 'ssh', repositoryAccess: null });
    expect(f.calls.some(c => c.command === 'gh')).toBe(false);
    expect(result.output).toContain('SSH');
    expect(result.output.includes(CANARY)).toBe(false);
  });

  test('unset is idempotent and touches only the local key', async () => {
    const f = fixture();
    expect((await handler(['unset'], {}, '/repo', f.options)).success).toBe(true);
    expect((await handler(['unset'], {}, '/repo', f.options)).success).toBe(true);
    expect(f.account()).toBe('');
    expect(f.calls.every(c => c.command === 'git' && c.args.join(' ') === 'config --local --unset github.account')).toBe(true);
  });

  test('help, malformed commands, and missing launcher delimiter perform no context work', async () => {
    const f = fixture();
    expect((await handler(['help'], {}, '/repo', f.options)).success).toBe(true);
    expect((await handler(['run', 'codex'], {}, '/repo', f.options)).success).toBe(false);
    expect((await handler(['use', 'work', 'extra'], {}, '/repo', f.options)).success).toBe(false);
    expect((await handler(['unknown'], {}, '/repo', f.options)).success).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});
