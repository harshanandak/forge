'use strict';

/**
 * shepherd command — one bounded monitor pass over a pull request.
 *
 * `forge shepherd <pr> [--auto-rebase]` reads PR/CI state, takes at most one
 * idempotent Tier-A action (rerun a flaky required check), and exits with a
 * terminal state. It NEVER merges and NEVER resolves review threads. A
 * `--watch` loop, if desired, lives in an external scheduler that re-invokes
 * this command on an interval — there is no in-process polling loop here.
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
 * State persists via GitHub PR comments/labels and git only.
 *
 * @module commands/shepherd
 */

const { execFileSync } = require('node:child_process');

const { runShepherdPass } = require('../pr-shepherd');
const { gatherPrBundle } = require('../pr-bundle');
const { gatherPullSignal, renderPullSummary } = require('../pr-pull');
const { PrStateAdapter } = require('../adapters/pr-state-adapter');
const { validatePrStateAdapter } = require('../pr-state-validator');
const { gatherMonitorSnapshot } = require('../pr-monitor/gather');
const { pollEvents } = require('../pr-monitor/monitor');
const { watchLoop } = require('../pr-monitor/watch');
const { startPrWatcherDetached } = require('../pr-monitor/watch-lifecycle');
const reconcileExecutor = require('../pr-monitor/reconcile-executor');
const monitorJournal = require('../pr-monitor/journal');
const { EVENT_TYPES: T } = require('../pr-monitor/events');
const { autoShepherdRailEnabled } = require('./ship');

const DEFAULT_RERUN_BUDGET = 3;

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
 * The base branch is read from the PR itself (`gh pr view <pr> --json
 * baseRefName`) rather than the current checkout's default branch, so PRs
 * targeting `release/*`/`develop` are evaluated against the correct branch.
 * `owner`/`name` come from the repository the PR is queried in — that IS the
 * base repository. `cwd` (the worktree root) is threaded through so divergence
 * is computed against the right checkout.
 *
 * @param {object} deps
 * @returns {Promise<{ pr: string, owner: string, repo: string, base: string, baseRef: string, cwd?: string }>}
 */
async function defaultBuildContext({ pr, gh, git, projectRoot }) {
  const prJson = gh('gh', ['pr', 'view', String(pr), '--json', 'baseRefName']);
  const prInfo = JSON.parse(prJson || '{}');
  const base = prInfo.baseRefName || 'master';

  const repoJson = gh('gh', ['repo', 'view', '--json', 'owner,name']);
  const repo = JSON.parse(repoJson || '{}');
  const owner = repo.owner?.login || '';
  const name = repo.name || '';

  let baseRemote;
  try {
    baseRemote = git('git', ['remote']).split(/\s+/).filter(Boolean)[0] || 'origin';
  } catch (_err) {
    baseRemote = 'origin';
  }

  return {
    pr: String(pr),
    owner,
    repo: name,
    base,
    baseRef: `${baseRemote}/${base}`,
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
      if (f.excerpt) r.data.excerpt = f.excerpt;
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
    dir = dir || monitorJournal.journalDir({ root: projectRoot || process.cwd(), repo: ctx.repo, pr: ctx.pr });
    gather = gather || (() => gatherMonitorSnapshot({ ...ctx, adapter, self: deps.self }));
    enrich = enrich || makeCheckFailureEnricher({
      ...ctx,
      adapter,
      self: deps.self,
      runGh: (ghArgs) => gh('gh', ghArgs),
      gatherPull: deps.gatherPull,
    });
  } else if (!enrich && deps.gatherPull) {
    // Injected gather (tests / programmatic callers) still gets the default
    // enrichment when a pull-signal source is supplied.
    enrich = makeCheckFailureEnricher({
      pr, adapter: deps.adapter, self: deps.self, runGh: deps.runGh, gatherPull: deps.gatherPull,
    });
  }
  return { dir, gather, enrich };
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
  const { dir, gather, enrich } = built;

  const poll = deps.pollEvents || pollEvents;
  const result = await poll({ dir, gather, since, now: deps.now, watcherRunning: deps.watcherRunning, enrich });
  // `output` is the agent-agnostic pull surface: NDJSON, one event per line. The
  // registry CLI dispatch prints `result.output` (same contract as --pull/--bundle),
  // so this handler does NOT write to stdout itself (that would double-print).
  const output = result.events.map((e) => JSON.stringify(e)).join('\n');
  return { success: true, events: result.events, since: result.since, output };
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
  const { dir, gather, enrich } = built;

  const loop = deps.watchLoop || watchLoop;
  // Injected signal (tests) suppresses real process handlers; otherwise wire them.
  const wired = deps.signal ? { signal: deps.signal, cleanup: () => {} } : wireSignals();
  let result;
  try {
    result = await loop({
      dir,
      gather,
      enrich,
      now: deps.now,
      emit: deps.emit,
      sleep: deps.sleep,
      rng: deps.rng,
      intervalMs: deps.intervalMs,
      maxPasses: deps.maxPasses,
      lockOpts: deps.lockOpts,
      signal: wired.signal,
      watcherRunning: deps.watcherRunning,
      writePid: deps.writePid,
      removePid: deps.removePid,
    });
  } finally {
    wired.cleanup();
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

  const result = await runPass({
    ...ctx,
    adapter,
    autoRebase,
    cleanTree: autoRebase ? isWorkingTreeClean(git) : false,
    rerunBudget: deps.rerunBudget || DEFAULT_RERUN_BUDGET,
    rerunsUsed: deps.rerunsUsed || 0,
  });

  // Surface the pass outcome so the monitor is legible when run interactively or
  // tailed by a scheduler (the bounded state machine is otherwise silent).
  const passActions = Array.isArray(result.actions) ? result.actions : [];
  const reasonSuffix = result.reason ? ` — ${result.reason}` : '';
  process.stdout.write(`Shepherd pass — PR #${pr}: ${result.state}${reasonSuffix}\n`);
  for (const action of passActions) {
    process.stdout.write(`  • ${formatAction(action)}\n`);
  }
  if (!passActions.length) {
    process.stdout.write('  • no actions this pass\n');
  }

  return {
    success: result.state !== 'HARD_STOP',
    state: result.state,
    reason: result.reason,
    actions: result.actions || [],
    ...(result.authClass ? { authClass: result.authClass } : {}),
    ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
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
  defaultBuildContext,
  isWorkingTreeClean,
};
