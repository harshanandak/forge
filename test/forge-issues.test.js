'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_LEASE_TTL_MS } = require('../lib/kernel/lease-enforcer');

describe('forge issue service contract', () => {
  test('exports service factory and operation runner', () => {
    const forgeIssues = require('../lib/forge-issues');

    expect(typeof forgeIssues.createIssueService).toBe('function');
    expect(typeof forgeIssues.createKernelIssueBackend).toBe('function');
    expect(typeof forgeIssues.runIssueOperation).toBe('function');
  });

  test('routes supported operations through the configured backend', async () => {
    const { createIssueService } = require('../lib/forge-issues');
    const calls = [];
    const backend = {
      async create(args, context) {
        calls.push({ operation: 'create', args, context });
        return { success: true, operation: 'create' };
      },
      async list(args, context) {
        calls.push({ operation: 'list', args, context });
        return { success: true, operation: 'list' };
      },
      async show(args, context) {
        calls.push({ operation: 'show', args, context });
        return { success: true, operation: 'show' };
      },
      async close(args, context) {
        calls.push({ operation: 'close', args, context });
        return { success: true, operation: 'close' };
      },
      async update(args, context) {
        calls.push({ operation: 'update', args, context });
        return { success: true, operation: 'update' };
      },
    };

    const service = createIssueService({ backend });
    const context = { projectRoot: '/repo', deps: { source: 'test' } };

    await expect(service.run('create', ['--title', 'Test'], context))
      .resolves.toEqual({ success: true, operation: 'create' });
    await expect(service.run('list', ['--json'], context))
      .resolves.toEqual({ success: true, operation: 'list' });
    await expect(service.run('show', ['forge-123'], context))
      .resolves.toEqual({ success: true, operation: 'show' });
    await expect(service.run('close', ['forge-123'], context))
      .resolves.toEqual({ success: true, operation: 'close' });
    await expect(service.run('update', ['forge-123', '--title', 'Renamed'], context))
      .resolves.toEqual({ success: true, operation: 'update' });

    expect(calls).toHaveLength(5);
    expect(calls[0]).toEqual({
      operation: 'create',
      args: ['--title', 'Test'],
      context,
    });
    expect(calls[4]).toEqual({
      operation: 'update',
      args: ['forge-123', '--title', 'Renamed'],
      context,
    });
  });

  test('routes Kernel issue command contract operations through backend aliases', async () => {
    const { createIssueService } = require('../lib/forge-issues');
    const calls = [];
    const backend = {
      async search(args, context) {
        calls.push({ method: 'search', args, context });
        return { success: true, operation: 'search' };
      },
      async stats(args, context) {
        calls.push({ method: 'stats', args, context });
        return { success: true, operation: 'stats' };
      },
      async claim(args, context) {
        calls.push({ method: 'claim', args, context });
        return { success: true, operation: 'claim' };
      },
      async release(args, context) {
        calls.push({ method: 'release', args, context });
        return { success: true, operation: 'release' };
      },
      async depAdd(args, context) {
        calls.push({ method: 'depAdd', args, context });
        return { success: true, operation: 'dep.add' };
      },
      async depRemove(args, context) {
        calls.push({ method: 'depRemove', args, context });
        return { success: true, operation: 'dep.remove' };
      },
    };
    const context = { projectRoot: '/repo' };
    const service = createIssueService({ backend });

    await expect(service.run('search', ['kernel'], context))
      .resolves.toEqual({ success: true, operation: 'search' });
    await expect(service.run('stats', ['--json'], context))
      .resolves.toEqual({ success: true, operation: 'stats' });
    await expect(service.run('claim', ['forge-1'], context))
      .resolves.toEqual({ success: true, operation: 'claim' });
    await expect(service.run('release', ['forge-1'], context))
      .resolves.toEqual({ success: true, operation: 'release' });
    await expect(service.run('dep.add', ['forge-1', 'forge-2'], context))
      .resolves.toEqual({ success: true, operation: 'dep.add' });
    await expect(service.run('dep.remove', ['forge-1', 'forge-2'], context))
      .resolves.toEqual({ success: true, operation: 'dep.remove' });

    expect(calls.map(call => call.method)).toEqual([
      'search',
      'stats',
      'claim',
      'release',
      'depAdd',
      'depRemove',
    ]);
  });

  test('rejects unsupported operations with a forge-level error', async () => {
    const { createIssueService } = require('../lib/forge-issues');

    const service = createIssueService({
      backend: {
        async list() {
          return { success: true };
        },
      },
    });

    await expect(service.run('ready', [], { projectRoot: '/repo' })).resolves.toEqual({
      success: false,
      error: 'Unsupported issue operation: ready',
    });
  });

  test('preserves backend method binding during operation dispatch', async () => {
    const { createIssueService } = require('../lib/forge-issues');

    class TestBackend {
      constructor() {
        this.prefix = 'backend-bound';
      }

      async show(args) {
        return {
          success: true,
          output: `${this.prefix}:${args[0]}`,
        };
      }
    }

    const service = createIssueService({ backend: new TestBackend() });

    await expect(service.run('show', ['forge-123'], { projectRoot: '/repo' })).resolves.toEqual({
      success: true,
      output: 'backend-bound:forge-123',
    });
  });

  test('maps legacy show dispatch to the IssueAdapter read contract', async () => {
    const { createIssueService } = require('../lib/forge-issues');
    const calls = [];
    const adapter = {
      async read(args, context) {
        calls.push({ args, context, thisRef: this });
        return { success: true, output: `read:${args[0]}` };
      },
    };

    const context = { projectRoot: '/repo' };
    const service = createIssueService({ backend: adapter });

    await expect(service.run('show', ['forge-123'], context)).resolves.toEqual({
      success: true,
      output: 'read:forge-123',
    });
    expect(calls).toEqual([{
      args: ['forge-123'],
      context,
      thisRef: adapter,
    }]);
  });

  test('uses dependency injection in the top-level operation runner', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    const calls = [];

    const result = await runIssueOperation('show', ['forge-456'], '/repo', {
      createService: () => ({
        async run(operation, args, context) {
          calls.push({ operation, args, context });
          return { success: true, output: 'ok' };
        },
      }),
      marker: 'injected',
    });

    expect(result).toEqual({ success: true, output: 'ok' });
    expect(calls).toEqual([{
      operation: 'show',
      args: ['forge-456'],
      context: {
        projectRoot: '/repo',
        deps: { createService: expect.any(Function), marker: 'injected' },
        // Now that the kernel is the only backend the projection-outbox target is
        // unconditional — every mutation must land in the 'jsonl' outbox that
        // `forge export` drains (previously gated on the kernel selector, so a
        // deps-less caller silently enqueued under the legacy 'beads' target).
        projectionTarget: 'jsonl',
      },
    }]);
  });

  test('threads session_id, worktree_id, and lease TTL into the claim mutation context (kernel d71a824b)', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    let captured;
    await runIssueOperation('claim', ['issue-1'], '/repo', {
      createService: () => ({
        async run(operation, args, context) {
          captured = context;
          return { success: true, ok: true };
        },
      }),
      // Env drives session_id + the worktree override; detectWorktree is injected so the
      // test never shells out to git. Default TTL applies (no FORGE_LEASE_TTL_MS).
      env: { FORGE_SESSION_ID: 'sess-boundary', FORGE_WORKTREE_ID: 'wt-boundary' },
    });
    expect(captured.sessionId).toBe('sess-boundary');
    expect(captured.worktreeId).toBe('wt-boundary');
    expect(captured.leaseTtlMs).toBe(DEFAULT_LEASE_TTL_MS);
  });

  test('a read op (show) does NOT resolve a worktree id or lease TTL (claim-only cost)', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    let captured;
    await runIssueOperation('show', ['issue-1'], '/repo', {
      createService: () => ({
        async run(operation, args, context) {
          captured = context;
          return { success: true };
        },
      }),
      env: { FORGE_WORKTREE_ID: 'wt-boundary' },
    });
    expect(captured.worktreeId).toBeUndefined();
    expect(captured.leaseTtlMs).toBeUndefined();
  });

  test('FORGE_LEASE_TTL_MS=0 opts out of expiry (null lease), omitting leaseTtlMs from context', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    let captured;
    await runIssueOperation('claim', ['issue-1'], '/repo', {
      createService: () => ({
        async run(operation, args, context) {
          captured = context;
          return { success: true, ok: true };
        },
      }),
      env: { FORGE_WORKTREE_ID: 'wt-boundary', FORGE_LEASE_TTL_MS: '0' },
    });
    expect(captured.leaseTtlMs).toBeUndefined();
  });

  test('top-level operation runner selects the Kernel broker backend when requested', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    const calls = [];

    const result = await runIssueOperation('comment', ['forge-1', 'handoff note'], '/repo', {
      useKernelBroker: true,
      createKernelBroker: (context) => ({
        async runIssueOperation(operation, args, operationContext) {
          calls.push({ context, operation, args, operationContext });
          return { success: true, operation, output: 'kernel ok' };
        },
      }),
      isBeadsInitialized: () => {
        throw new Error('Beads should not be consulted for Kernel broker operations');
      },
    });

    expect(result).toEqual({ success: true, operation: 'comment', output: 'kernel ok' });
    expect(calls).toEqual([{
      context: {
        projectRoot: '/repo',
        deps: expect.objectContaining({ useKernelBroker: true }),
      },
      operation: 'comment',
      args: ['forge-1', 'handoff note'],
      operationContext: {
        projectRoot: '/repo',
        deps: expect.objectContaining({ useKernelBroker: true }),
        // Kernel mutations steer the projection-outbox marker to the 'jsonl' target
        // that `forge export` (D16) drains; the broker primitive default is 'beads'.
        projectionTarget: 'jsonl',
      },
    }]);
  });

  test('create args (incl. a mapped --title) reach the Kernel broker verbatim', async () => {
    // The positional→--title mapping lives in the command layer (_issue.js); this
    // layer is a faithful passthrough. Assert the already-resolved create args —
    // including the injected --title — reach the broker untouched, so the mapped
    // title is honored end-to-end.
    const { runIssueOperation } = require('../lib/forge-issues');
    const calls = [];

    const result = await runIssueOperation('create', ['--title', 'my title', '--type', 'task'], '/repo', {
      useKernelBroker: true,
      createKernelBroker: () => ({
        async runIssueOperation(operation, args) {
          calls.push({ operation, args });
          return { ok: true, data: { id: 'k1', title: 'my title' } };
        },
      }),
    });

    expect(result).toEqual({ ok: true, data: { id: 'k1', title: 'my title' } });
    expect(calls).toEqual([{ operation: 'create', args: ['--title', 'my title', '--type', 'task'] }]);
  });

  test('the beads backend is gone: no adapter factory, no bd argv helpers', () => {
    const forgeIssues = require('../lib/forge-issues');

    // Removing the export is what makes the removal real — a lingering
    // createBeadsIssueBackend/runBeadsOperation would let a caller reach bd again.
    for (const removed of [
      'createBeadsIssueBackend',
      'runBeadsOperation',
      'runBdCommand',
      'buildBdArgs',
      'getBdCommandCandidates',
      'getPathEntries',
      'resolveBeadsFallbackToKernel',
      'resolveWindowsCommandCandidates',
      'extractErrorMessage',
      'getCommandErrorMessage',
    ]) {
      expect(forgeIssues[removed]).toBeUndefined();
    }
  });

  test('the beads adapter module no longer exists', () => {
    expect(() => require('../lib/adapters/beads-issue-adapter')).toThrow(/Cannot find module/);
  });

  test('an explicit beads selection still dispatches to the kernel (no bd spawn)', async () => {
    // The selector is resolved upstream (_resolve-command-opts hard-errors on the
    // flag; env/config warn + fall back), so anything that still reaches the service
    // layer carrying issueBackend:'beads' must land on the kernel rather than bd.
    const { runIssueOperation } = require('../lib/forge-issues');
    const calls = [];

    const result = await runIssueOperation('list', ['--json'], '/repo', {
      issueBackend: 'beads',
      kernelBroker: {
        async runIssueOperation(operation, args) {
          calls.push({ operation, args });
          return { ok: true, data: { issues: [] } };
        },
      },
    });

    expect(result).toEqual({ ok: true, data: { issues: [] } });
    expect(calls).toEqual([{ operation: 'list', args: ['--json'] }]);
  });
});

describe('runIssueOperation kernel auto-init', () => {
  function makeKernelDeps() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-kernel-db-'));
    const gitCommonDir = path.join(dir, '.git');
    fs.mkdirSync(gitCommonDir, { recursive: true });
    return {
      dir,
      deps: {
        issueBackend: 'kernel',
        gitCommonDir,
        kernelDatabasePath: path.join(gitCommonDir, 'forge', 'kernel.sqlite'),
      },
    };
  }

  test('auto-initializes a fresh kernel DB and round-trips create -> ready', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    const { dir, deps } = makeKernelDeps();

    try {
      const created = await runIssueOperation(
        'create',
        ['--title', 'Kernel dogfood smoke', '--type', 'task'],
        dir,
        deps,
      );
      expect(created.ok).toBe(true);
      expect(typeof created.data.id).toBe('string');

      const ready = await runIssueOperation('ready', [], dir, deps);
      expect(ready.ok).toBe(true);
      const ids = ready.data.issues.map((issue) => issue.id);
      expect(ids).toContain(created.data.id);
    } finally {
      // Best-effort temp cleanup. The builtin SQLite driver holds the DB file open
      // for the process lifetime, so on Windows rmSync can hit EBUSY/EPERM during
      // teardown. The DB round-trip above is the assertion under test; a locked-file
      // cleanup failure must not mask it, and never re-throws from finally.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore: temp dir is reclaimed by the OS; cleanup is not the assertion.
      }
    }
  }, 20000);

  test('lazily initializes the broker only once across multiple operations', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    let initializeCalls = 0;
    const ops = [];
    const sharedBroker = {
      async initialize() {
        initializeCalls += 1;
        return { success: true };
      },
      async runIssueOperation(operation, args, context) {
        ops.push({ operation, args, context });
        return { ok: true, command: operation, data: {} };
      },
    };

    const deps = {
      issueBackend: 'kernel',
      kernelBroker: sharedBroker,
    };

    await runIssueOperation('create', ['--title', 'x'], '/repo', deps);
    await runIssueOperation('ready', [], '/repo', deps);

    expect(initializeCalls).toBe(1);
    expect(ops.map((op) => op.operation)).toEqual(['create', 'ready']);
  });

  test('does not require initialize() on injected brokers that lack it', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');

    const result = await runIssueOperation('ready', [], '/repo', {
      useKernelBroker: true,
      createKernelBroker: () => ({
        async runIssueOperation(operation) {
          return { ok: true, command: operation, data: { issues: [] } };
        },
      }),
    });

    expect(result).toEqual({ ok: true, command: 'ready', data: { issues: [] } });
  });
});

describe('runIssueOperation per-agent actor identity (kernel)', () => {
  function makeKernelDeps() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-kernel-actor-'));
    const gitCommonDir = path.join(dir, '.git');
    fs.mkdirSync(gitCommonDir, { recursive: true });
    return {
      dir,
      deps: {
        issueBackend: 'kernel',
        gitCommonDir,
        kernelDatabasePath: path.join(gitCommonDir, 'forge', 'kernel.sqlite'),
      },
    };
  }

  // Regression for kernel d71a824b: the CLI issue path wired NO per-agent identity into
  // the kernel context, so every agent claimed as the 'forge' default. Two distinct
  // agents therefore produced the SAME `claim.create:<id>:forge` idempotency key and the
  // 2nd claim replayed as a duplicate (ok:true) instead of a lease conflict — the
  // lease-conflict guard could never fire because the actors were indistinguishable.
  test('a distinct FORGE_ACTOR reaches the lease-conflict path; the same actor stays idempotent', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    const { dir, deps } = makeKernelDeps();
    // Same shared kernel DB, two different agent identities threaded via deps.env.
    const asAlice = { ...deps, env: { FORGE_ACTOR: 'alice' } };
    const asBob = { ...deps, env: { FORGE_ACTOR: 'bob' } };

    try {
      const created = await runIssueOperation(
        'create',
        ['--title', 'Lease contended by two agents', '--type', 'task'],
        dir,
        asAlice,
      );
      expect(created.ok).toBe(true);
      const id = created.data.id;

      // Alice acquires the lease.
      const aliceClaim = await runIssueOperation('claim', [id], dir, asAlice);
      expect(aliceClaim.ok).toBe(true);

      // Bob claims the SAME issue with a distinct actor -> genuine lease conflict.
      const bobClaim = await runIssueOperation('claim', [id], dir, asBob);
      expect(bobClaim.ok).toBe(false);
      expect(bobClaim.error.exit_code).toBe(4); // ISSUE_COMMAND_EXIT_CODES.conflict
      expect(bobClaim.error.details.reason).toBe('claim_conflict');

      // The active lease still belongs to alice — bob never displaced her.
      const shown = await runIssueOperation('show', [id], dir, asAlice);
      expect(shown.ok).toBe(true);
      expect(shown.data.claimed_by).toBe('alice');

      // Alice re-claiming her own lease is an idempotent duplicate, not a conflict.
      const aliceReclaim = await runIssueOperation('claim', [id], dir, asAlice);
      expect(aliceReclaim.ok).toBe(true);
    } finally {
      // Best-effort temp cleanup; a locked-file failure must not mask the assertions.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore: temp dir is reclaimed by the OS; cleanup is not the assertion.
      }
    }
  }, 20000);

  test('with no FORGE_ACTOR the kernel actor stays the historical "forge" default', async () => {
    const { runIssueOperation } = require('../lib/forge-issues');
    const { dir, deps } = makeKernelDeps();
    // No env -> resolveIssueActor returns undefined -> buildIssueMutationEvent keeps 'forge'.
    const noActor = { ...deps, env: {} };

    try {
      const created = await runIssueOperation(
        'create',
        ['--title', 'Default actor', '--type', 'task'],
        dir,
        noActor,
      );
      expect(created.ok).toBe(true);
      const id = created.data.id;

      const claimed = await runIssueOperation('claim', [id], dir, noActor);
      expect(claimed.ok).toBe(true);

      const shown = await runIssueOperation('show', [id], dir, noActor);
      expect(shown.ok).toBe(true);
      expect(shown.data.claimed_by).toBe('forge');
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore: temp dir is reclaimed by the OS; cleanup is not the assertion.
      }
    }
  }, 20000);
});

describe('resolveIssueActor precedence', () => {
  test('FORGE_ACTOR wins, then FORGE_SESSION_ID, else undefined (preserving the forge default)', () => {
    const { resolveIssueActor } = require('../lib/forge-issues');
    expect(resolveIssueActor({ FORGE_ACTOR: 'alice', FORGE_SESSION_ID: 's1' })).toBe('alice');
    expect(resolveIssueActor({ FORGE_SESSION_ID: 's1' })).toBe('s1');
    expect(resolveIssueActor({ FORGE_ACTOR: '   ' })).toBeUndefined();
    expect(resolveIssueActor({})).toBeUndefined();
    expect(resolveIssueActor()).toBeUndefined();
  });
});

describe('no Beads dead-end (7f09ae93 superseded by the backend removal)', () => {
  test('an uninitialized-Beads repo never dead-ends: the kernel is the only route', async () => {
    // 7f09ae93 was a graceful Beads->Kernel fallback. With the backend removed the
    // fallback is unconditional, so the "Beads is not initialized" dead end — and the
    // one-line migration notice it needed — cannot occur at all.
    const { runIssueOperation } = require('../lib/forge-issues');

    const calls = [];
    const result = await runIssueOperation('list', [], '/repo', {
      createKernelBroker: () => ({
        async runIssueOperation(operation, args) {
          calls.push({ operation, args });
          return { ok: true, data: { items: [] } };
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ operation: 'list', args: [] }]);
  });
});
