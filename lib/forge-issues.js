'use strict';

const path = require('node:path');
const { KernelIssueAdapter } = require('./adapters/kernel-issue-adapter');
const { createGitHubProjectionPlan } = require('./issue-sync/project-github');
const { createLocalBroker, buildLocalBrokerConfig } = require('./kernel/broker');
const { createBuiltinSQLiteDriver } = require('./kernel/sqlite-driver');
const { detectWorktree } = require('./detect-worktree');
const { DEFAULT_LEASE_TTL_MS } = require('./kernel/lease-enforcer');

const OPERATION_METHOD_ALIASES = {
  'dep.add': 'depAdd',
  'dep.remove': 'depRemove',
};

// Backend-agnostic: a `--help`/`-h` invocation must never reach a store.
function isHelpInvocation(args = []) {
  return args.includes('--help') || args.includes('-h');
}

// Build the default local broker for the CLI path. createLocalBroker does NOT
// construct a driver on its own (`const driver = options.driver`), so when no
// driver is injected we build a builtin SQLite driver pointed at the resolved
// kernel DB path. Without this, broker.initialize()/runIssueOperation would throw
// on a missing `exec` method before ever reaching the "no tables" case.
function createDefaultKernelBroker(brokerContext, deps) {
  let driver = deps.kernelDriver;
  if (!driver) {
    const config = buildLocalBrokerConfig({
      projectRoot: brokerContext.projectRoot,
      gitCommonDir: deps.gitCommonDir,
      databasePath: deps.kernelDatabasePath,
      execFileSync: deps.execFileSync,
    });
    driver = createBuiltinSQLiteDriver({ databasePath: config.databasePath });
  }

  return createLocalBroker({
    projectRoot: brokerContext.projectRoot,
    gitCommonDir: deps.gitCommonDir,
    databasePath: deps.kernelDatabasePath,
    driver,
    execFileSync: deps.execFileSync,
    // Pass-through for the D19 default-on filesystem gate (fires in the broker's
    // getConfig chokepoint). Forwarding it lets callers/tests inject a deterministic
    // classifier instead of paying the real Windows drive probe per per-op broker.
    classifyFilesystem: deps.classifyFilesystem,
  });
}

// Symbol marker for the memoized lazy-init promise. Stored ON the broker object
// so that re-wrapping the SAME broker instance (e.g. a long-lived injected broker
// hit by several runIssueOperation calls) still initializes exactly once.
const LAZY_INIT_PROMISE = Symbol('forgeKernelLazyInitPromise');

// Wrap a broker so the kernel DB is migrated lazily and exactly once before the
// first issue operation. initialize() applies migrations idempotently
// (CREATE TABLE IF NOT EXISTS), so a fresh DB gains its tables automatically.
// Brokers without an initialize() method (e.g. test fakes) pass through untouched.
function withLazyKernelInit(broker) {
  if (!broker || typeof broker.initialize !== 'function') {
    return broker;
  }

  const ensureInitialized = () => {
    if (!broker[LAZY_INIT_PROMISE]) {
      broker[LAZY_INIT_PROMISE] = Promise.resolve(broker.initialize()).catch((error) => {
        // Reset so a transient init failure can be retried on the next op rather
        // than permanently poisoning the broker with a rejected cached promise.
        broker[LAZY_INIT_PROMISE] = null;
        throw error;
      });
    }
    return broker[LAZY_INIT_PROMISE];
  };

  // Delegate explicitly rather than spreading `...broker`: a spread copies only the
  // broker's OWN enumerable props, so a future class-based broker would silently
  // lose its prototype methods. The adapter only ever calls runIssueOperation (plus
  // optional initialize), so forwarding exactly those two is the complete surface.
  return {
    async initialize() {
      return ensureInitialized();
    },
    async runIssueOperation(operation, args = [], context = {}) {
      await ensureInitialized();
      return broker.runIssueOperation(operation, args, context);
    },
  };
}

function createKernelIssueBackend(context = {}) {
  const deps = context.deps || {};
  const createBroker = deps.createKernelBroker
    || ((brokerContext) => createDefaultKernelBroker(brokerContext, deps));

  const broker = deps.kernelBroker || createBroker(context);

  return new KernelIssueAdapter({
    broker: withLazyKernelInit(broker),
  });
}

function createIssueService({ backend } = {}) {
  // The Kernel is the ONLY issue backend. An explicit `backend` is still honored so
  // tests (and any future adapter) can inject one; the no-arg fallback builds the
  // kernel backend, which is also what the CLI path threads in via resolveCommandOpts.
  const resolvedBackend = backend || createKernelIssueBackend();

  return {
    async run(operation, args = [], context = {}) {
      const methodName = operation === 'show' && typeof resolvedBackend?.show !== 'function'
        ? 'read'
        : OPERATION_METHOD_ALIASES[operation] || operation;
      const method = resolvedBackend?.[methodName];
      if (typeof method !== 'function') {
        return {
          success: false,
          error: `Unsupported issue operation: ${operation}`,
        };
      }

      return method.call(resolvedBackend, args, context);
    },
  };
}

// Resolve a distinct per-agent actor for Kernel issue mutations. The Kernel keys a
// claim's idempotency on `claim.create:<issue_id>:<actor>` (lib/kernel/broker.js
// buildClaimMutationEvent), so two concurrent agents that both fall back to the 'forge'
// default collide on ONE key: the 2nd claim replays as an idempotent duplicate (ok:true)
// instead of reaching the lease-conflict path, so a genuine loser is told it won
// (kernel d71a824b). An explicit per-agent identity produces a distinct key so the
// second claimant reaches the claim_conflict guard.
//
// Precedence: FORGE_ACTOR (explicit per-agent id) -> FORGE_SESSION_ID (stable session id)
// -> undefined. Returning undefined is deliberate: buildIssueMutationEvent applies
// `context.actor || 'forge'`, so a no-env caller (the main repo, existing tests) is
// byte-identical to before — only an explicitly-distinct identity changes behavior.
// A git-worktree-derived identity is a deferred follow-up: it would change the default
// actor in every worktree checkout, so it must be validated against the suite first.
function resolveIssueActor(env = {}) {
  const source = env || {};
  const explicit = typeof source.FORGE_ACTOR === 'string' ? source.FORGE_ACTOR.trim() : '';
  if (explicit) return explicit;
  const session = typeof source.FORGE_SESSION_ID === 'string' ? source.FORGE_SESSION_ID.trim() : '';
  if (session) return session;
  return undefined;
}

// Resolve the worktree_id stamped onto a claim lease (kernel d71a824b) so the dashboard
// can show WHICH worktree holds a lease (the kernel DB is shared across all worktrees of
// a repo). Precedence: FORGE_WORKTREE_ID (explicit override) -> the current worktree's
// directory name (git-common-dir/registry-derived via detectWorktree) -> undefined.
// Best-effort: any failure (not a git repo, git unavailable) yields undefined, so the
// lease's worktree_id is simply null — never a thrown error on the claim path.
function resolveWorktreeId(projectRoot, env = {}, deps = {}) {
  const override = typeof env.FORGE_WORKTREE_ID === 'string' ? env.FORGE_WORKTREE_ID.trim() : '';
  if (override) return override;
  try {
    const detect = deps.detectWorktree || detectWorktree;
    const info = detect(projectRoot);
    if (info && typeof info.currentWorktree === 'string' && info.currentWorktree) {
      return path.basename(info.currentWorktree);
    }
  } catch {
    // best-effort: worktree_id is an optional presence signal, never a hard failure
  }
  return undefined;
}

// Resolve the lease TTL (ms) applied to a claim when the caller pins no explicit
// --expires. FORGE_LEASE_TTL_MS overrides the DEFAULT_LEASE_TTL_MS constant; an explicit
// 0 / negative / non-numeric value is an OPT-OUT (returns null → never-expiring lease,
// the historical default), preserving the null-expiry capability from the CLI.
function resolveLeaseTtlMs(env = {}) {
  const raw = env.FORGE_LEASE_TTL_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_LEASE_TTL_MS;
  const ttl = Number(raw);
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  return ttl;
}

async function runIssueOperation(operation, rawArgs, projectRoot, deps = {}) {
  const injectedService = deps.createService;

  const createService = injectedService || (() => createIssueService({
    backend: createKernelIssueBackend({ projectRoot, deps }),
  }));

  const service = createService();
  // Thread a distinct per-agent actor (and, when present, a stable session id) into the
  // mutation context so the Kernel's claim idempotency key is scoped per agent rather than
  // to the shared 'forge' default (kernel d71a824b). Undefined values are omitted so the
  // historical default is preserved for no-env callers.
  const actorEnv = deps.env || process.env;
  const actor = resolveIssueActor(actorEnv);
  const sessionId = typeof actorEnv.FORGE_SESSION_ID === 'string' && actorEnv.FORGE_SESSION_ID.trim()
    ? actorEnv.FORGE_SESSION_ID.trim()
    : undefined;
  // The worktree id and lease TTL only shape a claim's lease row, so resolve them ONLY
  // for the claim op — worktree detection shells out to git, and running it on every read
  // (list/show/ready) would be pure cost. leaseTtlMs=null (explicit opt-out) is omitted so
  // the broker keeps a null (never-expiring) lease.
  const isClaim = operation === 'claim';
  const worktreeId = isClaim ? resolveWorktreeId(projectRoot, actorEnv, deps) : undefined;
  const leaseTtlMs = isClaim ? resolveLeaseTtlMs(actorEnv) : undefined;
  const result = await service.run(operation, rawArgs, {
    projectRoot,
    deps,
    ...(actor ? { actor } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(worktreeId ? { worktreeId } : {}),
    ...(leaseTtlMs ? { leaseTtlMs } : {}),
    // Kernel mutations enqueue a projection-outbox "dirty marker" that `forge export`
    // (the D16 git-JSONL portability projection) drains under target 'jsonl'. The
    // broker's legacy primitive default is still 'beads', so without steering the target
    // here every Kernel-created issue would be enqueued as 'beads' and `forge export` —
    // which drains 'jsonl' — would find nothing, silently never emitting git-tracked
    // JSONL. Unconditional now that the Kernel is the only backend.
    projectionTarget: 'jsonl',
  });

  const queueGitHubProjection = deps.enqueueGitHubProjection || deps.queueGitHubProjection;
  if (result?.success && typeof queueGitHubProjection === 'function') {
    const projectionPlan = createGitHubProjectionPlan(operation, rawArgs);
    if (projectionPlan) {
      await queueGitHubProjection(projectionPlan, {
        operation,
        args: rawArgs,
        projectRoot,
        result,
      });
    }
  }

  return result;
}

module.exports = {
  createIssueService,
  createKernelIssueBackend,
  runIssueOperation,
  isHelpInvocation,
  resolveIssueActor,
};
