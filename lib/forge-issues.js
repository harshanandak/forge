'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { isBeadsInitialized } = require('./beads-setup');
const { BeadsIssueAdapter } = require('./adapters/beads-issue-adapter');
const { KernelIssueAdapter } = require('./adapters/kernel-issue-adapter');
const { createGitHubProjectionPlan } = require('./issue-sync/project-github');
const { createLocalBroker, buildLocalBrokerConfig } = require('./kernel/broker');
const { createBuiltinSQLiteDriver } = require('./kernel/sqlite-driver');
const { shouldUseKernelBroker } = require('./issue-backend');

const OPERATION_TO_BD = {
  create: 'create',
  list: 'list',
  ready: 'ready',
  show: 'show',
  search: 'search',
  stats: 'status',
  close: 'close',
  update: 'update',
  comment: 'comments',
  // KAP-7/KAP-12 derived reads: identity passthroughs to the matching bd subcommand.
  // Routed here (not in _issue.js) so the issue command surface carries no bd args.
  blocked: 'blocked',
  stale: 'stale',
  orphans: 'orphans',
  lint: 'lint',
  // Epic support: identity passthrough to `bd children` for the beads opt-out. The
  // kernel default emits the richer `issue.children` rollup; this passthrough only
  // keeps the beads path from a null-deref when children is invoked under --issue-backend
  // beads (the bd output shape differs and carries no rollup).
  children: 'children',
};

// Beads has no verified release operation; the claim lease lives only in the Kernel
// backend. Surfaced as an explicit error so `forge release <id>` on the beads opt-out
// fails loudly instead of silently mapping to an unrelated bd subcommand.
const BEADS_RELEASE_KERNEL_ONLY_ERROR =
  'forge release <id> is defined for the Kernel issue backend; Beads passthrough has no verified release operation.';

// `bd children` emits a different payload (no rollup) than the kernel
// `issue.children` envelope this command promises. Reject the beads backend
// explicitly instead of silently proxying a contract-violating shape.
const BEADS_CHILDREN_KERNEL_ONLY_ERROR =
  'forge issue children is defined for the Kernel issue backend; Beads passthrough has no equivalent issue.children rollup.';

// Lease ownership lives only in the Kernel backend (kernel_claims); Beads has no
// verified lease to check. Reject the beads path explicitly so `forge issue owns <id>`
// fails loudly instead of mapping to an unrelated/absent Beads subcommand.
const BEADS_OWNS_KERNEL_ONLY_ERROR =
  'forge issue owns <id> is defined for the Kernel issue backend; Beads passthrough has no lease-ownership verification.';

const OPERATION_METHOD_ALIASES = {
  'dep.add': 'depAdd',
  'dep.remove': 'depRemove',
};

function getSpawnOptions(projectRoot) {
  return {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

function getPathEntries(env = process.env, delimiter = path.delimiter) {
  const rawPath = env.PATH || env.Path || '';
  return rawPath
    .split(delimiter)
    .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function resolveWindowsCommandCandidates(commandNames, deps = {}) {
  const env = deps.env || process.env;
  const fileExists = deps.existsSync || existsSync;
  const resolved = [];
  const seen = new Set();
  const pathEntries = getPathEntries(env, ';');

  for (const dir of pathEntries) {
    for (const commandName of commandNames) {
      const fullPath = isWindowsPathEntry(dir)
        ? path.win32.join(dir, commandName)
        : path.posix.join(dir, commandName);
      const dedupeKey = fullPath.toLowerCase();
      if (!seen.has(dedupeKey) && fileExists(fullPath)) {
        seen.add(dedupeKey);
        resolved.push(fullPath);
      }
    }
  }

  return resolved;
}

function isWindowsPathEntry(entry = '') {
  return /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(entry) || entry.includes('\\');
}

function getBdCommandCandidates(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === 'win32') {
    const resolved = resolveWindowsCommandCandidates(['bd.exe', 'bd.cmd'], deps);
    return [...new Set([...resolved, 'bd.exe', 'bd'])];
  }

  return ['bd'];
}

function normalizeExecOutput(output) {
  if (typeof output === 'string') {
    return output;
  }

  if (Buffer.isBuffer(output)) {
    return output.toString('utf8');
  }

  return '';
}

function hasBdSoftFailure(output) {
  return /(^|\n)Error(?: resolving| updating| fetching| adding)?\b/i.test(output);
}

function hasEmptyShowPayload(operation, output) {
  if (operation !== 'show') {
    return false;
  }

  const trimmedOutput = output.trim();
  return trimmedOutput === '' || trimmedOutput === '[]' || trimmedOutput === 'null';
}

function isHelpInvocation(args = []) {
  return args.includes('--help') || args.includes('-h');
}

function extractErrorMessage(error) {
  if (error?.code === 'ENOENT') {
    return 'Beads (bd) command not found. Install or initialize Beads before using forge issues.';
  }

  return error?.message?.trim() || 'Beads command failed';
}

function getCommandErrorMessage(result) {
  const output = [result?.stdout, result?.stderr].filter(Boolean).join('\n').trim();
  if (output) {
    return output;
  }

  if (typeof result?.code === 'number') {
    return `Beads command failed with exit code ${result.code}`;
  }

  return 'Beads command failed';
}

function buildBdArgs(operation, args) {
  if (operation === 'comment') {
    return ['comments', 'add', ...args];
  }

  // De-bead parity: `forge claim <id>` maps to bd `update <id> --claim`. The
  // translation lived in _issue.js; it now lives in the beads layer so the issue
  // command surface stays free of bd argv. The issue id is the first positional.
  if (operation === 'claim') {
    const [issueId, ...rest] = args;
    if (!issueId) {
      return { error: 'Missing issue id. Usage: forge claim <id> [bd-update-flags]' };
    }
    return ['update', issueId, '--claim', ...rest];
  }

  if (operation === 'dep.add') {
    return ['dep', 'add', ...args];
  }

  if (operation === 'dep.remove') {
    return ['dep', 'remove', ...args];
  }

  const bdCommand = OPERATION_TO_BD[operation];
  if (!bdCommand) {
    return null;
  }

  return [bdCommand, ...args];
}

function shouldCaptureOutput(operation, args, deps = {}) {
  if (deps.captureOutput === true) {
    return true;
  }

  if (isHelpInvocation(args)) {
    return true;
  }

  if (args.includes('--json')) {
    return true;
  }

  return operation === 'update' || operation === 'show';
}

async function runBdCommand(operation, args, projectRoot, deps = {}) {
  const spawnBd = deps.spawn || spawn;
  const stdoutTarget = deps.stdout || process.stdout;
  const stderrTarget = deps.stderr || process.stderr;
  const captureOutput = shouldCaptureOutput(operation, args.slice(1), deps);
  const commandCandidates = deps.commandCandidates || getBdCommandCandidates(deps);
  let lastError;

  for (const command of commandCandidates) {
    try {
      return await new Promise((resolve, reject) => {
        const child = spawnBd(command, args, getSpawnOptions(projectRoot));
        let stdout = '';
        let stderr = '';

        child.stdout?.setEncoding?.('utf8');
        child.stderr?.setEncoding?.('utf8');
        child.stdout?.on?.('data', chunk => {
          const normalizedChunk = normalizeExecOutput(chunk);
          if (captureOutput) {
            stdout += normalizedChunk;
          } else {
            stdoutTarget?.write?.(normalizedChunk);
          }
        });
        child.stderr?.on?.('data', chunk => {
          const normalizedChunk = normalizeExecOutput(chunk);
          if (captureOutput) {
            stderr += normalizedChunk;
          }
          stderrTarget?.write?.(normalizedChunk);
        });

        child.on('error', reject);
        child.on('close', code => {
          resolve({
            code,
            stdout,
            stderr,
          });
        });
      });
    } catch (error) {
      lastError = error;
      // ENOENT/EINVAL means this candidate is not directly spawnable — try next.
      if (error?.code !== 'ENOENT' && error?.code !== 'EINVAL') {
        throw error;
      }
    }
  }

  throw lastError;
}

async function runBeadsOperation(operation, args, context, deps) {
  // Beads has no verified release; fail before the init check so the kernel-only
  // contract is reported even in an uninitialized repo (parity with the old
  // _issue.js release guard, which short-circuited on the beads path).
  if (operation === 'release' && !isHelpInvocation(args)) {
    return { success: false, error: BEADS_RELEASE_KERNEL_ONLY_ERROR };
  }

  // `children` only has a verified shape on the kernel backend (the
  // issue.children rollup); fail loudly rather than proxy `bd children`.
  if (operation === 'children' && !isHelpInvocation(args)) {
    return { success: false, error: BEADS_CHILDREN_KERNEL_ONLY_ERROR };
  }

  // `owns` verifies a Kernel lease; Beads has no such lease. Fail loudly rather
  // than silently proxy to a non-existent Beads subcommand.
  if (operation === 'owns' && !isHelpInvocation(args)) {
    return { success: false, error: BEADS_OWNS_KERNEL_ONLY_ERROR };
  }

  const checkInit = deps.isBeadsInitialized || isBeadsInitialized;
  if (!isHelpInvocation(args) && !checkInit(context.projectRoot)) {
    return {
      success: false,
      error: 'Beads is not initialized in this project. Run forge setup before using forge issues.',
    };
  }

  const bdArgs = buildBdArgs(operation, args);
  // A non-array result is a translation error (e.g. claim with no issue id).
  if (!Array.isArray(bdArgs)) {
    return { success: false, error: bdArgs.error };
  }
  // The reported operation is the logical operation name (comment -> 'comment',
  // show -> 'show'), NOT the bd subcommand argv[0] (which is 'comments'/'status').
  // The one exception is claim: it maps to `update <id> --claim`, and the historical
  // _issue.js beads path reported operation 'update', so preserve that here.
  const reportedOperation = operation === 'claim' ? 'update' : operation;
  const runCommand = deps.runBdCommand || ((cmdArgs, projectRoot) => runBdCommand(operation, cmdArgs, projectRoot, deps));

  try {
    const result = await runCommand(bdArgs, context.projectRoot);
    const stdout = normalizeExecOutput(result?.stdout);
    const stderr = normalizeExecOutput(result?.stderr);
    const combinedOutput = [stdout, stderr].filter(Boolean).join('\n');

    if (result?.code !== 0) {
      return {
        success: false,
        error: getCommandErrorMessage(result),
      };
    }

    if (hasBdSoftFailure(combinedOutput)) {
      return {
        success: false,
        error: combinedOutput.trim() || 'Beads command failed',
      };
    }

    if (hasEmptyShowPayload(operation, combinedOutput)) {
      return {
        success: false,
        error: `Issue not found: ${args[0] || 'unknown issue'}`,
      };
    }

    return {
      success: true,
      operation: reportedOperation,
      output: stdout,
      stderr,
    };
  } catch (error) {
    return {
      success: false,
      error: extractErrorMessage(error),
    };
  }
}

function createBeadsIssueBackend(deps = {}) {
  return new BeadsIssueAdapter({
    runBeadsOperation: (operation, args, context, contextDeps = {}) =>
      runBeadsOperation(operation, args, context, {
        ...deps,
        ...contextDeps,
      }),
  });
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
  // Default issue backend is now the Kernel. Beads is reachable opt-OUT via the
  // selector (--issue-backend beads / FORGE_ISSUE_BACKEND=beads / config), which
  // resolves to an explicit `backend` upstream in runIssueOperation. This no-arg
  // fallback fires only for a no-backend direct call to createIssueService — the
  // CLI path always threads an explicit backend through resolveCommandOpts.
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

// Graceful Beads→Kernel fallback (issue 7f09ae93). When the resolved backend is
// Beads but Beads is NOT initialized in this project AND a Forge Kernel store
// already exists at `<gitCommonDir>/forge/kernel.sqlite`, route the operation to
// the kernel instead of dead-ending on "Beads is not initialized". This unblocks
// upgraders whose repo predates the kernel default (or whose global `forge` binary
// is stale and still resolves Beads): the kernel is the correct default and already
// holds their issues. Returns the resolved kernel paths when the fallback applies,
// or null to keep the Beads path (so a genuine no-store repo still gets the Beads
// not-initialized error). Path resolution reuses buildLocalBrokerConfig so the probed
// location matches exactly what the broker would open. Never throws.
function resolveBeadsFallbackToKernel(projectRoot, deps = {}) {
  const checkInit = deps.isBeadsInitialized || isBeadsInitialized;
  if (checkInit(projectRoot)) {
    // Beads is initialized — honor the explicit Beads selection, no fallback.
    return null;
  }

  let config;
  try {
    config = buildLocalBrokerConfig({
      projectRoot,
      gitCommonDir: deps.gitCommonDir,
      databasePath: deps.kernelDatabasePath,
      execFileSync: deps.execFileSync,
    });
  } catch {
    // No resolvable kernel location (e.g. projectRoot is not a git repo) — there is
    // no safe fallback target, so let the Beads path report its own error.
    return null;
  }

  const fileExists = deps.existsSync || existsSync;
  if (!fileExists(config.databasePath)) {
    // No kernel store either — preserve the Beads not-initialized error.
    return null;
  }

  return { kernelDatabasePath: config.databasePath, gitCommonDir: config.gitCommonDir };
}

async function runIssueOperation(operation, rawArgs, projectRoot, deps = {}) {
  const injectedService = deps.createService;
  let routeToKernel = shouldUseKernelBroker(deps);
  let effectiveDeps = deps;

  // Beads→Kernel graceful fallback (7f09ae93). Only considered when a service is not
  // injected (an injected service owns backend selection), the selection is not
  // already Kernel, and this is not a help invocation (help must never touch a
  // backend). When it applies, treat the op as Kernel-routed end-to-end (backend
  // construction AND the projection-target seam below).
  if (!injectedService && !routeToKernel && !isHelpInvocation(rawArgs)) {
    const fallback = resolveBeadsFallbackToKernel(projectRoot, deps);
    if (fallback) {
      routeToKernel = true;
      effectiveDeps = {
        ...deps,
        useKernelBroker: true,
        kernelDatabasePath: fallback.kernelDatabasePath,
        gitCommonDir: fallback.gitCommonDir,
      };
      const notify = deps.warn || ((msg) => process.stderr.write(`${msg}\n`));
      notify(
        'Notice: Beads is not initialized, but a Forge Kernel store exists — using the '
        + 'kernel backend (the default). Run `forge setup` to finish migrating.',
      );
    }
  }

  const createService = injectedService || (() => {
    const context = {
      projectRoot,
      deps: effectiveDeps,
    };

    if (routeToKernel) {
      return createIssueService({
        backend: createKernelIssueBackend(context),
      });
    }

    const backendDeps = {
      isBeadsInitialized: deps.isBeadsInitialized,
      runBdCommand: deps.runBdCommand,
      spawn: deps.spawn,
      platform: deps.platform,
      env: deps.env,
    };

    return createIssueService({
      backend: createBeadsIssueBackend(backendDeps),
    });
  });

  const service = createService();
  // Thread a distinct per-agent actor (and, when present, a stable session id) into the
  // mutation context so the Kernel's claim idempotency key is scoped per agent rather than
  // to the shared 'forge' default (kernel d71a824b). Undefined values are omitted so the
  // historical default is preserved for no-env callers, and the Beads backend — which
  // ignores context.actor/sessionId — is unaffected.
  const actorEnv = deps.env || process.env;
  const actor = resolveIssueActor(actorEnv);
  const sessionId = typeof actorEnv.FORGE_SESSION_ID === 'string' && actorEnv.FORGE_SESSION_ID.trim()
    ? actorEnv.FORGE_SESSION_ID.trim()
    : undefined;
  const result = await service.run(operation, rawArgs, {
    projectRoot,
    deps,
    ...(actor ? { actor } : {}),
    ...(sessionId ? { sessionId } : {}),
    // Kernel mutations enqueue a projection-outbox "dirty marker" that `forge export`
    // (the D16 git-JSONL portability projection) drains under target 'jsonl'. The
    // broker's legacy primitive default is 'beads', so without steering the target
    // here every Kernel-created issue is enqueued as 'beads' and `forge export` — which
    // drains 'jsonl' — finds nothing, silently never emitting git-tracked JSONL. Only
    // the Kernel path uses this seam (`context.projectionTarget`); Beads ignores it.
    ...(routeToKernel ? { projectionTarget: 'jsonl' } : {}),
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
  createBeadsIssueBackend,
  createKernelIssueBackend,
  runBeadsOperation,
  runIssueOperation,
  buildBdArgs,
  extractErrorMessage,
  getCommandErrorMessage,
  getSpawnOptions,
  hasEmptyShowPayload,
  hasBdSoftFailure,
  isHelpInvocation,
  normalizeExecOutput,
  runBdCommand,
  getBdCommandCandidates,
  getPathEntries,
  resolveIssueActor,
  resolveBeadsFallbackToKernel,
  resolveWindowsCommandCandidates,
};
