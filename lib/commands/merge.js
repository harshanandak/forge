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
 *         - checks_green
 *         - threads_resolved
 *         - not_behind
 *         - settle_min: 10
 *
 * Flow: with no config (or `enabled` not true) the command is a strict NO-OP —
 * it prints why and merges nothing, preserving the test-enforced
 * never-auto-merge-by-default invariant. When enabled, it fetches the PR
 * context via `gh`, evaluates the rules with the pure `evaluateMergeRules`, and
 * merges ONLY when every rule passes. The gh-fetch and the merge action are
 * isolated behind injectable `fetchPrContext` / `mergePr` seams so the decision
 * path is unit-testable without the network.
 *
 * A bring-your-own custom-predicate seam (registered via `forge add`) is a
 * documented follow-up and intentionally NOT wired here.
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
      + '{pullRequest(number:$pr){reviewThreads(first:100){nodes{isResolved isOutdated}}}}}';
    const out = gh(['api', 'graphql', '-f', `query=${query}`,
      '-F', `o=${owner}`, '-F', `n=${name}`, '-F', `pr=${Number(pr)}`]);
    const data = JSON.parse(out || '{}');
    const nodes = (((data.data || {}).repository || {}).pullRequest || {}).reviewThreads;
    const list = (nodes && nodes.nodes) || [];
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
    'number,state,mergeStateStatus,statusCheckRollup,reviews,comments,updatedAt']) || {};

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

  // Behind-base from GitHub's mergeStateStatus. Only a known set maps to a
  // definite answer; anything else stays undefined so `not_behind` fails closed.
  const mergeStateStatus = String(view.mergeStateStatus || '').toUpperCase();
  let behindBase;
  if (mergeStateStatus === 'BEHIND') behindBase = true;
  else if (['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BLOCKED', 'DIRTY'].includes(mergeStateStatus)) behindBase = false;

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
  const config = loadConfig(root) || {};
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

  const { allowed, unmet } = evaluateMergeRules(prContext, rules);

  if (!allowed) {
    process.stdout.write(`Auto-merge conditions NOT met for PR #${pr} — ${unmet.length} unmet rule(s):\n`);
    for (const item of unmet) {
      process.stdout.write(`  x ${item.rule} — ${item.reason}\n`);
    }
    return { success: true, merged: false, enabled: true, allowed: false, unmet, reason: 'auto-merge conditions not met' };
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
