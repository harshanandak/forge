'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');

const shepherdCmd = require('../../lib/commands/shepherd');
const { validateCommand } = require('../../lib/commands/_registry');

const CONVERGENCE_DEPS = {
  runLocalPreflight: async () => ({ status: 'PASS', blocking: false, providers: {}, findings: [] }),
  collectConvergenceEvidence: async () => ({
    deltas: [], deltaOverflow: false, receiptIds: [], exactHead: 'a'.repeat(40),
  }),
};

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
      ...CONVERGENCE_DEPS,
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

    await shepherdCmd.handler(['5'], {}, process.cwd(), { ...CONVERGENCE_DEPS, runPass: fakeRun, buildContext });
    expect(seenAutoRebase).toBe(false);

    await shepherdCmd.handler(['5', '--auto-rebase'], {}, process.cwd(), { ...CONVERGENCE_DEPS, runPass: fakeRun, buildContext });
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
        return JSON.stringify({ baseRefName: 'release/2.0', headRefOid: 'a'.repeat(40) });
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
    expect(ctx.headSha).toBe('a'.repeat(40));
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
      ...CONVERGENCE_DEPS,
      runPass: async () => ({
        state: 'MERGE_READY', actions: [], reason: 'ready', expectedHead: 'a'.repeat(40),
      }),
      buildContext: async () => ({ pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master' }),
    });
    expect(out.state).toBe('MERGE_READY');
    expect((out.actions || []).some((a) => a.type === 'merge')).toBe(false);
    expect(out.handoff).toMatchObject({ next: 'merge', humanApprovalRequired: true });
  });

  test('reconfirms mutable PR evidence before returning a merge handoff', async () => {
    let passes = 0;
    const out = await shepherdCmd.handler(['7'], {}, process.cwd(), {
      ...CONVERGENCE_DEPS,
      runPass: async () => {
        passes += 1;
        return passes === 1
          ? { state: 'MERGE_READY', actions: [], reason: 'ready', expectedHead: 'a'.repeat(40) }
          : { state: 'NEEDS_REVIEW', actions: [], reason: 'new review feedback' };
      },
      buildContext: async () => ({
        pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master', headSha: 'a'.repeat(40),
      }),
    });

    expect(passes).toBe(2);
    expect(out).toMatchObject({ state: 'NEEDS_REVIEW', reason: 'new review feedback' });
    expect(out.handoff).toMatchObject({ next: 'review' });
  });

  test('consolidates blocking local findings before a read-only remote decision', async () => {
    let dryRun;
    const out = await shepherdCmd.handler(['7'], {}, process.cwd(), {
      ...CONVERGENCE_DEPS,
      runLocalPreflight: async () => ({
        status: 'FAIL', blocking: true, providers: {},
        findings: [{ provider: 'lint', detail: 'error' }],
      }),
      runPass: async (context) => {
        dryRun = context.dryRun;
        return { state: 'MERGE_READY', actions: [], reason: 'remote ready' };
      },
      buildContext: async () => ({ pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master' }),
    });

    expect(dryRun).toBe(true);
    expect(out).toMatchObject({ state: 'PENDING', remoteState: 'MERGE_READY' });
    expect(out.localPreflight.findings).toEqual([{ provider: 'lint', detail: 'error' }]);
  });

  test('fails closed when the PR head changes immediately before merge handoff', async () => {
    const oldHead = 'a'.repeat(40);
    const newHead = 'b'.repeat(40);
    const out = await shepherdCmd.handler(['7'], {}, process.cwd(), {
      ...CONVERGENCE_DEPS,
      collectConvergenceEvidence: shepherdCmd.collectConvergenceEvidence,
      pollEvents: async () => ({ events: [], overflow: false, receiptIds: [] }),
      runPass: async () => ({ state: 'MERGE_READY', actions: [], reason: 'ready' }),
      buildContext: async () => ({
        pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master', headSha: oldHead,
      }),
      adapter: {
        id: 'test', kind: 'pr-state', name: 'test',
        readState: async () => ({ headSha: newHead }),
        readRequiredChecks: async () => [], readComments: async () => [],
        readDivergence: async () => ({}), detectConflicts: async () => false,
        rerunFailedChecks: async () => {}, replyToThread: async () => {},
      },
      store: {}, monitorId: 'pr:o/r:7', ownerRunId: 'run-7', packetId: 'packet-7', subjectId: 'o/r#7',
      resolveGitCommonDir: () => process.cwd(),
    });

    expect(out).toMatchObject({ success: false, state: 'INCOMPLETE', remoteState: 'MERGE_READY' });
    expect(out.reason).toMatch(/head changed/i);
    expect(out.handoff).toBeUndefined();
  });

  test('fails closed when a merge-ready pass moved beyond the locally reviewed head', async () => {
    const oldHead = 'a'.repeat(40);
    const newHead = 'b'.repeat(40);
    const out = await shepherdCmd.handler(['7'], {}, process.cwd(), {
      ...CONVERGENCE_DEPS,
      runPass: async () => ({ state: 'MERGE_READY', actions: [], reason: 'ready', expectedHead: newHead }),
      collectConvergenceEvidence: async () => ({
        deltas: [], deltaOverflow: false, receiptIds: [], exactHead: newHead,
      }),
      buildContext: async () => ({
        pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
        headSha: oldHead, localHead: oldHead,
      }),
      git: () => '',
    });

    expect(out).toMatchObject({ success: false, state: 'INCOMPLETE', remoteState: 'MERGE_READY' });
    expect(out.reason).toMatch(/local preflight.*head changed/i);
    expect(out.handoff).toBeUndefined();
  });

  test('uses the pass-verified post-rebase head for convergence evidence', async () => {
    const oldHead = 'a'.repeat(40);
    const newHead = 'b'.repeat(40);
    let evidenceHead;
    const out = await shepherdCmd.handler(['7', '--auto-rebase'], {}, process.cwd(), {
      ...CONVERGENCE_DEPS,
      runPass: async () => ({ state: 'PENDING', actions: [{ type: 'rebase' }], expectedHead: newHead }),
      collectConvergenceEvidence: async ({ context }) => {
        evidenceHead = context.headSha;
        return { deltas: [], deltaOverflow: false, receiptIds: [], exactHead: context.headSha };
      },
      buildContext: async () => ({
        pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master', headSha: oldHead,
      }),
    });
    expect(out.success).toBe(true);
    expect(evidenceHead).toBe(newHead);
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

  test('events resolves the shared journal owned by the git common dir', async () => {
    const mainRoot = path.join(root, 'main');
    const worktreeRoot = path.join(root, 'feature');
    const gitCommonDir = path.join(mainRoot, '.git');
    const { PrStateAdapter } = require('../../lib/adapters/pr-state-adapter');
    const adapter = new PrStateAdapter({ gh: () => '', git: () => '' });
    const built = await shepherdCmd.buildMonitorContext('1', worktreeRoot, {
      adapter,
      buildContext: async () => ({
        pr: '1', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      }),
      resolveGitCommonDir: () => gitCommonDir,
    });
    expect(built.dir).toBe(journal.journalDir({
      root: mainRoot, gitCommonDir, repo: 'r', pr: '1',
    }));
  });

  test('live monitor context builds the public Memory authority with stable Flow identity', async () => {
    const store = { kind: 'monitor-store' };
    let closed = false;
    const built = await shepherdCmd.buildMonitorContext('7', root, {
      buildContext: async () => ({
        pr: '7', owner: 'acme', repo: 'forge', base: 'master', baseRef: 'origin/master',
      }),
      adapter: new (require('../../lib/adapters/pr-state-adapter').PrStateAdapter)({ gh: () => '', git: () => '' }),
      resolveGitCommonDir: () => path.join(root, '.git'),
      buildKernelDeps: async () => ({ kernelDriver: {}, kernelBroker: { close: async () => { closed = true; } } }),
      createMonitorStore: () => store,
    });

    expect(built).toMatchObject({
      store,
      monitorId: 'pr:acme/forge:7',
      ownerRunId: 'shepherd:acme/forge:7',
      packetId: 'shepherd-packet:acme/forge:7',
      subjectId: 'acme/forge#7',
    });
    await built.close();
    expect(closed).toBe(true);
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

  test('the events command enriches check.failed with the documented log excerpt', async () => {
    // Regression: handleEvents must supply the DEFAULT failed-check enrichment,
    // not only forward an injected one — otherwise a plain `forge shepherd events`
    // emits bare check.failed events with no data.excerpt.
    const green = { ...snap(), checks: [{ name: 'ci', class: 'green' }] };
    const failed = { ...snap(), checks: [{ name: 'ci', class: 'failed' }] };
    const gatherPull = async () => ({
      failures: [{ name: 'ci', excerpt: 'AssertionError: boom', jobUrl: 'https://ci/job/1' }],
    });
    // Baseline pass (green) establishes the snapshot; no check.failed yet.
    await shepherdCmd.handleEvents(['events', '1', '--since', '0'], root, {
      dir, gather: async () => green, now, watcherRunning: () => false, gatherPull,
    });
    // Transition to failed → check.failed emitted and enriched by the default hook.
    const res = await shepherdCmd.handleEvents(['events', '1', '--since', '1'], root, {
      dir, gather: async () => failed, now, watcherRunning: () => false, gatherPull,
    });
    const cf = res.events.find((e) => e.type === T.CHECK_FAILED);
    expect(cf).toBeDefined();
    expect(cf.data.excerpt).toBe('AssertionError: boom');
    expect(cf.data.jobUrl).toBe('https://ci/job/1');
  });
});
