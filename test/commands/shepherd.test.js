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

  test('MERGE_READY result never carries a merge side-effect', async () => {
    const out = await shepherdCmd.handler(['7'], {}, process.cwd(), {
      runPass: async () => ({ state: 'MERGE_READY', actions: [], reason: 'ready' }),
      buildContext: async () => ({ pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master' }),
    });
    expect(out.state).toBe('MERGE_READY');
    expect((out.actions || []).some((a) => a.type === 'merge')).toBe(false);
  });
});
