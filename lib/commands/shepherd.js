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
 * State persists via GitHub PR comments/labels and git only.
 *
 * @module commands/shepherd
 */

const { execFileSync } = require('node:child_process');

const { runShepherdPass } = require('../pr-shepherd');
const { gatherPrBundle } = require('../pr-bundle');
const { PrStateAdapter } = require('../adapters/pr-state-adapter');
const { validatePrStateAdapter } = require('../pr-state-validator');

const DEFAULT_RERUN_BUDGET = 3;

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
  const pr = positional[0];

  if (!pr) {
    return { success: false, error: 'Usage: forge shepherd <pr> [--auto-rebase] [--bundle --json]' };
  }

  const gh = deps.gh || ((cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', timeout: 30000 }));
  const git = deps.git || gh;
  const buildContext = deps.buildContext || defaultBuildContext;
  const runPass = deps.runPass || runShepherdPass;
  const gatherBundle = deps.gatherBundle || gatherPrBundle;

  const autoRebase = flags.has('--auto-rebase');
  const wantBundle = flags.has('--bundle');

  const ctx = await buildContext({ pr, gh, git, projectRoot });

  const adapter = deps.adapter || new PrStateAdapter({ gh, git });
  const validation = validatePrStateAdapter(adapter);
  if (!validation.valid) {
    return { success: false, error: `Invalid pr-state adapter: ${validation.errors.join('; ')}` };
  }

  // --bundle: gather the COMPLETE read-only PR-state bundle the monitor will
  // hand to a fixer-agent, and return it for the CLI to print as JSON. This is
  // the gather half only — it decides nothing and takes no action.
  if (wantBundle) {
    const bundle = await gatherBundle({ ...ctx, adapter });
    return { success: true, bundle };
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
  usage: 'Usage: forge shepherd <pr> [--auto-rebase] [--bundle --json]',
  handler,
  defaultBuildContext,
  isWorkingTreeClean,
};
