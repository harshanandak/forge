'use strict';

/**
 * merge command — opt-in conditional auto-merge.
 *
 * `forge merge --auto <pr>` is the ONLY path by which Forge will merge a PR on
 * its own, and it stays OFF unless the user has explicitly opted in. It reads
 * the `merge.auto` section of `.forge/config.yaml`:
 *
 *   merge:
 *     auto:
 *       enabled: true           # default false / absent → strict NO-OP
 *       rules:                  # ALL must pass (see lib/merge-rules.js)
 *         - checks_green        # or scope it, e.g. for a docs-only task that
 *                               # may take a coverage dip:
 *                               #   - checks_green: { ignore: ["Coverage"] }
 *         - threads_resolved
 *         - no_conflicts        # recommended: never merge a conflicting branch
 *         - not_behind
 *         - settle_min: 10
 *
 * Flow: with no config (or `enabled` not true) the command is a strict NO-OP —
 * it prints why and merges nothing, preserving the test-enforced
 * never-auto-merge-by-default invariant. When enabled, it fetches the PR
 * context via `gh`, evaluates the rules with the pure `evaluateMergeRules`, and
 * merges ONLY when every rule passes. Two extra safety layers wrap that decision:
 * a pre-flight guard that no-ops on an already merged/closed PR (idempotent
 * re-runs), and a TOCTOU live re-check that re-fetches and re-evaluates right
 * before merging so a stale snapshot can never merge a since-changed PR. The
 * gh-fetch and the merge action are isolated behind injectable `fetchPrContext`
 * / `mergePr` seams so the decision path is unit-testable without the network.
 *
 * A bring-your-own custom-predicate seam (registered via `forge add`) is a
 * documented follow-up and intentionally NOT wired here. Further follow-ups
 * documented in lib/merge-rules.js: opt-in `auto_update`, required-checks
 * scoping for `checks_green`, a configurable merge `method`, and post-merge
 * branch deletion.
 *
 * @module commands/merge
 */

const { execFileSync } = require('node:child_process');

const { loadRawConfig } = require('../config-writer');
const { evaluateMergeRules } = require('../merge-rules');

/** Default `gh` runner. Only reached by the default fetch/merge seams (never in unit tests). */
function defaultGh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...options });
}

/** Parse `gh ... --json` output, returning `null` on any failure (callers fail closed). */
function ghJson(gh, args) {
  try {
    return JSON.parse(gh(args) || '{}');
  } catch (_err) {
    return null;
  }
}

/**
 * Read the unresolved review-thread count via the GraphQL API. `reviewThreads`
 * is not a valid `gh pr view --json` field, so this needs a dedicated query.
 * Returns `undefined` on any failure so `threads_resolved` fails closed.
 */
function fetchUnresolvedThreadCount(gh, pr) {
  try {
    const repo = ghJson(gh, ['repo', 'view', '--json', 'owner,name']);
    const owner = repo && repo.owner && repo.owner.login;
    const name = repo && repo.name;
    if (!owner || !name) return undefined;
    const query = 'query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n)'
      + '{pullRequest(number:$pr){reviewThreads(first:100){pageInfo{hasNextPage}nodes{isResolved isOutdated}}}}}';
    const out = gh(['api', 'graphql', '-f', `query=${query}`,
      '-F', `o=${owner}`, '-F', `n=${name}`, '-F', `pr=${Number(pr)}`]);
    const data = JSON.parse(out || '{}');
    const threads = (((data.data || {}).repository || {}).pullRequest || {}).reviewThreads;
    // >100 threads → the returned page is truncated and the count unreliable;
    // return undefined so threads_resolved fails closed rather than trusting it.
    if (threads && threads.pageInfo && threads.pageInfo.hasNextPage) return undefined;
    const list = (threads && threads.nodes) || [];
    return list.filter((t) => t && t.isResolved === false && t.isOutdated === false).length;
  } catch (_err) {
    return undefined;
  }
}

/**
 * Default PR-context fetcher (the network seam). Assembles the shape consumed
 * by `evaluateMergeRules` from `gh`. Anything it cannot read is left absent so
 * the dependent rule fails closed rather than guessing. Fully replaced by
 * `deps.fetchPrContext` in tests.
 *
 * @returns {object} prContext
 */
function defaultFetchPrContext({ pr, gh = defaultGh, now = Date.now() }) {
  const view = ghJson(gh, ['pr', 'view', String(pr), '--json',
    'number,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,reviews,comments,updatedAt']) || {};

  const rollup = Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : null;
  const checks = (rollup || []).map((c) => ({
    name: c.name || c.context || '?',
    conclusion: String(c.conclusion || c.state || c.status || ''),
  }));

  const comments = Array.isArray(view.comments)
    ? view.comments.map((c) => ({
      author: (c.author && c.author.login) || '',
      at: c.createdAt || c.submittedAt || '',
    }))
    : [];

  const reviews = Array.isArray(view.reviews) ? view.reviews : [];
  const approvals = reviews
    .filter((r) => String(r.state).toUpperCase() === 'APPROVED')
    .map((r) => ({ author: (r.author && r.author.login) || '' }));

  // Derive from GitHub's mergeStateStatus / mergeable. Only a known set maps to
  // a definite answer; anything else stays undefined so the dependent rule fails
  // closed rather than guessing.
  const mergeStateStatus = String(view.mergeStateStatus || '').toUpperCase();
  const mergeable = String(view.mergeable || '').toUpperCase();

  let behindBase;
  if (mergeStateStatus === 'BEHIND') behindBase = true;
  else if (['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BLOCKED', 'DIRTY'].includes(mergeStateStatus)) behindBase = false;

  // Conflict status: DIRTY (or mergeable=CONFLICTING) → conflicting; a clean set
  // of states → not conflicting; UNKNOWN / missing / still-computing → undefined.
  let conflicting;
  if (mergeStateStatus === 'DIRTY' || mergeable === 'CONFLICTING') conflicting = true;
  else if (['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BLOCKED'].includes(mergeStateStatus)) conflicting = false;

  const isDraft = typeof view.isDraft === 'boolean' ? view.isDraft : undefined;
  const state = view.state ? String(view.state).toUpperCase() : undefined;

  const stamps = [
    ...comments.map((c) => c.at),
    ...reviews.map((r) => r.submittedAt || r.createdAt || ''),
    view.updatedAt || '',
  ].map((s) => Date.parse(s)).filter((n) => !Number.isNaN(n));
  const lastActivityAt = stamps.length ? Math.max(...stamps) : undefined;

  return {
    checks,
    requiredChecksKnown: rollup !== null,
    unresolvedThreads: fetchUnresolvedThreadCount(gh, pr),
    behindBase,
    conflicting,
    isDraft,
    state,
    approvals,
    comments,
    lastActivityAt,
    now,
  };
}

/** Default merge action (squash). Fully replaced by `deps.mergePr` in tests. */
function defaultMergePr({ pr, gh = defaultGh }) {
  gh(['pr', 'merge', String(pr), '--squash']);
  return { merged: true, method: 'squash' };
}

/**
 * Command handler.
 *
 * @param {string[]} args - Positional + flag args (first positional is the PR).
 * @param {object} _flags - Parsed flags (unused; flags are read from args).
 * @param {string} projectRoot - Project root.
 * @param {object} [deps] - Injected seams for testing: loadConfig, fetchPrContext, mergePr, gh, now.
 * @returns {Promise<object>} result envelope.
 */
async function handler(args, _flags, projectRoot, deps = {}) {
  const argv = Array.isArray(args) ? args : [];
  const positional = argv.filter((a) => !String(a).startsWith('--'));
  const flags = new Set(argv.filter((a) => String(a).startsWith('--')));
  const pr = positional[0];
  const root = projectRoot || process.cwd();

  if (!flags.has('--auto')) {
    return { success: false, error: 'Usage: forge merge --auto <pr>  (opt-in conditional auto-merge; OFF by default)' };
  }
  if (!pr) {
    return { success: false, error: 'Usage: forge merge --auto <pr>' };
  }

  const loadConfig = deps.loadConfig || loadRawConfig;
  let config;
  try {
    config = loadConfig(root) || {};
  } catch (err) {
    // A malformed .forge/config.yaml must NOT crash the command — fail closed:
    // refuse to auto-merge and report, rather than throwing past the contract.
    const reason = `Could not read merge config (${err.message}) — refusing to auto-merge (fail-closed).`;
    process.stdout.write(`${reason}\n`);
    return { success: false, merged: false, error: reason };
  }
  const auto = (config.merge && config.merge.auto) || {};
  const enabled = auto.enabled === true;
  const rules = Array.isArray(auto.rules) ? auto.rules : [];

  // Invariant: absent config or `enabled` not true → strict NO-OP. Forge never
  // auto-merges unless the user has explicitly opted in via .forge/config.yaml.
  if (!enabled) {
    const reason = 'Auto-merge is OPT-IN and OFF by default (merge.auto.enabled is not true in .forge/config.yaml). No action taken.';
    process.stdout.write(`${reason}\n`);
    return { success: true, merged: false, enabled: false, reason };
  }

  // Opted in but no rules → refuse (fail-closed): an empty ruleset is vacuously
  // "allowed", which would merge unconditionally. Treat that as misconfiguration.
  if (rules.length === 0) {
    const reason = 'merge.auto.enabled is true but no rules are configured — refusing to auto-merge (fail-closed). Add rules under merge.auto.rules.';
    process.stdout.write(`${reason}\n`);
    return { success: false, merged: false, enabled: true, reason };
  }

  const fetchPrContext = deps.fetchPrContext || defaultFetchPrContext;
  const mergePr = deps.mergePr || defaultMergePr;
  const gh = deps.gh || defaultGh;

  let prContext;
  try {
    prContext = await fetchPrContext({ pr, projectRoot: root, gh, now: deps.now || Date.now() });
  } catch (err) {
    return { success: false, merged: false, error: `Failed to fetch PR context: ${err.message}` };
  }

  // Pre-flight: a PR that is already merged or closed is terminal. Re-running the
  // command must be an idempotent NO-OP — never an error and never a second merge
  // attempt. (An absent/unknown state falls through to the fail-closed rules.)
  const prState = prContext && prContext.state ? String(prContext.state).toUpperCase() : '';
  if (prState && prState !== 'OPEN') {
    const reason = `PR #${pr} is ${prState} (not OPEN) — nothing to merge. No action taken.`;
    process.stdout.write(`${reason}\n`);
    return { success: true, merged: false, enabled: true, state: prState, reason };
  }

  const { allowed, unmet } = evaluateMergeRules(prContext, rules);

  if (!allowed) {
    process.stdout.write(`Auto-merge conditions NOT met for PR #${pr} — ${unmet.length} unmet rule(s):\n`);
    for (const item of unmet) {
      process.stdout.write(`  x ${item.rule} — ${item.reason}\n`);
    }
    return { success: true, merged: false, enabled: true, allowed: false, unmet, reason: 'auto-merge conditions not met' };
  }

  // TOCTOU guard: PR state can change between the first fetch and the merge — a
  // new comment resets settle_min, a required check regresses, a thread opens.
  // Re-pull LIVE data and re-evaluate immediately before merging so our custom
  // rules (which GitHub's server-side branch protection does NOT enforce) are
  // honored against the freshest possible state, never a stale snapshot.
  let freshContext;
  try {
    freshContext = await fetchPrContext({ pr, projectRoot: root, gh, now: deps.now || Date.now() });
  } catch (err) {
    return { success: false, merged: false, error: `Failed to re-fetch PR context before merge: ${err.message}` };
  }
  // Re-apply the terminal-state guard on the FRESH context: the PR may have been
  // merged or closed between the first fetch and now. Never merge a terminal PR.
  const freshState = freshContext && freshContext.state ? String(freshContext.state).toUpperCase() : '';
  if (freshState && freshState !== 'OPEN') {
    const reason = `PR #${pr} became ${freshState} (not OPEN) before merge — nothing to merge. No action taken.`;
    process.stdout.write(`${reason}\n`);
    return { success: true, merged: false, enabled: true, state: freshState, reason };
  }
  const recheck = evaluateMergeRules(freshContext, rules);
  if (!recheck.allowed) {
    process.stdout.write(`Auto-merge ABORTED for PR #${pr} — state changed since first check; ${recheck.unmet.length} rule(s) now unmet:\n`);
    for (const item of recheck.unmet) {
      process.stdout.write(`  x ${item.rule} — ${item.reason}\n`);
    }
    return { success: true, merged: false, enabled: true, allowed: false, unmet: recheck.unmet, reason: 'PR state changed before merge (live re-check failed)' };
  }

  try {
    const mergeResult = await mergePr({ pr, projectRoot: root, gh });
    process.stdout.write(`All ${rules.length} merge rule(s) passed — merged PR #${pr}.\n`);
    return {
      success: true,
      merged: true,
      enabled: true,
      allowed: true,
      reason: 'all merge rules passed',
      ...(mergeResult && typeof mergeResult === 'object' ? mergeResult : {}),
    };
  } catch (err) {
    return { success: false, merged: false, error: `Merge failed: ${err.message}` };
  }
}

module.exports = {
  name: 'merge',
  description: 'Opt-in conditional auto-merge: merge a PR only when all user-configured rules pass (OFF by default)',
  usage: 'Usage: forge merge --auto <pr>',
  handler,
  // Exported seams for testing / reuse.
  defaultFetchPrContext,
  defaultMergePr,
};
