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
const monitorJournal = require('../pr-monitor/journal');

const DEFAULT_RERUN_BUDGET = 3;

const defaultGhRunner = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', timeout: 30000 });

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

/** Parse `--since <seq>` from the raw arg list (default 0). */
function parseSince(args) {
  const i = (args || []).indexOf('--since');
  if (i >= 0 && args[i + 1] != null) return Number.parseInt(args[i + 1], 10) || 0;
  return 0;
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
  const positional = rawArgs.filter((a, idx) => !String(a).startsWith('--') && a !== 'events' && idx !== sinceIdx + 1);
  const pr = positional[0];
  if (!pr) {
    return { success: false, error: 'Usage: forge shepherd events <pr> --since <seq> [--json]' };
  }
  const since = parseSince(rawArgs);

  let dir = deps.dir;
  let gather = deps.gather;
  if (!gather || !dir) {
    const gh = deps.gh || defaultGhRunner;
    const git = deps.git || gh;
    const buildContext = deps.buildContext || defaultBuildContext;
    const ctx = await buildContext({ pr, gh, git, projectRoot });
    const adapter = deps.adapter || new PrStateAdapter({ gh, git });
    const validation = validatePrStateAdapter(adapter);
    if (!validation.valid) {
      return { success: false, error: `Invalid pr-state adapter: ${validation.errors.join('; ')}` };
    }
    dir = dir || monitorJournal.journalDir({ root: projectRoot || process.cwd(), repo: ctx.repo, pr: ctx.pr });
    gather = gather || (() => gatherMonitorSnapshot({ ...ctx, adapter, self: deps.self }));
  }

  const poll = deps.pollEvents || pollEvents;
  const result = await poll({ dir, gather, since, now: deps.now, watcherRunning: deps.watcherRunning });
  // `output` is the agent-agnostic pull surface: NDJSON, one event per line. The
  // registry CLI dispatch prints `result.output` (same contract as --pull/--bundle),
  // so this handler does NOT write to stdout itself (that would double-print).
  const output = result.events.map((e) => JSON.stringify(e)).join('\n');
  return { success: true, events: result.events, since: result.since, output };
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

  // Subcommand routing: `events` is the monitor pull surface (its own arg shape).
  if (positional[0] === 'events') {
    return handleEvents(args, projectRoot, deps);
  }

  const pr = positional[0];

  if (!pr) {
    return { success: false, error: 'Usage: forge shepherd <pr> [--auto-rebase] [--bundle --json] [--pull --json]' };
  }

  const gh = deps.gh || ((cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', timeout: 30000 }));
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
  usage: 'Usage: forge shepherd <pr> [--auto-rebase] [--bundle --json] [--pull --json] | forge shepherd events <pr> --since <seq> [--json]',
  handler,
  handleEvents,
  parseSince,
  defaultBuildContext,
  isWorkingTreeClean,
};
