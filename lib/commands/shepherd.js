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
 * State persists via GitHub PR comments/labels and git only.
 *
 * @module commands/shepherd
 */

const { execFileSync } = require('node:child_process');

const { runShepherdPass } = require('../pr-shepherd');
const { PrStateAdapter } = require('../adapters/pr-state-adapter');
const { validatePrStateAdapter } = require('../pr-state-validator');

const DEFAULT_RERUN_BUDGET = 3;

/**
 * Resolve owner/repo and base branch for the current checkout using `gh`/`git`.
 *
 * @param {object} deps
 * @returns {Promise<{ owner: string, repo: string, base: string, baseRef: string }>}
 */
async function defaultBuildContext({ pr, gh, git }) {
  const repoJson = gh('gh', ['repo', 'view', '--json', 'owner,name,defaultBranchRef']);
  const repo = JSON.parse(repoJson || '{}');
  const owner = repo.owner && repo.owner.login ? repo.owner.login : '';
  const name = repo.name || '';
  const base = (repo.defaultBranchRef && repo.defaultBranchRef.name) || 'master';

  let baseRemote;
  try {
    baseRemote = git('git', ['remote']).split(/\s+/).filter(Boolean)[0] || 'origin';
  } catch (_err) {
    baseRemote = 'origin';
  }

  return { pr: String(pr), owner, repo: name, base, baseRef: `${baseRemote}/${base}` };
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
    return { success: false, error: 'Usage: forge shepherd <pr> [--auto-rebase]' };
  }

  const gh = deps.gh || ((cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', timeout: 30000 }));
  const git = deps.git || gh;
  const buildContext = deps.buildContext || defaultBuildContext;
  const runPass = deps.runPass || runShepherdPass;

  const autoRebase = flags.has('--auto-rebase');

  const ctx = await buildContext({ pr, gh, git, projectRoot });

  const adapter = deps.adapter || new PrStateAdapter({ gh, git });
  const validation = validatePrStateAdapter(adapter);
  if (!validation.valid) {
    return { success: false, error: `Invalid pr-state adapter: ${validation.errors.join('; ')}` };
  }

  const result = await runPass({
    ...ctx,
    adapter,
    autoRebase,
    cleanTree: autoRebase ? isWorkingTreeClean(git) : false,
    rerunBudget: deps.rerunBudget || DEFAULT_RERUN_BUDGET,
    rerunsUsed: deps.rerunsUsed || 0,
  });

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
  usage: 'Usage: forge shepherd <pr> [--auto-rebase]',
  handler,
  defaultBuildContext,
  isWorkingTreeClean,
};
