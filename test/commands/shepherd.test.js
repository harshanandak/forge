'use strict';

const { describe, test, expect } = require('bun:test');

const shepherdCmd = require('../../lib/commands/shepherd');
const { validateCommand } = require('../../lib/commands/_registry');

describe('shepherd command handler', () => {
  test('satisfies the _registry { name, description, handler } contract', () => {
    expect(validateCommand(shepherdCmd)).toEqual({ valid: true });
    expect(shepherdCmd.name).toBe('shepherd');
    expect(typeof shepherdCmd.description).toBe('string');
    expect(shepherdCmd.description.length).toBeGreaterThan(0);
    expect(typeof shepherdCmd.handler).toBe('function');
  });

  test('one invocation runs exactly ONE bounded pass (no in-process loop)', async () => {
    let passCount = 0;
    const fakeRun = async () => {
      passCount += 1;
      return { state: 'PENDING', actions: [], reason: 'pending' };
    };
    const out = await shepherdCmd.handler(['123'], {}, process.cwd(), {
      runPass: fakeRun,
      buildContext: async () => ({ pr: '123', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master' }),
    });
    expect(passCount).toBe(1);
    expect(out.success).toBe(true);
    expect(out.state).toBe('PENDING');
  });

  test('--auto-rebase defaults to false and is opt-in via flag', async () => {
    let seenAutoRebase;
    const fakeRun = async (ctx) => {
      seenAutoRebase = ctx.autoRebase;
      return { state: 'PENDING', actions: [], reason: '' };
    };
    const buildContext = async () => ({ pr: '5', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master' });

    await shepherdCmd.handler(['5'], {}, process.cwd(), { runPass: fakeRun, buildContext });
    expect(seenAutoRebase).toBe(false);

    await shepherdCmd.handler(['5', '--auto-rebase'], {}, process.cwd(), { runPass: fakeRun, buildContext });
    expect(seenAutoRebase).toBe(true);
  });

  test('requires a PR argument', async () => {
    const out = await shepherdCmd.handler([], {}, process.cwd(), {
      runPass: async () => ({ state: 'PENDING' }),
      buildContext: async () => ({}),
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/pr/i);
  });

  test('defaultBuildContext derives base from the PR target, not the current checkout', async () => {
    const ghCalls = [];
    const gh = (cmd, args) => {
      ghCalls.push(args.join(' '));
      if (args.includes('pr') && args.includes('view')) {
        return JSON.stringify({ baseRefName: 'release/2.0' });
      }
      if (args.includes('repo') && args.includes('view')) {
        return JSON.stringify({ owner: { login: 'acme' }, name: 'widget' });
      }
      return '{}';
    };
    const git = () => 'origin\n';

    const ctx = await shepherdCmd.defaultBuildContext({ pr: '42', gh, git });

    expect(ctx.base).toBe('release/2.0');
    expect(ctx.baseRef).toBe('origin/release/2.0');
    expect(ctx.owner).toBe('acme');
    expect(ctx.repo).toBe('widget');
    // It MUST consult the PR, not just `gh repo view` defaultBranchRef.
    expect(ghCalls.some((c) => c.includes('pr view') && c.includes('42'))).toBe(true);
  });

  test('defaultBuildContext threads the worktree root through as ctx.cwd', async () => {
    const gh = (cmd, args) => {
      if (args.includes('pr') && args.includes('view')) {
        return JSON.stringify({ baseRefName: 'master' });
      }
      return JSON.stringify({ owner: { login: 'o' }, name: 'r' });
    };
    const git = () => 'origin\n';

    const ctx = await shepherdCmd.defaultBuildContext({
      pr: '9', gh, git, projectRoot: '/work/tree',
    });
    expect(ctx.cwd).toBe('/work/tree');
  });

  test('MERGE_READY result never carries a merge side-effect', async () => {
    const out = await shepherdCmd.handler(['7'], {}, process.cwd(), {
      runPass: async () => ({ state: 'MERGE_READY', actions: [], reason: 'ready' }),
      buildContext: async () => ({ pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master' }),
    });
    expect(out.state).toBe('MERGE_READY');
    expect((out.actions || []).some((a) => a.type === 'merge')).toBe(false);
  });
});
