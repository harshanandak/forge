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

// Watcher authority whose lease/owner migration gate is EXACTLY complete — the
// only state in which pollEvents may run an inline pass.
const MIGRATED_GATE_OWNER = { readMigrationGate: async () => ({ ok: true, gate: { state: 'complete' } }) };

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

  test('preserves performed actions when durable convergence evidence fails', async () => {
    const actions = [{ type: 'rerunCheck', name: 'ci' }];
    const out = await shepherdCmd.handler(['123'], {}, process.cwd(), {
      ...CONVERGENCE_DEPS,
      runPass: async () => ({ state: 'PENDING', actions, reason: 'reran ci' }),
      collectConvergenceEvidence: async () => { throw new Error('Memory unavailable'); },
      buildContext: async () => ({
        pr: '123', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      }),
    });

    expect(out).toMatchObject({ success: false, state: 'INCOMPLETE', actions });
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
        return JSON.stringify({
          baseRefName: 'release/2.0', baseRefOid: 'b'.repeat(40), headRefOid: 'a'.repeat(40),
        });
      }
      if (args.includes('repo') && args.includes('view')) {
        return JSON.stringify({ nameWithOwner: 'fork/widget', parent: { nameWithOwner: 'acme/widget' } });
      }
      return '{}';
    };
    const git = () => 'origin\n';

    const ctx = await shepherdCmd.defaultBuildContext({ pr: '42', gh, git });

    expect(ctx.base).toBe('release/2.0');
    expect(ctx.baseRef).toBe('b'.repeat(40));
    expect(ctx.headSha).toBe('a'.repeat(40));
    expect(ctx.owner).toBe('acme');
    expect(ctx.repo).toBe('widget');
    expect(ghCalls.some((c) => c.includes('--repo acme/widget'))).toBe(true);
    // It MUST consult the PR, not just `gh repo view` defaultBranchRef.
    expect(ghCalls.some((c) => c.includes('pr view') && c.includes('42'))).toBe(true);
  });

  test('defaultBuildContext fails closed without an exact provider base commit', async () => {
    const gh = (_cmd, args) => {
      if (args.includes('pr') && args.includes('view')) {
        return JSON.stringify({ baseRefName: 'release/2.0', baseRefOid: 'not-a-commit' });
      }
      return JSON.stringify({ nameWithOwner: 'acme/widget', parent: null });
    };

    await expect(shepherdCmd.defaultBuildContext({ pr: '42', gh, git: () => 'origin\n' }))
      .rejects.toThrow(/base commit/i);
  });

  test('defaultBuildContext threads the worktree root through as ctx.cwd', async () => {
    const gh = (cmd, args) => {
      if (args.includes('pr') && args.includes('view')) {
        return JSON.stringify({ baseRefName: 'master', baseRefOid: 'b'.repeat(40) });
      }
      return JSON.stringify({ nameWithOwner: 'o/r', parent: null });
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
      buildContext: async () => ({
        pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
        headSha: 'a'.repeat(40), localHead: 'a'.repeat(40),
      }),
      git: (_command, args) => (args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : ''),
    });
    expect(out.state).toBe('MERGE_READY');
    expect((out.actions || []).some((a) => a.type === 'merge')).toBe(false);
    expect(out.handoff).toMatchObject({ next: 'merge', humanApprovalRequired: true });
  });

  test('keeps merge-ready remote state pending while durable continuation remains', async () => {
    let passes = 0;
    let evidenceCalls = 0;
    const out = await shepherdCmd.handler(['7'], {}, process.cwd(), {
      ...CONVERGENCE_DEPS,
      runPass: async () => (++passes === 1
        ? { state: 'MERGE_READY', actions: [], reason: 'ready', expectedHead: 'a'.repeat(40) }
        : { state: 'NEEDS_REVIEW', actions: [], reason: 'changed', expectedHead: 'a'.repeat(40) }),
      collectConvergenceEvidence: async () => {
        evidenceCalls += 1;
        return {
          deltas: [], deltaOverflow: false,
          receiptIds: Array.from({ length: 128 }, (_, index) => `receipt-${index}`),
          continuationPending: true, exactHead: 'a'.repeat(40),
        };
      },
      buildContext: async () => ({
        pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
        headSha: 'a'.repeat(40), localHead: 'a'.repeat(40),
      }),
      git: (_command, args) => (args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : ''),
    });

    expect(out).toMatchObject({
      success: true,
      state: 'PENDING',
      remoteState: 'MERGE_READY',
      continuationPending: true,
    });
    expect(passes).toBe(1);
    expect(evidenceCalls).toBe(1);
    expect(out.handoff).toBeUndefined();
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
        pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
        headSha: 'a'.repeat(40), localHead: 'a'.repeat(40),
      }),
      git: (_command, args) => (args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : ''),
    });

    expect(passes).toBe(2);
    expect(out).toMatchObject({ state: 'NEEDS_REVIEW', reason: 'new review feedback' });
    expect(out.handoff).toMatchObject({ next: 'review' });
  });

  test('persists a state change observed during merge-readiness confirmation', async () => {
    let passes = 0;
    let evidenceCalls = 0;
    const out = await shepherdCmd.handler(['7'], {}, process.cwd(), {
      ...CONVERGENCE_DEPS,
      runPass: async () => (++passes === 1
        ? { state: 'MERGE_READY', actions: [], reason: 'ready', expectedHead: 'a'.repeat(40) }
        : { state: 'MERGED', actions: [], reason: 'merged concurrently', expectedHead: 'a'.repeat(40) }),
      collectConvergenceEvidence: async () => {
        evidenceCalls += 1;
        return {
          deltas: [], deltaOverflow: false, receiptIds: [`receipt-${evidenceCalls}`],
          exactHead: 'a'.repeat(40), ...(evidenceCalls === 2 ? { terminalReceiptId: 'terminal-2' } : {}),
        };
      },
      buildContext: async () => ({
        pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
        headSha: 'a'.repeat(40), localHead: 'a'.repeat(40),
      }),
      git: (_command, args) => (args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : ''),
    });

    expect(evidenceCalls).toBe(2);
    expect(out).toMatchObject({ state: 'MERGED', terminalReceiptId: 'terminal-2', receiptIds: ['receipt-2'] });
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

  test('preserves an incomplete local preflight instead of reporting a pending remote result', async () => {
    const out = await shepherdCmd.handler(['7'], {}, process.cwd(), {
      ...CONVERGENCE_DEPS,
      runLocalPreflight: async () => ({
        status: 'INCOMPLETE', blocking: true, providers: {}, findings: [],
      }),
      runPass: async () => ({ state: 'MERGE_READY', actions: [], reason: 'remote ready' }),
      buildContext: async () => ({ pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master' }),
    });

    expect(out).toMatchObject({ state: 'INCOMPLETE', remoteState: 'MERGE_READY' });
    expect(out.success).toBe(false);
    expect(out.reason).toMatch(/local review preflight is incomplete/i);
  });

  test('fails closed when the checkout changes while local providers are running', async () => {
    const oldHead = 'a'.repeat(40);
    const newHead = 'b'.repeat(40);
    let dryRun;
    const out = await shepherdCmd.handler(['7'], {}, process.cwd(), {
      ...CONVERGENCE_DEPS,
      runLocalPreflight: async () => ({ status: 'PASS', blocking: false, providers: {}, findings: [] }),
      runPass: async context => {
        dryRun = context.dryRun;
        return { state: 'MERGE_READY', actions: [], reason: 'remote ready' };
      },
      buildContext: async () => ({
        pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
        headSha: oldHead, localHead: oldHead,
      }),
      git: (_command, args) => (args[0] === 'rev-parse' ? `${newHead}\n` : ''),
    });

    expect(dryRun).toBe(true);
    expect(out).toMatchObject({ success: false, state: 'INCOMPLETE', remoteState: 'MERGE_READY' });
    expect(out.localPreflight.findings[0].detail).toMatch(/changed during local review/i);
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

  test('forces an authoritative inline monitor pass even when a watcher is active', async () => {
    const head = 'a'.repeat(40);
    let observedOwnerRunning;
    const evidence = await shepherdCmd.collectConvergenceEvidence({
      args: ['7'], pr: '7', projectRoot: process.cwd(),
      context: { pr: '7', owner: 'o', repo: 'r', headSha: head },
      adapter: { readState: async () => ({ headSha: head }) },
      deps: {
        dir: 'journal-dir', gather: async () => ({}), store: {},
        monitorId: 'pr:o/r:7', ownerRunId: 'run-7', packetId: 'packet-7', subjectId: 'o/r#7',
        pollEvents: async input => {
          observedOwnerRunning = await input.isOwnerRunning();
          return {
            events: [], overflow: false, receiptIds: [], continuationPending: true,
            ranPass: !observedOwnerRunning,
          };
        },
      },
    });

    expect(observedOwnerRunning).toBe(false);
    expect(evidence.exactHead).toBe(head);
    expect(evidence.continuationPending).toBe(true);
  });

  test('rejects convergence evidence when the authoritative pass was skipped', async () => {
    const head = 'a'.repeat(40);
    const collect = (polled) => shepherdCmd.collectConvergenceEvidence({
      args: ['7'], pr: '7', projectRoot: process.cwd(),
      context: { pr: '7', owner: 'o', repo: 'r', headSha: head },
      adapter: { readState: async () => ({ headSha: head }) },
      deps: {
        dir: 'journal-dir', gather: async () => ({}), store: {},
        monitorId: 'pr:o/r:7', ownerRunId: 'run-7', packetId: 'packet-7', subjectId: 'o/r#7',
        pollEvents: async () => ({ events: [], overflow: false, receiptIds: [], ...polled }),
      },
    });

    // A quarantined/conflicting migration gate suppresses the forced pass.
    await expect(collect({ ranPass: false, migrationGateIncomplete: true }))
      .rejects.toThrow(/authoritative convergence pass did not run \(watcher migration gate incomplete\)/);
    // So does an unreadable authority.
    await expect(collect({ ranPass: false, authorityUnavailable: true }))
      .rejects.toThrow(/authoritative convergence pass did not run \(watcher authority unavailable\)/);
    // And a bare ranPass:false is never silently accepted.
    await expect(collect({ ranPass: false }))
      .rejects.toThrow(/authoritative convergence pass did not run \(pass suppressed\)/);
  });

  test('never emits a MERGE_READY handoff when the migration gate blocked the pass', async () => {
    const head = 'a'.repeat(40);
    const out = await shepherdCmd.handler(['7'], {}, process.cwd(), {
      ...CONVERGENCE_DEPS,
      collectConvergenceEvidence: shepherdCmd.collectConvergenceEvidence,
      pollEvents: async () => ({
        events: [], overflow: false, receiptIds: [], ranPass: false, migrationGateIncomplete: true,
      }),
      runPass: async () => ({ state: 'MERGE_READY', actions: [], reason: 'ready', expectedHead: head }),
      buildContext: async () => ({
        pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
        headSha: head, localHead: head,
      }),
      adapter: {
        id: 'test', kind: 'pr-state', name: 'test',
        readState: async () => ({ headSha: head }),
        readRequiredChecks: async () => [], readComments: async () => [],
        readDivergence: async () => ({}), detectConflicts: async () => false,
        rerunFailedChecks: async () => {}, replyToThread: async () => {},
      },
      store: {}, monitorId: 'pr:o/r:7', ownerRunId: 'run-7', packetId: 'packet-7', subjectId: 'o/r#7',
      resolveGitCommonDir: () => process.cwd(),
    });

    expect(out).toMatchObject({ success: false, state: 'INCOMPLETE', remoteState: 'MERGE_READY' });
    expect(out.reason).toMatch(/watcher migration gate incomplete/);
    expect(out.handoff).toBeUndefined();
  });

  test('compares exact heads case-insensitively at evidence and handoff fences', async () => {
    const lowerHead = 'abcdef0123456789abcdef0123456789abcdef01';
    const upperHead = lowerHead.toUpperCase();
    const out = await shepherdCmd.handler(['7'], {}, process.cwd(), {
      ...CONVERGENCE_DEPS,
      runPass: async () => ({ state: 'MERGE_READY', actions: [], reason: 'ready', expectedHead: upperHead }),
      collectConvergenceEvidence: shepherdCmd.collectConvergenceEvidence,
      pollEvents: async () => ({ events: [], overflow: false, receiptIds: [], ranPass: true }),
      buildContext: async () => ({
        pr: '7', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
        headSha: upperHead, localHead: upperHead,
      }),
      adapter: {
        id: 'test', kind: 'pr-state', name: 'test',
        readState: async () => ({ headSha: lowerHead }),
        readRequiredChecks: async () => [], readComments: async () => [],
        readDivergence: async () => ({}), detectConflicts: async () => false,
        rerunFailedChecks: async () => {}, replyToThread: async () => {},
      },
      store: {}, monitorId: 'pr:o/r:7', ownerRunId: 'run-7', packetId: 'packet-7', subjectId: 'o/r#7',
      git: (_command, args) => (args[0] === 'rev-parse' ? `${lowerHead}\n` : ''),
    });

    expect(out).toMatchObject({ success: true, state: 'MERGE_READY' });
    expect(out.handoff.command).toContain(`--expect-head ${lowerHead}`);
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
      git: (_command, args) => (args[0] === 'rev-parse' ? `${oldHead}\n` : ''),
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

  function publicMonitorDriver(appended) {
    return {
      appendMonitorEvent: async (event) => { appended.push(event); return { idempotent: false }; },
      getMonitorEvent: async eventId => {
        const event = appended.find(item => item.payload.event_id === eventId);
        return event ? { envelope_json: JSON.stringify(event), content_hash: event.content_hash } : null;
      },
      readMonitorEventTail: async () => ({
        events: [], overflow: false, truncated_before_sequence: null,
      }),
      readMonitorDeliveryState: async () => ({
        cursors: [], outbox: [], terminal_receipt: null,
        overflow: { cursors: false, outbox: false },
      }),
      recordMonitorDeliveryReceipt: async () => ({ idempotent: false }),
      recordMonitorTerminalReceipt: async () => ({ idempotent: false }),
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
      buildKernelDeps: async () => { throw new Error('journal fallback'); },
    });
    expect(built.dir).toBe(journal.journalDir({
      root: mainRoot, gitCommonDir, repo: 'r', pr: '1',
    }));
  });

  test('default monitor adapter keeps every PR read on the resolved upstream repository', async () => {
    const ghCalls = [];
    const emptyConnection = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
    const gh = (cmd, args) => {
      ghCalls.push({ cmd, args });
      const joined = args.join(' ');
      if (args[0] === 'pr' && args[1] === 'view' && joined.includes('--json commits')) {
        return '2026-08-19T10:00:00.000Z';
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          headRefOid: 'a'.repeat(40), state: 'OPEN', isDraft: false,
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [],
        });
      }
      if (args[0] === 'api' && joined.includes('protection/required_status_checks')) {
        return JSON.stringify({ contexts: [] });
      }
      if (args[0] === 'api' && joined.includes('reviewThreads(')) {
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: emptyConnection } } } });
      }
      if (args[0] === 'api' && joined.includes('comments(')) {
        return JSON.stringify({ data: { repository: { pullRequest: { comments: emptyConnection } } } });
      }
      if (args[0] === 'api' && joined.includes('reviews(')) {
        return JSON.stringify({ data: { repository: { pullRequest: { reviews: emptyConnection } } } });
      }
      return '';
    };
    const git = (_cmd, args) => (args[0] === 'rev-list' ? '0\t0' : '');
    const built = await shepherdCmd.buildMonitorContext('541', root, {
      gh,
      git,
      buildContext: async () => ({
        pr: '541', owner: 'upstream', repo: 'forge', base: 'master',
        baseRef: 'origin/master', cwd: root, prState: 'OPEN',
      }),
      resolveGitCommonDir: () => path.join(root, '.git'),
      buildKernelDeps: async () => { throw new Error('journal fallback'); },
    });

    await built.gather();

    const prReads = ghCalls.filter(call => call.cmd === 'gh'
      && call.args[0] === 'pr' && call.args[1] === 'view');
    expect(prReads).toHaveLength(3);
    for (const read of prReads) {
      expect(read.args).toEqual(expect.arrayContaining(['--repo', 'upstream/forge']));
    }
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

  test('hashes a private-shaped repository token across every Memory authority identity', async () => {
    const repo = `ghp_${'a'.repeat(20)}`;
    const appended = [];
    const driver = publicMonitorDriver(appended);
    const built = await shepherdCmd.buildMonitorContext('7', root, {
      forceAuthority: true,
      gather: async () => snap(),
      buildContext: async () => ({
        pr: '7', owner: 'acme', repo, base: 'master', baseRef: 'origin/master',
      }),
      adapter: new (require('../../lib/adapters/pr-state-adapter').PrStateAdapter)({ gh: () => '', git: () => '' }),
      resolveGitCommonDir: () => path.join(root, '.git'),
      buildKernelDeps: async () => ({ kernelDriver: driver, kernelBroker: { close: async () => {} } }),
    });

    for (const identity of [built.monitorId, built.ownerRunId, built.packetId, built.subjectId]) {
      expect(identity).not.toContain(repo);
      expect(identity).toMatch(/sha256:[0-9a-f]{64}/);
    }
    const { runFlowMonitorPass } = require('../../lib/pr-monitor/flow-monitor');
    await runFlowMonitorPass({ ...built, deliverLegacy: async () => {}, now });
    expect(appended).toHaveLength(1);
  });

  test('sanitizes complete Memory authority identities after composing repository and PR', async () => {
    const appended = [];
    const driver = publicMonitorDriver(appended);
    const built = await shepherdCmd.buildMonitorContext('12345678', root, {
      forceAuthority: true,
      gather: async () => snap(),
      buildContext: async () => ({
        pr: '12345678', owner: 'acme', repo: 'token', base: 'master', baseRef: 'origin/master',
      }),
      adapter: new (require('../../lib/adapters/pr-state-adapter').PrStateAdapter)({ gh: () => '', git: () => '' }),
      resolveGitCommonDir: () => path.join(root, '.git'),
      buildKernelDeps: async () => ({ kernelDriver: driver, kernelBroker: { close: async () => {} } }),
    });

    const { runFlowMonitorPass } = require('../../lib/pr-monitor/flow-monitor');
    await runFlowMonitorPass({ ...built, deliverLegacy: async () => {}, now });
    expect(appended).toHaveLength(1);
  });

  test('falls back to the per-root journal when Memory authority initialization fails', async () => {
    let attempted = 0;
    const built = await shepherdCmd.buildMonitorContext('7', root, {
      buildContext: async () => ({
        pr: '7', owner: 'acme', repo: 'forge', base: 'master', baseRef: 'origin/master',
      }),
      adapter: new (require('../../lib/adapters/pr-state-adapter').PrStateAdapter)({ gh: () => '', git: () => '' }),
      resolveGitCommonDir: () => path.join(root, '.git'),
      buildKernelDeps: async () => { attempted += 1; throw new Error('kernel unavailable'); },
    });

    expect(attempted).toBe(1);
    expect(built.error).toBeUndefined();
    expect(built.store).toBeUndefined();
    expect(built.dir).toBeString();
  });

  test('fails closed when forced Memory authority initialization fails', async () => {
    const built = await shepherdCmd.buildMonitorContext('7', root, {
      forceAuthority: true,
      buildContext: async () => ({
        pr: '7', owner: 'acme', repo: 'forge', base: 'master', baseRef: 'origin/master',
      }),
      adapter: new (require('../../lib/adapters/pr-state-adapter').PrStateAdapter)({ gh: () => '', git: () => '' }),
      resolveGitCommonDir: () => path.join(root, '.git'),
      buildKernelDeps: async () => { throw new Error('kernel unavailable'); },
    });

    expect(built.error).toMatch(/durable monitor authority.*unavailable/i);
    expect(built.store).toBeUndefined();
  });

  test('hashes an oversized root monitor identity within the public Memory bound', async () => {
    const owner = 'o'.repeat(70);
    const repo = 'r'.repeat(70);
    const built = await shepherdCmd.buildMonitorContext('7', root, {
      buildContext: async () => ({
        pr: '7', owner, repo, base: 'master', baseRef: 'origin/master',
      }),
      adapter: new (require('../../lib/adapters/pr-state-adapter').PrStateAdapter)({ gh: () => '', git: () => '' }),
      resolveGitCommonDir: () => path.join(root, '.git'),
      buildKernelDeps: async () => ({ kernelDriver: {}, kernelBroker: { close: async () => {} } }),
      createMonitorStore: () => ({}),
    });

    expect(built.monitorId.length).toBeLessThanOrEqual(128);
    expect(built.monitorId).toMatch(/^pr:[0-9a-f]{64}$/);
  });

  test('runs an inline pass and returns NDJSON events since the cursor', async () => {
    const res = await shepherdCmd.handleEvents(['events', '1', '--since', '0'], root, {
      dir, gather: async () => snap(), now, isOwnerRunning: async () => false,
      owner: MIGRATED_GATE_OWNER,
    });
    expect(res.success).toBe(true);
    expect(res.events.map((e) => e.type)).toEqual([T.VERDICT_CHANGED]);
    const parsed = res.output.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].seq).toBe(1);
  });

  test.each([
    ['tagged failure', async () => ({ ok: false, reason: 'authority_unavailable' })],
    ['provider exception', async () => { throw new Error('authority unavailable'); }],
  ])('does not run an inline events pass when watcher authority returns a %s', async (_case, readOwner) => {
    let gathered = 0;
    const res = await shepherdCmd.handleEvents(['events', '1', '--since', '0'], root, {
      dir,
      gather: async () => {
        gathered += 1;
        return snap();
      },
      repository: 'acme/forge',
      ownerOptions: { driver: {} },
      owner: { readOwner },
    });

    expect(res.success).toBe(true);
    expect(gathered).toBe(0);
  });

  test.each([4242, null])('does not run an inline events pass for a blocked owner with watcher PID %s', async (watcherPid) => {
    let gathered = 0;
    const res = await shepherdCmd.handleEvents(['events', '1', '--since', '0'], root, {
      dir,
      gather: async () => {
        gathered += 1;
        return snap();
      },
      repository: 'acme/forge',
      ownerOptions: { driver: {} },
      owner: {
        readOwner: async () => ({
          ok: true,
          record: { phase: 'blocked', watcherPid },
        }),
      },
    });

    expect(res.success).toBe(true);
    expect(gathered).toBe(0);
  });

  test('runs an inline events pass for a proven absent owner', async () => {
	const record = null;
    let gathered = 0;
    const res = await shepherdCmd.handleEvents(['events', '1', '--since', '0'], root, {
      dir,
      gather: async () => {
        gathered += 1;
        return snap();
      },
      repository: 'acme/forge',
      ownerOptions: { driver: {} },
      owner: { ...MIGRATED_GATE_OWNER, readOwner: async () => ({ ok: true, record }) },
    });

    expect(res.success).toBe(true);
    expect(gathered).toBe(1);
  });

  test('owner-running probe normalizes a malformed success to boolean false', async () => {
    let observed;
    const res = await shepherdCmd.handleEvents(['events', '1'], root, {
      dir,
      gather: async () => snap(),
      isOwnerRunning: async () => ({ ok: true, record: { phase: { invalid: true } } }),
      pollEvents: async (input) => {
        observed = await input.isOwnerRunning();
        return { events: [], since: 0, overflow: false, receiptIds: [] };
      },
    });

    expect(res.success).toBe(true);
    expect(typeof observed).toBe('boolean');
    expect(observed).toBe(false);
  });

  test.each([
    ['literal true', true, true],
    ['truthy envelope', { ok: true }, false],
  ])('normalizes an injected owner-running probe from %s', async (_case, providerValue, expected) => {
    let observed;
    const res = await shepherdCmd.handleEvents(['events', '1'], root, {
      dir,
      gather: async () => snap(),
      isOwnerRunning: async () => providerValue,
      pollEvents: async (input) => {
        observed = await input.isOwnerRunning();
        return { events: [], since: 0, overflow: false, receiptIds: [] };
      },
    });

    expect(res.success).toBe(true);
    expect(observed).toBe(expected);
    expect(typeof observed).toBe('boolean');
  });

  test('a later poll with the advanced cursor returns nothing new', async () => {
    await shepherdCmd.handleEvents(['events', '1', '--since', '0'], root, { dir, gather: async () => snap(), now, isOwnerRunning: async () => false });
    const res = await shepherdCmd.handleEvents(['events', '1', '--since', '1'], root, { dir, gather: async () => snap(), now, isOwnerRunning: async () => false });
    expect(res.events).toEqual([]);
  });

  test('surfaces a bounded overflow control record when the pull cursor is truncated', async () => {
    const event = { seq: 13, type: T.VERDICT_CHANGED, key: 'state:13', data: {} };
    const res = await shepherdCmd.handleEvents(['events', '1', '--since', '0'], root, {
      dir, gather: async () => snap(),
      pollEvents: async () => ({ events: [event], since: 0, overflow: true, receiptIds: [] }),
    });

    expect(res.overflow).toBe(true);
    const records = res.output.split('\n').map(line => JSON.parse(line));
    expect(records[0]).toMatchObject({
      type: 'monitor.overflow', since: 0, firstAvailableSeq: 13,
    });
    expect(records[1]).toEqual(event);
  });

  test('errors without a PR argument', async () => {
    const res = await shepherdCmd.handleEvents(['events'], root, { dir, gather: async () => snap() });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Usage/);
  });

  test('main handler routes the events subcommand', async () => {
    const res = await shepherdCmd.handler(['events', '1', '--since', '0'], {}, root, {
      dir, gather: async () => snap(), now, isOwnerRunning: async () => false,
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
      dir, gather: async () => green, now, isOwnerRunning: async () => false, gatherPull,
      owner: MIGRATED_GATE_OWNER,
    });
    // Transition to failed → check.failed emitted and enriched by the default hook.
    const res = await shepherdCmd.handleEvents(['events', '1', '--since', '1'], root, {
      dir, gather: async () => failed, now, isOwnerRunning: async () => false, gatherPull,
      owner: MIGRATED_GATE_OWNER,
    });
    const cf = res.events.find((e) => e.type === T.CHECK_FAILED);
    expect(cf).toBeDefined();
    expect(cf.data.excerpt).toBe('AssertionError: boom');
    expect(cf.data.jobUrl).toBe('https://ci/job/1');
  });

  test('unsafe CI excerpts are omitted before durable monitor persistence', async () => {
    const records = [{ type: T.CHECK_FAILED, data: { name: 'ci' } }];
    const enrich = shepherdCmd.makeCheckFailureEnricher({
      gatherPull: async () => ({
        failures: [{
          name: 'ci',
          excerpt: 'failure at /home/runner/work/private-repo/build.js\ntoken=super-secret-value',
          jobUrl: 'https://github.com/acme/forge/actions/runs/1/job/2',
        }],
      }),
    });

    await enrich(records);

    expect(records[0].data.excerpt).toBeUndefined();
    expect(records[0].data.jobUrl).toBe('https://github.com/acme/forge/actions/runs/1/job/2');
  });
});
