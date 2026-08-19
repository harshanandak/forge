'use strict';

/**
 * shepherd command — one bounded monitor pass over a pull request.
 *
 * `forge shepherd <pr> [--auto-rebase]` runs one local review preflight, reads
 * PR/CI state, takes at most one idempotent Tier-A action (rerun a flaky required
 * check), persists bounded deltas/receipts, and exits. It NEVER merges and NEVER
 * resolves review threads. Event-driven waiting belongs to the singleton/watch
 * process; this command does not model-poll or loop in-process.
 *
 * `forge shepherd <pr> --bundle --json` instead prints the COMPLETE read-only
 * PR-state bundle (all unresolved threads, merge state, CI, divergence,
 * predicted conflicts) the monitor will hand to a fixer-agent. It still decides
 * nothing and takes no action.
 *
 * `forge shepherd <pr> --pull --json` prints a COMPACT, bounded "why it failed +
 * what to fix" payload: per-failed-check log excerpts (matrix-deduped) plus the
 * unresolved review-thread fix-list (CodeRabbit included), alongside the decision
 * state. All the `gh pr checks` / `gh run view --log-failed` / GraphQL work is
 * done IN CODE so an agent gets one payload instead of running those by hand. It
 * still NEVER merges and NEVER resolves threads.
 *
 * Public Memory is durable authority; the local journal is compatibility delivery.
 *
 * @module commands/shepherd
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const { runShepherdPass } = require('../pr-shepherd');
const { gatherPrBundle } = require('../pr-bundle');
const { gatherPullSignal, renderPullSummary } = require('../pr-pull');
const { PrStateAdapter } = require('../adapters/pr-state-adapter');
const { validatePrStateAdapter } = require('../pr-state-validator');
const { gatherMonitorSnapshot } = require('../pr-monitor/gather');
const { privacySafeIdentity } = require('../pr-monitor/flow-monitor');
const { pollEvents } = require('../pr-monitor/monitor');
const { watchLoop } = require('../pr-monitor/watch');
const { startPrWatcherDetached } = require('../pr-monitor/watch-lifecycle');
const reconcileExecutor = require('../pr-monitor/reconcile-executor');
const monitorJournal = require('../pr-monitor/journal');
const shepherdLease = require('../pr-monitor/shepherd-lease');
const brokerMod = require('../kernel/broker');
const { EVENT_TYPES: T } = require('../pr-monitor/events');
const { autoShepherdRailEnabled } = require('./ship');
const { runLocalReviewPreflight } = require('../pr-monitor/review-preflight');

const DEFAULT_RERUN_BUDGET = 3;
const MAX_MONITOR_ID_LENGTH = 128;

function rootMonitorId(owner, repo, pr) {
  const raw = privacySafeIdentity(`pr:${privacySafeIdentity(`${owner}/${repo}`)}:${pr}`);
  if (raw.length <= MAX_MONITOR_ID_LENGTH) return raw;
  return `pr:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

// windowsHide: true on EVERY spawn here is load-bearing, not cosmetic. The
// shepherd watcher runs detached in the background and re-polls every ~60s; on
// Windows a child process spawned WITHOUT windowsHide flashes a visible console
// window each time (Node's default is windowsHide:false). Background work's
// preferred home is the harness's managed shell (hidden + reaped); a
// Forge-spawned detached watcher is the no-session fallback and must be
// COMPLETELY silent — no console window, ever. See kernel issue 931e7924.
const defaultGhRunner = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', timeout: 30000, windowsHide: true });

/**
 * Resolve owner/repo and base branch for the shepherd pass.
 *
 * The exact base commit is read from the PR itself (`gh pr view <pr> --json
 * baseRefOid`) rather than a local remote, so fork checkouts and PRs targeting
 * `release/*`/`develop` are evaluated against the provider's reviewed base.
 * `owner`/`name` come from the repository the PR is queried in — that IS the
 * base repository. `cwd` (the worktree root) is threaded through so divergence
 * is computed against the right checkout.
 *
 * @param {object} deps
 * @returns {Promise<{ pr: string, owner: string, repo: string, base: string, baseRef: string, cwd?: string }>}
 */
async function defaultBuildContext({ pr, gh, git, projectRoot }) {
  const prJson = gh('gh', ['pr', 'view', String(pr), '--json', 'baseRefName,baseRefOid,headRefOid']);
  const prInfo = JSON.parse(prJson || '{}');
  const base = prInfo.baseRefName || 'master';
  if (typeof prInfo.baseRefOid !== 'string' || !/^[0-9a-f]{40}$/i.test(prInfo.baseRefOid)) {
    throw new Error('PR base commit is unavailable from the provider');
  }
  const baseRef = prInfo.baseRefOid.toLowerCase();
  const headSha = typeof prInfo.headRefOid === 'string' && /^[0-9a-f]{40}$/i.test(prInfo.headRefOid)
    ? prInfo.headRefOid.toLowerCase()
    : null;

  const repoJson = gh('gh', ['repo', 'view', '--json', 'owner,name']);
  const repo = JSON.parse(repoJson || '{}');
  const owner = repo.owner?.login || '';
  const name = repo.name || '';

  let localHead = null;
  try {
    const candidate = git('git', ['rev-parse', 'HEAD']).trim();
    if (/^[0-9a-f]{40}$/i.test(candidate)) localHead = candidate.toLowerCase();
  } catch {
    /* a missing local checkout makes local review preflight not applicable */
  }

  return {
    pr: String(pr),
    owner,
    repo: name,
    base,
    baseRef,
    headSha,
    localHead,
    ...(projectRoot ? { cwd: projectRoot } : {}),
  };
}

/**
 * Detect whether the working tree is clean (precondition for --auto-rebase).
 *
 * @param {Function} git
 * @returns {boolean}
 */
function isWorkingTreeClean(git) {
  try {
    return git('git', ['status', '--porcelain']).trim().length === 0;
  } catch (_err) {
    return false;
  }
}

// Render a single pass action for the human-readable monitor line. Strings pass
// through; everything else is JSON-encoded, but JSON.stringify can throw on
// circular refs or BigInt, so surface the reason inline rather than crash the pass.
function formatAction(action) {
  if (typeof action === 'string') {
    return action;
  }
  try {
    return JSON.stringify(action);
  } catch (err) {
    return `[unprintable action: ${err.message}]`;
  }
}

function writePassSummary(pr, state, reason, actions) {
  const passActions = Array.isArray(actions) ? actions : [];
  const reasonSuffix = reason ? ` — ${reason}` : '';
  process.stdout.write(`Shepherd pass — PR #${pr}: ${state}${reasonSuffix}\n`);
  for (const action of passActions) process.stdout.write(`  • ${formatAction(action)}\n`);
  if (!passActions.length) process.stdout.write('  • no actions this pass\n');
}

/**
 * Build the DEFAULT `check.failed` enrichment hook for the events pull surface.
 *
 * The monitor design specifies that newly-failed checks are enriched with their
 * failure log excerpts before the journal append. `pollEvents` accepts an
 * `enrich` hook but `handleEvents` must supply the default one, or a plain
 * `forge shepherd events` call would emit bare `check.failed` events with no
 * `data.excerpt` (only direct monitor callers could attach them).
 *
 * The hook is BEST-EFFORT: it fetches the compact pull signal ONCE (only when a
 * pass actually produced a `check.failed`), maps excerpts by check name, and
 * decorates matching records. Any failure to gather excerpts leaves the events
 * intact rather than aborting the pass — enrichment must never block the journal.
 *
 * @param {object} pullCtx - ctx forwarded to `gatherPull` (owner/repo/base/adapter/runGh/self).
 * @returns {(records: object[]) => Promise<void>}
 */
const UNSAFE_MONITOR_EXCERPT = /(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk_(?:live|test)_[a-z0-9]{16,}|sk-[a-z0-9]{16,}|AKIA[0-9A-Z]{16}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}|(?:^|[\\/])(?:users|home|root)[\\/]\S+)/i;

function safeMonitorExcerpt(value) {
  return typeof value === 'string' && value.length <= 16_384 && !UNSAFE_MONITOR_EXCERPT.test(value)
    ? value
    : null;
}

function makeCheckFailureEnricher(pullCtx) {
  const gatherPull = pullCtx.gatherPull || gatherPullSignal;
  return async (records) => {
    if (!Array.isArray(records) || !records.some((r) => r.type === T.CHECK_FAILED)) return;
    let failures;
    try {
      const pull = await gatherPull(pullCtx);
      failures = Array.isArray(pull?.failures) ? pull.failures : [];
    } catch (err) {
      // best-effort: never let enrichment abort the pass, but surface the reason
      console.error(`[shepherd] check-failure enrichment skipped: ${err.message}`);
      return;
    }
    const byName = new Map(failures.map((f) => [f.name, f]));
    for (const r of records) {
      if (r.type !== T.CHECK_FAILED) continue;
      const f = byName.get(r.data?.name);
      if (!f) continue;
      const excerpt = safeMonitorExcerpt(f.excerpt);
      if (excerpt) r.data.excerpt = excerpt;
      if (f.jobUrl) r.data.jobUrl = f.jobUrl;
    }
  };
}

/** Parse `--since <seq>` from the raw arg list (default 0). */
function parseSince(args) {
  const i = (args || []).indexOf('--since');
  if (i >= 0 && args[i + 1] != null) return Number.parseInt(args[i + 1], 10) || 0;
  return 0;
}

function terminalCleanupEvidence(ctx, deps = {}) {
  try {
    const inspectLease = deps.inspectLease || shepherdLease.inspect;
    const lease = inspectLease(ctx.projectRoot, { gitCommonDir: ctx.gitCommonDir });
    const pr = Number(ctx.pr);
    const canonicalRepo = `${ctx.owner}/${ctx.repo}`.toLowerCase();
    const localRepo = String(ctx.repo).toLowerCase();
    let leaseStatus = 'checkpointed';
    if (lease?.status === 'valid' && Array.isArray(lease.watchers)) {
      const stillLeased = lease.watchers.some((watcher) => {
        if (Number(typeof watcher === 'object' ? watcher?.pr : watcher) !== pr) return false;
        if (!watcher || typeof watcher !== 'object' || watcher.repo == null) return true;
        const repo = String(watcher.repo).toLowerCase();
        return repo === canonicalRepo || repo === localRepo;
      });
      if (stillLeased) return { complete: false };
    } else if (lease?.status === 'absent') {
      const readCleanup = deps.readCleanup || reconcileExecutor.readCleanupMarker;
      const cleanup = readCleanup(ctx.projectRoot, canonicalRepo, pr, ctx.gitCommonDir);
      if (cleanup?.status !== 'reaped' || cleanup.repo !== canonicalRepo || Number(cleanup.pr) !== pr) {
        return { complete: false };
      }
      leaseStatus = 'released';
    } else {
      return { complete: false };
    }
    const readClaim = deps.readClaim || reconcileExecutor.readClaimMarker;
    if (readClaim(ctx.projectRoot, canonicalRepo, pr, ctx.gitCommonDir) != null) return { complete: false };
    return {
      complete: true,
      processCleanup: { status: 'reaped', owner: 'repo-singleton-shepherd' },
      leaseCleanup: { status: leaseStatus, continuing_authority: false },
    };
  } catch {
    return { complete: false };
  }
}

/**
 * Build the shared monitor context — journal `dir`, bounded `gather`, and the
 * default `check.failed` enricher — that BOTH the `events` pull surface and the
 * `watch` streaming loop feed to the monitor core. Injected `dir`/`gather`/
 * `enrich` (tests, programmatic callers) short-circuit the live gh build.
 *
 * @param {string|number} pr
 * @param {string} projectRoot
 * @param {object} deps
 * @returns {Promise<{ dir?: string, gather?: Function, enrich?: Function, error?: string }>}
 */
async function buildMonitorContext(pr, projectRoot, deps) {
  let dir = deps.dir;
  let gather = deps.gather;
  let cleanupEvidence = deps.terminalCleanupEvidence;
  let authority = deps.store ? {
    store: deps.store,
    monitorId: deps.monitorId,
    ownerRunId: deps.ownerRunId,
    packetId: deps.packetId,
    subjectId: deps.subjectId,
    close: deps.close || (async () => {}),
  } : {};
  // enrich decorates newly-failed checks with log excerpts before the journal
  // append. The caller MUST supply the default (not just forward an injected
  // one), or a plain `forge shepherd events`/`watch` emits bare check.failed events.
  let enrich = deps.enrich;
  if (!gather || !dir) {
    const gh = deps.gh || defaultGhRunner;
    const git = deps.git || gh;
    const buildContext = deps.buildContext || defaultBuildContext;
    const ctx = await buildContext({ pr, gh, git, projectRoot });
    const adapter = deps.adapter || new PrStateAdapter({ gh, git });
    const validation = validatePrStateAdapter(adapter);
    if (!validation.valid) {
      return { error: `Invalid pr-state adapter: ${validation.errors.join('; ')}` };
    }
    let gitCommonDir = deps.gitCommonDir;
    if (!gitCommonDir) {
      try {
        const resolveGitCommonDir = deps.resolveGitCommonDir || brokerMod.resolveGitCommonDir;
        gitCommonDir = resolveGitCommonDir(projectRoot || process.cwd(), { warn: () => {} });
      } catch {
        /* unavailable common-dir keeps the legacy per-root journal fallback */
      }
    }
    dir = dir || monitorJournal.journalDir({
      root: projectRoot || process.cwd(), gitCommonDir, repo: ctx.repo, pr: ctx.pr,
    });
    gather = gather || (() => gatherMonitorSnapshot({ ...ctx, adapter, self: deps.self }));
    cleanupEvidence = cleanupEvidence || (() => terminalCleanupEvidence({
      ...ctx, dir, projectRoot: projectRoot || process.cwd(), gitCommonDir,
    }, deps));
    enrich = enrich || makeCheckFailureEnricher({
      ...ctx,
      adapter,
      self: deps.self,
      runGh: (ghArgs) => gh('gh', ghArgs),
      gatherPull: deps.gatherPull,
    });
    if (!deps.store) {
      const buildKernelDeps = deps.buildKernelDeps
        || require('../kernel/cli-broker-factory').buildMigratedKernelIssueDeps;
      const createMonitorStore = deps.createMonitorStore
        || require('../../packages/memory').createMonitorStore;
      let kernel;
      try {
        kernel = await buildKernelDeps({ projectRoot: projectRoot || process.cwd(), gitCommonDir });
        const repositoryIdentity = privacySafeIdentity(`${ctx.owner}/${ctx.repo}`);
        authority = {
          store: createMonitorStore(kernel.kernelDriver),
          monitorId: rootMonitorId(ctx.owner, ctx.repo, ctx.pr),
          ownerRunId: privacySafeIdentity(`shepherd:${repositoryIdentity}:${ctx.pr}`),
          packetId: privacySafeIdentity(`shepherd-packet:${repositoryIdentity}:${ctx.pr}`),
          subjectId: privacySafeIdentity(`${repositoryIdentity}#${ctx.pr}`),
          close: async () => kernel.kernelBroker?.close?.(),
        };
      } catch (error) {
        try { await kernel?.kernelBroker?.close?.(); } catch { /* fallback must remain available */ }
        if (deps.forceAuthority) {
          return { error: `Durable monitor authority is unavailable: ${error.message}` };
        }
        authority = {};
      }
    }
  } else if (!enrich && deps.gatherPull) {
    // Injected gather (tests / programmatic callers) still gets the default
    // enrichment when a pull-signal source is supplied.
    enrich = makeCheckFailureEnricher({
      pr, adapter: deps.adapter, self: deps.self, runGh: deps.runGh, gatherPull: deps.gatherPull,
    });
  }
  if (deps.forceAuthority && !authority.store) {
    return { error: 'Durable monitor authority is unavailable.' };
  }
  return { dir, gather, enrich, terminalCleanupEvidence: cleanupEvidence, ...authority };
}

/**
 * `forge shepherd events <pr> --since <seq> [--json]` — the agent-agnostic PULL
 * surface. Runs one bounded gather+diff (inline, unless a watcher owns the PR),
 * appends new events to the per-PR journal, and prints every journaled event
 * with `seq > since` as NDJSON, one per line, to stdout. Nothing under .claude.
 *
 * @param {string[]} args
 * @param {string} projectRoot
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
async function handleEvents(args, projectRoot, deps = {}) {
  const rawArgs = args || [];
  const sinceIdx = rawArgs.indexOf('--since');
  const pr = rawArgs.find((a, idx) => !String(a).startsWith('--') && a !== 'events' && idx !== sinceIdx + 1);
  if (!pr) {
    return { success: false, error: 'Usage: forge shepherd events <pr> --since <seq> [--json]' };
  }
  const since = parseSince(rawArgs);

  const built = await buildMonitorContext(pr, projectRoot, deps);
  if (built.error) return { success: false, error: built.error };
  const poll = deps.pollEvents || pollEvents;
  let result;
  try {
    result = await poll({
      ...built, since, now: deps.now, watcherRunning: deps.watcherRunning,
    });
  } finally {
    await built.close?.();
  }
  // `output` is the agent-agnostic pull surface: NDJSON, one event per line. The
  // registry CLI dispatch prints `result.output` (same contract as --pull/--bundle),
  // so this handler does NOT write to stdout itself (that would double-print).
  const overflow = result.overflow === true;
  const overflowRecord = overflow ? {
    type: 'monitor.overflow',
    since: result.since,
    firstAvailableSeq: result.events[0]?.seq ?? null,
    action: 'restart-from-checkpoint',
  } : null;
  const outputRecords = overflowRecord ? [overflowRecord, ...result.events] : result.events;
  const output = outputRecords.map((event) => JSON.stringify(event)).join('\n');
  return { success: true, events: result.events, since: result.since, overflow, output };
}

/**
 * Wire an AbortController to SIGINT/SIGTERM so a long-running watch loop stops
 * cleanly on Ctrl-C. Returns the signal plus a `cleanup` that detaches the
 * one-shot handlers (always called in a finally so the loop leaves no listeners).
 *
 * @returns {{ signal: object, cleanup: () => void }}
 */
function wireSignals() {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const cleanup = () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
  return { signal: controller.signal, cleanup };
}

/**
 * `forge shepherd watch <pr>` — the agent-agnostic PUSH surface. A long-running
 * loop that every ~60s (jittered) runs ONE bounded monitor pass and STREAMS each
 * new event as an NDJSON line to stdout, self-stopping on `pr.merged`/`pr.closed`.
 * The loop streams live via the default stdout emit, so this handler returns NO
 * `output` field (returning one would double-print). SIGINT/SIGTERM stop it clean.
 *
 * @param {string[]} args
 * @param {string} projectRoot
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
/**
 * List every OPEN PR number via `gh pr list`. Fail-open: any error yields an
 * empty list (adopt then arms nothing) rather than throwing.
 *
 * @param {Function} [exec] - gh runner (test injection).
 * @returns {number[]}
 */
function defaultListOpenPrs(exec = execFileSync) {
  try {
    const out = exec('gh', ['pr', 'list', '--state', 'open', '--json', 'number', '-q', '.[].number'], {
      encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    return String(out)
      .split(/\r?\n/)
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * `forge shepherd watch --adopt` — arm a detached watcher for EVERY currently-open
 * PR (covers PRs created via gh/UI, or before this rail existed). Idempotent: the
 * watch loop's PID/journal lock means an already-watched PR is not double-started.
 * Fail-open per PR and overall — never throws. Honors the default-ON
 * `rail.auto_shepherd` rail: when a maintainer has disabled it, adoption is a
 * no-op — no PR listing, no watcher spawn — matching `forge push`/`forge ship`.
 *
 * @param {string} projectRoot
 * @param {object} [deps]
 * @returns {{ success: true, adopted: number[], total: number, reason?: string }}
 */
function handleAdopt(projectRoot, deps = {}) {
  const railEnabled = deps.railEnabled || autoShepherdRailEnabled;
  // Gate BEFORE listing PRs / spawning watchers: a disabled rail must not spawn
  // detached watchers. No-op result mirrors the fail-open (empty) adoption shape.
  if (!railEnabled(projectRoot)) {
    return { success: true, adopted: [], total: 0, reason: 'rail.auto_shepherd disabled' };
  }
  const listOpenPrs = deps.listOpenPrs || defaultListOpenPrs;
  const startWatcher = deps.startWatcher || startPrWatcherDetached;
  let prs;
  try {
    prs = listOpenPrs();
  } catch {
    prs = [];
  }
  if (!Array.isArray(prs)) prs = [];
  const adopted = [];
  for (const pr of prs) {
    try {
      const res = startWatcher({ prNumber: pr, cwd: projectRoot });
      if (res?.started) adopted.push(pr);
    } catch { /* fail-open per PR: one bad arm never blocks the rest */ }
  }
  return { success: true, adopted, total: prs.length };
}

async function handleWatch(args, projectRoot, deps = {}) {
  const rawArgs = args || [];
  // `--adopt` (no PR arg): arm a detached watcher for every open PR.
  if (rawArgs.includes('--adopt')) {
    return handleAdopt(projectRoot, deps);
  }
  const pr = rawArgs.find((a) => !String(a).startsWith('--') && a !== 'watch');
  if (!pr) {
    return { success: false, error: 'Usage: forge shepherd watch <pr> | forge shepherd watch --adopt' };
  }

  const built = await buildMonitorContext(pr, projectRoot, deps);
  if (built.error) return { success: false, error: built.error };
  const loop = deps.watchLoop || watchLoop;
  // Injected signal (tests) suppresses real process handlers; otherwise wire them.
  const wired = deps.signal ? { signal: deps.signal, cleanup: () => {} } : wireSignals();
  let result;
  try {
    result = await loop({
      ...built,
      now: deps.now,
      emit: deps.emit,
      sleep: deps.sleep,
      rng: deps.rng,
      intervalMs: deps.intervalMs,
      maxPasses: deps.maxPasses,
      lockOpts: deps.lockOpts,
      signal: wired.signal,
      terminalCleanupEvidence: deps.terminalCleanupEvidence || (() => ({ complete: false })),
      watcherRunning: deps.watcherRunning,
      writePid: deps.writePid,
      removePid: deps.removePid,
    });
  } finally {
    wired.cleanup();
    await built.close?.();
  }

  return {
    success: true,
    started: result.started,
    passes: result.passes,
    stopped: result.stopped,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

/**
 * `forge shepherd daemon` — the SINGLETON reconcile daemon (W-S4b). It acquires
 * the machine-wide shepherd lease for this repo (exiting immediately if a live
 * daemon already owns it), heartbeats, and converges the PR world every ~60s:
 * self-registering hand-opened PRs, restarting killed watchers, reaping verified
 * orphans, retiring merged/closed PRs. It self-retires (releases the lease, kills
 * its verified children, exits) once no PRs remain open. Launched detached by the
 * per-command `fireAndForget` trigger — not meant to be run by hand.
 *
 * @param {string} projectRoot
 * @param {object} [deps] - injected for tests (acquire/heartbeat/gather/etc.).
 * @returns {Promise<object>} result envelope.
 */
async function handleDaemon(projectRoot, deps = {}) {
  const res = await reconcileExecutor.runDaemon(projectRoot, { ...deps });
  if (!res.ok) {
    // A live foreign daemon owns the lease — this invocation is a clean no-op.
    return { success: true, started: false, reason: res.reason || 'foreign-lease' };
  }
  return { success: true, started: true };
}

async function collectConvergenceEvidence({ args, pr, projectRoot, context, adapter, deps }) {
  const built = await buildMonitorContext(pr, projectRoot, {
    ...deps,
    adapter,
    buildContext: async () => context,
    forceAuthority: true,
  });
  if (built.error) throw new Error(built.error);
  try {
    const polled = await (deps.pollEvents || pollEvents)({
      ...built,
      since: parseSince(args),
      now: deps.now,
      watcherRunning: () => false,
    });
    const current = await adapter.readState(pr);
    const exactHead = typeof current?.headSha === 'string' && /^[0-9a-f]{40}$/i.test(current.headSha)
      ? current.headSha.toLowerCase()
      : null;
    const expectedHead = typeof context.headSha === 'string' && /^[0-9a-f]{40}$/i.test(context.headSha)
      ? context.headSha.toLowerCase()
      : null;
    if (!exactHead || exactHead !== expectedHead) {
      throw new Error('PR head changed after the shepherd pass; rerun convergence on the current head');
    }
    return {
      deltas: Array.isArray(polled.events) ? polled.events : [],
      deltaOverflow: polled.overflow === true,
      receiptIds: Array.isArray(polled.receiptIds) ? polled.receiptIds : [],
      continuationPending: polled.continuationPending === true,
      ...(polled.terminalReceiptId ? { terminalReceiptId: polled.terminalReceiptId } : {}),
      exactHead,
    };
  } finally {
    await built.close?.();
  }
}

function convergenceHandoff(state, pr, evidence, repository) {
  if (state === 'MERGE_READY') {
    return {
      next: 'merge',
      command: `forge merge --auto ${pr} --expect-head ${evidence.exactHead || '<exact-head>'} --issue <issue-id> --repo ${repository}`,
      humanApprovalRequired: true,
    };
  }
  if (state === 'MERGED') {
    return {
      next: 'verify',
      command: 'forge verify',
      terminalReceiptId: evidence.terminalReceiptId || null,
    };
  }
  if (state === 'NEEDS_REVIEW') {
    return { next: 'review', command: 'forge review', resolvesThreads: false };
  }
  return null;
}

/**
 * Command handler.
 *
 * @param {string[]} args - Positional + flag args (first positional is the PR).
 * @param {object} _flags - Parsed flags (unused; flags are read from args).
 * @param {string} projectRoot - Project root.
 * @param {object} [deps] - Injected dependencies for testing.
 * @returns {Promise<object>} result envelope.
 */
async function handler(args, _flags, projectRoot, deps = {}) {
  const positional = (args || []).filter((a) => !String(a).startsWith('--'));
  const flags = new Set((args || []).filter((a) => String(a).startsWith('--')));

  // Subcommand routing: `events` is the monitor pull surface (its own arg shape);
  // `watch` is the constant monitor push surface (long-running stream).
  if (positional[0] === 'events') {
    return handleEvents(args, projectRoot, deps);
  }
  if (positional[0] === 'watch') {
    return handleWatch(args, projectRoot, deps);
  }
  if (positional[0] === 'daemon') {
    return handleDaemon(projectRoot, deps);
  }

  const pr = positional[0];

  if (!pr) {
    return { success: false, error: 'Usage: forge shepherd <pr> [--auto-rebase] [--bundle --json] [--pull --json]' };
  }

  const gh = deps.gh || ((cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', timeout: 30000, windowsHide: true }));
  const git = deps.git || gh;
  const buildContext = deps.buildContext || defaultBuildContext;
  const runPass = deps.runPass || runShepherdPass;
  const gatherBundle = deps.gatherBundle || gatherPrBundle;
  const gatherPull = deps.gatherPull || gatherPullSignal;

  const autoRebase = flags.has('--auto-rebase');
  const wantBundle = flags.has('--bundle');
  const wantPull = flags.has('--pull');
  const wantJson = flags.has('--json');

  const ctx = await buildContext({ pr, gh, git, projectRoot });

  const adapter = deps.adapter || new PrStateAdapter({ gh, git });
  const validation = validatePrStateAdapter(adapter);
  if (!validation.valid) {
    return { success: false, error: `Invalid pr-state adapter: ${validation.errors.join('; ')}` };
  }

  // --pull: gather the COMPACT "why it failed + what to fix" payload (failed-check
  // log excerpts, matrix-deduped, plus the review-thread fix-list). STRICTLY
  // READ-ONLY — it computes the decision state via a dry-run pass but takes NO
  // action (no Tier-A rerun, no rebase); acting belongs to plain `forge shepherd`.
  // The `gh` calls to fetch logs run through an injected runner so this stays testable.
  if (wantPull) {
    const runGh = (ghArgs) => gh('gh', ghArgs);
    const pull = await gatherPull({ ...ctx, adapter, runGh, runPass, self: deps.self });
    // `output` is what the registry CLI dispatch (bin/forge.js) actually PRINTS —
    // returning only `pull` silently dropped the whole payload on that path (it
    // prints `result.output`, nothing else). `--json` → machine payload; default
    // → the compact human WHY+fix summary. `pull` is kept for the legacy
    // bin/forge-cmd.js path and for programmatic callers/tests.
    const output = wantJson ? JSON.stringify(pull, null, 2) : renderPullSummary(pull);
    return { success: true, pull, output };
  }

  // --bundle: gather the COMPLETE read-only PR-state bundle the monitor will
  // hand to a fixer-agent, and return it for the CLI to print as JSON. This is
  // the gather half only — it decides nothing and takes no action.
  if (wantBundle) {
    const bundle = await gatherBundle({ ...ctx, adapter });
    // Same rationale as --pull: the registry dispatch prints `output`. The bundle
    // is a machine payload, so it is always emitted as JSON.
    return { success: true, bundle, output: JSON.stringify(bundle, null, 2) };
  }

  const runPreflight = deps.runLocalPreflight || runLocalReviewPreflight;
  const preflightHead = ctx.headSha;
  const cleanTree = isWorkingTreeClean(git);
  let localPreflight;
  try {
    localPreflight = await runPreflight({
      projectRoot: projectRoot || process.cwd(),
      base: ctx.base,
      baseRef: ctx.baseRef,
      pr: String(pr),
      expectedHead: ctx.headSha,
      localHead: ctx.localHead,
      cleanTree,
    });
  } catch (error) {
    localPreflight = {
      status: 'FAIL',
      blocking: true,
      providers: {},
      findings: [{ provider: 'local-preflight', detail: error?.message || String(error) }],
    };
  }

  if (localPreflight.blocking !== true) {
    let postPreflightHead = null;
    try {
      const candidate = git('git', ['rev-parse', 'HEAD']).trim();
      if (/^[0-9a-f]{40}$/i.test(candidate)) postPreflightHead = candidate.toLowerCase();
    } catch {
      /* unreadable mutable checkout fails the fence below */
    }
    const expectedLocalHead = typeof ctx.localHead === 'string' ? ctx.localHead.toLowerCase() : null;
    if (!postPreflightHead || postPreflightHead !== expectedLocalHead || !isWorkingTreeClean(git)) {
      localPreflight = {
        ...localPreflight,
        status: 'INCOMPLETE',
        blocking: true,
        findings: [
          ...(Array.isArray(localPreflight.findings) ? localPreflight.findings : []),
          { provider: 'local-preflight', detail: 'Local checkout changed during local review; rerun on the exact clean PR head.' },
        ],
      };
    }
  }

  const result = await runPass({
    ...ctx,
    adapter,
    autoRebase,
    cleanTree: autoRebase ? cleanTree : false,
    rerunBudget: deps.rerunBudget || DEFAULT_RERUN_BUDGET,
    rerunsUsed: deps.rerunsUsed || 0,
    dryRun: localPreflight.blocking === true,
  });

  const collectEvidence = deps.collectConvergenceEvidence || collectConvergenceEvidence;
  let evidence;
  try {
    const evidenceContext = result.expectedHead ? { ...ctx, headSha: result.expectedHead } : ctx;
    evidence = await collectEvidence({ args, pr, projectRoot, context: evidenceContext, adapter, deps });
  } catch (error) {
    const reason = `Durable convergence evidence is unavailable: ${error.message}`;
    writePassSummary(pr, 'INCOMPLETE', reason, result.actions);
    return {
      success: false,
      state: 'INCOMPLETE',
      remoteState: result.state,
      reason,
      actions: result.actions || [],
      localPreflight,
      deltas: [],
      deltaOverflow: false,
      receiptIds: [],
    };
  }

  const normalizedPreflightHead = typeof preflightHead === 'string' ? preflightHead.toLowerCase() : null;
  const normalizedResultHead = typeof result.expectedHead === 'string' ? result.expectedHead.toLowerCase() : null;
  if (localPreflight.blocking !== true && result.state === 'MERGE_READY'
    && normalizedPreflightHead && normalizedResultHead && normalizedResultHead !== normalizedPreflightHead) {
    return {
      success: false,
      state: 'INCOMPLETE',
      remoteState: result.state,
      reason: 'Local preflight head changed; rerun convergence on the current head',
      actions: result.actions || [],
      localPreflight,
      deltas: evidence.deltas,
      deltaOverflow: evidence.deltaOverflow,
      receiptIds: evidence.receiptIds,
    };
  }

  let confirmedResult = result;
  if (localPreflight.blocking !== true && result.state === 'MERGE_READY'
    && evidence.continuationPending !== true) {
    const confirmation = await runPass({
      ...ctx,
      adapter,
      autoRebase: false,
      cleanTree: false,
      rerunBudget: deps.rerunBudget || DEFAULT_RERUN_BUDGET,
      rerunsUsed: deps.rerunsUsed || 0,
      dryRun: true,
    });
    confirmedResult = {
      ...confirmation,
      actions: [...(result.actions || []), ...(confirmation.actions || [])],
    };
    const confirmedHead = typeof confirmedResult.expectedHead === 'string'
      ? confirmedResult.expectedHead.toLowerCase()
      : null;
    if (confirmedResult.state === 'MERGE_READY' && confirmedHead !== evidence.exactHead) {
      return {
        success: false,
        state: 'INCOMPLETE',
        remoteState: confirmedResult.state,
        reason: 'PR head changed while confirming mutable merge-readiness evidence; rerun convergence on the current head',
        actions: confirmedResult.actions,
        localPreflight,
        deltas: evidence.deltas,
        deltaOverflow: evidence.deltaOverflow,
        receiptIds: evidence.receiptIds,
      };
    }
    if (confirmedResult.state !== result.state) {
      try {
        const evidenceContext = confirmedResult.expectedHead
          ? { ...ctx, headSha: confirmedResult.expectedHead }
          : ctx;
        evidence = await collectEvidence({ args, pr, projectRoot, context: evidenceContext, adapter, deps });
      } catch (error) {
        return {
          success: false,
          state: 'INCOMPLETE',
          remoteState: confirmedResult.state,
          reason: `Confirmed convergence evidence is unavailable: ${error.message}`,
          actions: confirmedResult.actions,
          localPreflight,
          deltas: evidence.deltas,
          deltaOverflow: evidence.deltaOverflow,
          receiptIds: evidence.receiptIds,
        };
      }
    }
  }

  if (confirmedResult.state === 'MERGED' && !evidence.terminalReceiptId) {
    return {
      success: false,
      state: 'INCOMPLETE',
      remoteState: confirmedResult.state,
      reason: 'Confirmed merged state has no durable terminal receipt',
      actions: confirmedResult.actions,
      localPreflight,
      deltas: evidence.deltas,
      deltaOverflow: evidence.deltaOverflow,
      receiptIds: evidence.receiptIds,
    };
  }

  const effectiveState = evidence.continuationPending === true
    ? 'PENDING'
    : localPreflight.blocking === true && confirmedResult.state === 'MERGE_READY'
      ? (localPreflight.status === 'INCOMPLETE' ? 'INCOMPLETE' : 'PENDING')
      : confirmedResult.state;
  const effectiveReason = effectiveState !== confirmedResult.state
    ? (evidence.continuationPending === true
      ? 'Durable convergence work remains; run another bounded shepherd pass.'
      : effectiveState === 'INCOMPLETE'
        ? 'Local review preflight is incomplete; merge readiness is not established.'
        : 'Local review preflight is blocking merge readiness.')
    : confirmedResult.reason;

  // Surface the pass outcome so the monitor is legible when run interactively or
  // tailed by a scheduler (the bounded state machine is otherwise silent).
  writePassSummary(pr, effectiveState, effectiveReason, confirmedResult.actions);

  return {
    success: effectiveState !== 'HARD_STOP' && effectiveState !== 'INCOMPLETE',
    state: effectiveState,
    ...(effectiveState !== confirmedResult.state ? { remoteState: confirmedResult.state } : {}),
    reason: effectiveReason,
    actions: confirmedResult.actions || [],
    localPreflight,
    deltas: evidence.deltas,
    deltaOverflow: evidence.deltaOverflow,
    receiptIds: evidence.receiptIds,
    continuationPending: evidence.continuationPending === true,
    ...(evidence.terminalReceiptId ? { terminalReceiptId: evidence.terminalReceiptId } : {}),
    ...(convergenceHandoff(effectiveState, pr, evidence, `${ctx.owner}/${ctx.repo}`)
      ? { handoff: convergenceHandoff(effectiveState, pr, evidence, `${ctx.owner}/${ctx.repo}`) }
      : {}),
    ...(confirmedResult.authClass ? { authClass: confirmedResult.authClass } : {}),
    ...(confirmedResult.retryAfter ? { retryAfter: confirmedResult.retryAfter } : {}),
  };
}

module.exports = {
  name: 'shepherd',
  description: 'Run one bounded monitor pass over a PR (rerun flaky checks, escalate, hand off — never merges)',
  usage: 'Usage: forge shepherd <pr> [--auto-rebase] [--bundle --json] [--pull --json] | forge shepherd events <pr> --since <seq> [--json] | forge shepherd watch <pr> | forge shepherd watch --adopt',
  handler,
  handleEvents,
  handleWatch,
  buildMonitorContext,
  makeCheckFailureEnricher,
  parseSince,
  collectConvergenceEvidence,
  convergenceHandoff,
  defaultBuildContext,
  isWorkingTreeClean,
  terminalCleanupEvidence,
};
