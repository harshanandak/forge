'use strict';

/**
 * PR-state adapter (`kind: 'pr-state'`).
 *
 * Wraps read-only GitHub/git inspection plus a small set of idempotent,
 * reversible side-effects used by the PR shepherd:
 *   - `readState`           → `gh pr view --json ...`
 *   - `readRequiredChecks`  → `gh api repos/{o}/{r}/branches/{base}/protection/required_status_checks`
 *   - `readDivergence`      → `git rev-list --left-right --count {baseRef}...HEAD`
 *   - `detectConflicts`     → `git merge-tree --write-tree {baseRef} HEAD` (predict-only)
 *   - `rerunFailedChecks`   → `gh run rerun <id> --failed`
 *   - `replyToThread`       → shell-out to `.claude/scripts/greptile-resolve.sh reply` (reply ONLY,
 *                             never resolve — resolution stays with the semantic `/review` agent)
 *
 * This adapter is its own SPI; it does NOT extend the review adapter and is
 * validated by `validatePrStateAdapter` (lib/pr-state-validator.js).
 *
 * It contains no merge or rebase machinery. Divergence handling (rebase) lives
 * in the core/CLI behind an opt-in flag and is injected as `rebaseOntoBase`
 * when enabled — it is never a default capability of this read surface.
 *
 * @module adapters/pr-state-adapter
 */

const { execFileSync } = require('node:child_process');

// NOTE: `reviewThreads` is NOT a valid `gh pr view --json` field — requesting it
// makes `gh` exit non-zero ("Unknown JSON field"), which crashed readState on every
// real PR. Review threads are read separately via GraphQL in readComments().
const PR_VIEW_FIELDS = [
  'headRefOid',
  'mergeable',
  'mergeStateStatus',
  'state',
  'statusCheckRollup',
].join(',');

/**
 * Classify an error thrown by the `gh` runner so the core can react.
 * Returns `null` when the error is not auth/rate related.
 *
 * @param {Error} error
 * @returns {{ class: string, retryAfter?: number } | null}
 */
function classifyAuthError(error) {
  if (!error) return null;
  const status = error.httpStatus
    || (typeof error.status === 'number' ? error.status : undefined);
  const text = `${error.stderr || ''} ${error.message || ''}`;
  const retryAfter = Number(error.retryAfter) || undefined;

  if (status === 401 || /HTTP 401|bad credentials|token expired/i.test(text)) {
    return { class: 'expired' };
  }
  if (status === 403 || /HTTP 403/i.test(text)) {
    if (retryAfter || /rate limit|secondary rate/i.test(text)) {
      return { class: 'rate-limit', retryAfter };
    }
    return { class: 'insufficient-scope' };
  }
  return null;
}

class PrStateAdapter {
  /**
   * @param {object} [options]
   * @param {Function} [options.gh] - Runner for `gh` (cmd, args[]) → string.
   * @param {Function} [options.git] - Runner for `git` (cmd, args[]) → string.
   */
  constructor(options = {}) {
    this.id = options.id || 'pr-state-adapter';
    this.kind = 'pr-state';
    this.name = options.name || this.id;
    const defaultRunner = (cmd, args, opts = {}) => execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: options.timeout || 30000,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    this._gh = options.gh || defaultRunner;
    this._git = options.git || defaultRunner;
  }

  /**
   * Read normalized PR/CI state.
   *
   * @param {string} pr - PR number or URL.
   * @returns {Promise<{ headSha: string, mergeable: string, mergeStateStatus: string, checks: object[], threads: object[] }>}
   */
  async readState(pr) {
    const raw = this._gh('gh', ['pr', 'view', String(pr), '--json', PR_VIEW_FIELDS]);
    const data = JSON.parse(raw || '{}');
    const rollup = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];
    return {
      headSha: data.headRefOid || '',
      state: String(data.state || 'OPEN').toUpperCase(),
      mergeable: data.mergeable || 'UNKNOWN',
      mergeStateStatus: data.mergeStateStatus || 'UNKNOWN',
      checks: rollup.map((check) => ({
        name: check.name || check.context || '',
        status: check.status || check.state || '',
        conclusion: check.conclusion || check.state || '',
        databaseId: check.databaseId,
        detailsUrl: check.detailsUrl,
      })),
      // gh pr view cannot return review threads; the shepherd reads them via
      // readComments() (GraphQL). Kept for return-shape stability, always empty here.
      threads: [],
    };
  }

  /**
   * Read the branch-protection required-checks set.
   *
   * Returns `null` when the protection endpoint is unreadable (e.g. 403
   * insufficient scope, the branch is not protected, or the payload shape is
   * unexpected) so the caller can escalate rather than guess. Re-throws non-auth
   * errors.
   *
   * @param {{ owner: string, repo: string, base: string }} ctx
   * @returns {Promise<string[] | null>}
   */
  async readRequiredChecks({ owner, repo, base }) {
    const apiPath = `repos/${owner}/${repo}/branches/${encodeURIComponent(base)}/protection/required_status_checks`;
    try {
      const raw = this._gh('gh', ['api', apiPath]);
      const data = JSON.parse(raw || '{}');
      if (Array.isArray(data.contexts)) return data.contexts;
      if (Array.isArray(data.checks)) return data.checks.map((c) => c.context).filter(Boolean);
      // Unexpected/changed payload shape — treat as unreadable, not "no required
      // checks", so merge readiness is never computed from bad data.
      return null;
    } catch (error) {
      const auth = classifyAuthError(error);
      if (auth) {
        // Unreadable protection (auth/scope/not-protected) — caller escalates.
        return null;
      }
      throw error;
    }
  }

  /**
   * Read ahead/behind divergence against the base ref.
   *
   * `cwd` is threaded through to the git runner so divergence is computed
   * against the target worktree/checkout, not the process directory.
   *
   * @param {{ baseRef: string, cwd?: string }} ctx
   * @returns {Promise<{ behind: number, ahead: number }>}
   */
  async readDivergence({ baseRef, cwd }) {
    const out = this._git(
      'git',
      ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`],
      cwd ? { cwd } : undefined,
    );
    const [behindRaw = '0', aheadRaw = '0'] = String(out).trim().split(/\s+/);
    return {
      behind: Number.parseInt(behindRaw, 10) || 0,
      ahead: Number.parseInt(aheadRaw, 10) || 0,
    };
  }

  /**
   * Re-run failed CI for a workflow run (Tier-A: idempotent, reversible).
   *
   * @param {{ runId: string }} ctx
   * @returns {Promise<void>}
   */
  async rerunFailedChecks({ runId }) {
    this._gh('gh', ['run', 'rerun', String(runId), '--failed']);
  }

  /**
   * Post a status reply to a review thread via the existing shell helper.
   * Reply ONLY — never resolve (resolution is the semantic `/review` agent's job).
   *
   * @param {{ pr: string, commentId: string, message: string, script?: string }} ctx
   * @returns {Promise<void>}
   */
  async replyToThread({ pr, commentId, message, script }) {
    const scriptPath = script || '.claude/scripts/greptile-resolve.sh';
    this._gh('bash', [scriptPath, 'reply', String(pr), String(commentId), String(message)]);
  }

  /**
   * Read review threads as actionable comments. Uses GraphQL because
   * `gh pr view --json reviewThreads` is unsupported. Resolved/outdated threads
   * are returned WITH flags so the core can filter them (and exclude bots/self).
   *
   * @param {{ owner: string, repo: string, pr: string }} ctx
   * @returns {Promise<object[]>}
   */
  async readComments({ owner, repo, pr }) {
    // `id`/`path`/`line` are surfaced so a consumer (e.g. the monitor bundle in
    // lib/pr-bundle.js) can hand an agent the thread id to resolve and the
    // file/line to act on — not just the body. Added fields are backward
    // compatible; the shepherd's existing thread filtering ignores them.
    const query = 'query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:100){nodes{author{login} body}}}}}}}';
    const raw = this._gh('gh', [
      'api', 'graphql', '-f', `query=${query}`,
      '-F', `o=${owner}`, '-F', `n=${repo}`, '-F', `pr=${pr}`,
    ]);
    const data = JSON.parse(raw || '{}');
    const nodes = (data.data && data.data.repository
      && data.data.repository.pullRequest
      && data.data.repository.pullRequest.reviewThreads
      && data.data.repository.pullRequest.reviewThreads.nodes) || [];
    return nodes.map((t) => {
      const allComments = (t.comments && t.comments.nodes) || [];
      return {
        threadId: t.id || '',
        path: t.path || null,
        line: typeof t.line === 'number' ? t.line : null,
        isResolved: !!t.isResolved,
        isOutdated: !!t.isOutdated,
        comments: allComments.map(c => ({
          author: (c.author && c.author.login) || '',
          body: c.body || '',
        })),
      };
    });
  }

  /**
   * Predict files that would conflict when merging `baseRef` into HEAD WITHOUT
   * touching the working tree, via `git merge-tree --write-tree`. Returns
   * `{ supported: false, reason }` when conflict prediction is unavailable (git
   * < 2.38, an unreadable ref, or a non-conflict error) so the bundle degrades
   * gracefully rather than failing the whole gather.
   *
   * @param {{ baseRef: string, cwd?: string }} ctx
   * @returns {Promise<{ supported: boolean, conflicted?: boolean, files?: string[], reason?: string }>}
   */
  async detectConflicts({ baseRef, cwd }) {
    const opts = cwd ? { cwd } : undefined;
    try {
      // Exit 0 = clean merge. `--name-only` reduces the conflict report to bare
      // paths; `--no-messages` suppresses the human-readable conflict prose.
      this._git(
        'git',
        ['merge-tree', '--write-tree', '--name-only', '--no-messages', baseRef, 'HEAD'],
        opts,
      );
      return { supported: true, conflicted: false, files: [] };
    } catch (error) {
      // Exit 1 = mergeable-with-conflicts: stdout is the written tree OID on the
      // first line followed by the conflicted paths. Any other status (e.g. 128
      // for an unknown ref, or `--write-tree` unsupported on git < 2.38) means
      // conflict prediction is unsupported in this environment.
      const status = typeof error.status === 'number' ? error.status : undefined;
      const stdout = String(error.stdout || '');
      if (status === 1 && stdout.trim()) {
        const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        return { supported: true, conflicted: true, files: lines.slice(1) };
      }
      return { supported: false, reason: error.message || 'git merge-tree unavailable' };
    }
  }
}

module.exports = {
  PrStateAdapter,
  classifyAuthError,
  PR_VIEW_FIELDS,
};
