'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');

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

describe('forge shepherd events — the agent-agnostic monitor pull surface', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const journal = require('../../lib/pr-monitor/journal');
  const { EVENT_TYPES: T } = require('../../lib/pr-monitor/events');

  const now = () => '2026-07-13T00:00:00.000Z';
  function snap() {
    return {
      repo: 'r', pr: '1', headSha: 'sha1', prState: 'OPEN', draft: false,
      verdict: { state: 'CLEAN-MERGEABLE', reason: null },
      checks: [], threads: [], reviews: [], comments: [], behind: 0, conflicts: false, degraded: [],
    };
  }

  let root; let dir;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'prmon-verb-')); dir = journal.journalDir({ root, repo: 'r', pr: '1' }); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('parseSince reads --since <seq>', () => {
    expect(shepherdCmd.parseSince(['events', '1', '--since', '7'])).toBe(7);
    expect(shepherdCmd.parseSince(['events', '1'])).toBe(0);
  });

  test('runs an inline pass and returns NDJSON events since the cursor', async () => {
    const res = await shepherdCmd.handleEvents(['events', '1', '--since', '0'], root, {
      dir, gather: async () => snap(), now, watcherRunning: () => false,
    });
    expect(res.success).toBe(true);
    expect(res.events.map((e) => e.type)).toEqual([T.VERDICT_CHANGED]);
    const parsed = res.output.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].seq).toBe(1);
  });

  test('a later poll with the advanced cursor returns nothing new', async () => {
    await shepherdCmd.handleEvents(['events', '1', '--since', '0'], root, { dir, gather: async () => snap(), now, watcherRunning: () => false });
    const res = await shepherdCmd.handleEvents(['events', '1', '--since', '1'], root, { dir, gather: async () => snap(), now, watcherRunning: () => false });
    expect(res.events).toEqual([]);
  });

  test('errors without a PR argument', async () => {
    const res = await shepherdCmd.handleEvents(['events'], root, { dir, gather: async () => snap() });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Usage/);
  });

  test('main handler routes the events subcommand', async () => {
    const res = await shepherdCmd.handler(['events', '1', '--since', '0'], {}, root, {
      dir, gather: async () => snap(), now, watcherRunning: () => false,
    });
    expect(res.success).toBe(true);
    expect(res.events).toBeDefined();
  });
});
