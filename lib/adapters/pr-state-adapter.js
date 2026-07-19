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
 *   - `replyToThread`       → shell-out to `.claude/scripts/review-resolve.sh reply` (reply ONLY,
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
  // `reviewDecision` (REVIEW_REQUIRED / CHANGES_REQUESTED / APPROVED / '') and
  // `isDraft` are PR-level MERGE BLOCKERS the pull-signal payload surfaces — a
  // draft PR or a missing/negative review decision blocks merge even when every
  // check is green. Both are valid `gh pr view --json` fields.
  'reviewDecision',
  'isDraft',
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
    // windowsHide keeps the shepherd's per-poll gh/git calls from flashing a
    // console window on Windows when the watcher runs detached (issue 931e7924).
    const defaultRunner = (cmd, args, opts = {}) => execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: options.timeout || 30000,
      windowsHide: true,
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
      // PR-level merge blockers (surfaced by the pull signal). `reviewDecision` is
      // '' when no review is required; normalized to null so consumers can treat
      // "not required" and "unknown" uniformly. `isDraft` blocks merge outright.
      reviewDecision: data.reviewDecision || null,
      isDraft: Boolean(data.isDraft),
      // The rollup mixes two GraphQL types: a CheckRun (name/status/conclusion/
      // detailsUrl) and a legacy commit StatusContext (context/state/targetUrl —
      // Vercel/Netlify/other deploy+quality bots). Both are normalized into ONE
      // shape here so the failing/pending classification treats them identically;
      // `state` fills the conclusion slot for a StatusContext (SUCCESS/FAILURE/
      // ERROR/PENDING) and `targetUrl` fills the details link.
      checks: rollup.map((check) => ({
        name: check.name || check.context || '',
        status: check.status || check.state || '',
        conclusion: check.conclusion || check.state || '',
        databaseId: check.databaseId,
        detailsUrl: check.detailsUrl || check.targetUrl,
      })),
      // gh pr view cannot return review threads; the shepherd reads them via
      // readComments() (GraphQL). Kept for return-shape stability, always empty here.
      threads: [],
    };
  }

  /**
   * Read the required-checks set for a PR, with a two-source strategy so the
   * verdict is not permanently UNKNOWN in CI.
   *
   * 1. **Branch protection** (`.../protection/required_status_checks`) — the
   *    authoritative set, but this REST endpoint needs repo `Administration:read`,
   *    which GitHub Actions' `GITHUB_TOKEN` can NEVER hold (administration is not a
   *    grantable `permissions:` scope). So in CI this ALWAYS 403/404s and the set
   *    was permanently null → verdict UNKNOWN on every PR.
   * 2. **statusCheckRollup `isRequired`** (GraphQL, on the PR head commit) — the
   *    fallback. It is readable with the plain PR-read scope the Actions token DOES
   *    hold (it is what `gh pr checks --required` uses) and it covers BOTH classic
   *    branch protection AND repository rulesets.
   *
   * Known limitation of the fallback: the rollup only lists contexts that
   * PRODUCED a run, so a required context that never ran at all is invisible on
   * this path — missing-required detection is best-effort when the source is the
   * rollup. That is strictly better than a permanent UNKNOWN.
   *
   * Returns `null` only when BOTH sources are unreadable (existing fail-closed
   * behaviour). `lastRequiredSource` records which source answered
   * (`'protection'` | `'rollup'` | `null`) so callers can surface it as evidence.
   * Re-throws non-auth protection errors (unchanged).
   *
   * @param {{ owner: string, repo: string, base: string, pr?: string|number }} ctx
   * @returns {Promise<string[] | null>}
   */
  async readRequiredChecks({ owner, repo, base, pr }) {
    this.lastRequiredSource = null;
    const fromProtection = this._readProtectionRequired({ owner, repo, base });
    if (Array.isArray(fromProtection)) {
      this.lastRequiredSource = 'protection';
      return fromProtection;
    }
    // Protection unreadable (auth/scope/not-protected/unexpected shape) — fall back
    // to the rollup `isRequired` set the Actions token CAN read.
    const fromRollup = this._readRollupRequired({ owner, repo, pr });
    if (Array.isArray(fromRollup)) {
      this.lastRequiredSource = 'rollup';
      return fromRollup;
    }
    return null;
  }

  /**
   * Branch-protection required set, or `null` when unreadable (auth/scope/
   * not-protected/unexpected shape). Re-throws non-auth errors so a genuine
   * outage is not silently masked. Split out so `readRequiredChecks` can fall
   * back cleanly.
   *
   * @param {{ owner: string, repo: string, base: string }} ctx
   * @returns {string[] | null}
   */
  _readProtectionRequired({ owner, repo, base }) {
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
        // Unreadable protection (auth/scope/not-protected) — fall back to rollup.
        return null;
      }
      throw error;
    }
  }

  /**
   * Fallback required set from the PR head commit's `statusCheckRollup`, reading
   * per-context `isRequired(pullRequestNumber:)` via GraphQL. Readable with plain
   * PR-read scope (unlike branch protection). Returns the deduped names of every
   * required CheckRun/StatusContext, `[]` when the rollup is readable but nothing
   * is required, or `null` when the rollup itself is unreadable (fail-closed).
   *
   * @param {{ owner: string, repo: string, pr?: string|number }} ctx
   * @returns {string[] | null}
   */
  _readRollupRequired({ owner, repo, pr }) {
    const prNum = Number.parseInt(String(pr), 10);
    if (!Number.isInteger(prNum) || prNum <= 0) return null;
    // pr is inlined as a validated integer (no injection); owner/repo are GitHub
    // name-charset identifiers. Shape verified against the live GraphQL API.
    const query = `query { repository(owner: "${owner}", name: "${repo}") { `
      + `pullRequest(number: ${prNum}) { headRef { target { ... on Commit { `
      + `statusCheckRollup { contexts(first: 100) { nodes { __typename `
      + `... on CheckRun { name isRequired(pullRequestNumber: ${prNum}) } `
      + `... on StatusContext { context isRequired(pullRequestNumber: ${prNum}) } `
      + `} } } } } } } } }`;
    try {
      const raw = this._gh('gh', ['api', 'graphql', '-f', `query=${query}`]);
      const data = JSON.parse(raw || '{}');
      const nodes = data
        && data.data
        && data.data.repository
        && data.data.repository.pullRequest
        && data.data.repository.pullRequest.headRef
        && data.data.repository.pullRequest.headRef.target
        && data.data.repository.pullRequest.headRef.target.statusCheckRollup
        && data.data.repository.pullRequest.headRef.target.statusCheckRollup.contexts
        && data.data.repository.pullRequest.headRef.target.statusCheckRollup.contexts.nodes;
      // No rollup at all (e.g. statusCheckRollup null) → cannot determine the set.
      if (!Array.isArray(nodes)) return null;
      const required = [];
      for (const node of nodes) {
        if (node && node.isRequired === true) {
          const name = node.name || node.context;
          if (name) required.push(name);
        }
      }
      // Dedupe matrix duplicates (same context reported by multiple jobs).
      return [...new Set(required)];
    } catch {
      // GraphQL unreadable (auth/network/etc.) — fail closed to null.
      return null;
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
   * Fetch the base ref from its remote so a subsequent `readDivergence`/
   * `detectConflicts` compares HEAD against the CURRENT `origin/<base>`, not a
   * stale local remote-tracking ref (audit A6: a stale ref reports a false
   * `behind=0` / false "no conflict"). `baseRef` is `<remote>/<branch>` (e.g.
   * `origin/master`); the remote and branch are split back out for `git fetch`.
   * Read-only against the working tree — it only updates remote-tracking refs.
   *
   * @param {{ baseRef: string, cwd?: string }} ctx
   * @returns {Promise<void>}
   */
  async fetchBase({ baseRef, cwd }) {
    const ref = String(baseRef || '');
    const slash = ref.indexOf('/');
    // No `<remote>/<branch>` shape → nothing safe to fetch; leave refs as-is.
    if (slash <= 0) return;
    const remote = ref.slice(0, slash);
    const branch = ref.slice(slash + 1);
    this._git('git', ['fetch', remote, branch], cwd ? { cwd } : undefined);
  }

  /**
   * Post a status reply to a review thread via the existing shell helper.
   * Reply ONLY — never resolve (resolution is the semantic `/review` agent's job).
   *
   * @param {{ pr: string, commentId: string, message: string, script?: string }} ctx
   * @returns {Promise<void>}
   */
  async replyToThread({ pr, commentId, message, script }) {
    const scriptPath = script || '.claude/scripts/review-resolve.sh';
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
    //
    // Both connections are FULLY paginated (cursors, not a first:100 cap): a
    // large PR must never silently drop a thread or a later reply, or the bundle
    // would declare "complete" on partial data and the monitor would skip work.
    const threads = this._fetchAllReviewThreads({ owner, repo, pr });
    return threads.map((t) => {
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
          // REST comment id (needed to REPLY to the thread). `fullDatabaseId` is
          // the string-encoded integer id; null when GitHub omits it.
          commentId: c.fullDatabaseId ? String(c.fullDatabaseId) : null,
        })),
      };
    });
  }

  /**
   * Page through ALL `reviewThreads` (and each thread's nested `comments`) using
   * GraphQL cursors. The per-page size stays 100, but pagination continues until
   * `hasNextPage` is false, so coverage no longer caps at 100 threads/comments.
   * A guard bounds the loop against a pathological/looping cursor.
   *
   * @param {{ owner: string, repo: string, pr: string }} ctx
   * @returns {object[]} raw thread nodes (comments.nodes carries the full chain)
   */
  _fetchAllReviewThreads({ owner, repo, pr }) {
    const query = 'query($o:String!,$n:String!,$pr:Int!,$after:String){repository(owner:$o,name:$n){pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line comments(first:100){pageInfo{hasNextPage endCursor} nodes{fullDatabaseId author{login} body}}}}}}}';
    return this._paginateConnection(
      (after) => this._ghGraphqlPage(query, { owner, repo, pr }, after)
        ?.data?.repository?.pullRequest?.reviewThreads,
      (t) => {
        // A thread whose first comment page is truncated → fetch the rest.
        if (t.comments?.pageInfo?.hasNextPage) {
          t.comments = { nodes: this._fetchAllThreadComments(t.id, t.comments) };
        }
        return t;
      },
    );
  }

  /**
   * Run ONE `gh api graphql` page request for an owner/repo/pr-shaped query and
   * return the parsed JSON (or `{}`). `after` appends the opaque cursor only when
   * present — omitting it on the first page tells GraphQL to start from the top.
   * Extracted so the arg-building scaffold lives in exactly one place.
   *
   * @param {string} query
   * @param {{ owner: string, repo: string, pr: string }} vars
   * @param {string|null} after
   * @returns {object}
   */
  _ghGraphqlPage(query, { owner, repo, pr }, after) {
    const args = [
      'api', 'graphql', '-f', `query=${query}`,
      '-F', `o=${owner}`, '-F', `n=${repo}`, '-F', `pr=${pr}`,
    ];
    if (after) args.push('-f', `after=${after}`);
    return JSON.parse(this._gh('gh', args) || '{}');
  }

  /**
   * Page through a cursored GraphQL connection until `hasNextPage` is false,
   * accumulating `mapNode(node)` for every node across all pages. `runPage(after)`
   * performs one page request and returns the connection object
   * (`{ pageInfo, nodes }`) or a falsy value when unreadable. A page guard bounds
   * the loop against a pathological/looping cursor. Shared by every paginated
   * read so the do-while cursor scaffold is defined exactly once.
   *
   * @param {(after: string|null) => ({ pageInfo?: object, nodes?: object[] }|null|undefined)} runPage
   * @param {(node: object) => object} mapNode
   * @returns {object[]}
   */
  _paginateConnection(runPage, mapNode) {
    const all = [];
    let after = null;
    let guard = 0;
    const MAX_PAGES = 1000;
    do {
      const conn = runPage(after);
      for (const node of (conn?.nodes || [])) all.push(mapNode(node));
      after = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
      guard += 1;
    } while (after && guard < MAX_PAGES);
    return all;
  }

  /**
   * Page through the remaining `comments` of a single review thread (the first
   * page already arrived inline with the thread). Resolves the thread by node id.
   *
   * @param {string} threadId
   * @param {{ nodes: object[], pageInfo: { hasNextPage: boolean, endCursor: string } }} initial
   * @returns {object[]} the full comment-node list (first page + all later pages)
   */
  _fetchAllThreadComments(threadId, initial) {
    const query = 'query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{fullDatabaseId author{login} body}}}}}';
    const acc = [...((initial && initial.nodes) || [])];
    let after = initial && initial.pageInfo && initial.pageInfo.hasNextPage ? initial.pageInfo.endCursor : null;
    let guard = 0;
    const MAX_PAGES = 1000;
    while (after && guard < MAX_PAGES) {
      const raw = this._gh('gh', [
        'api', 'graphql', '-f', `query=${query}`,
        '-f', `id=${threadId}`, '-f', `after=${after}`,
      ]);
      const data = JSON.parse(raw || '{}');
      const conn = data.data && data.data.node && data.data.node.comments;
      acc.push(...((conn && conn.nodes) || []));
      after = conn && conn.pageInfo && conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
      guard += 1;
    }
    return acc;
  }

  /**
   * Read the PR's plain ISSUE comments (NOT review threads) — the surface where
   * status/deploy/quality bots post their summaries: SonarCloud's Quality-Gate
   * comment, Vercel/Netlify deployment comments, Codecov coverage comments. These
   * are regular PR comments, never resolvable review threads, so `readComments`
   * (reviewThreads GraphQL) never sees them. Fully paginated by cursor so a long
   * PR never drops a bot's latest comment. Returns `{ author, body, createdAt }`.
   *
   * @param {{ owner: string, repo: string, pr: string }} ctx
   * @returns {Promise<Array<{ author: string, body: string, createdAt: string }>>}
   */
  async readIssueComments({ owner, repo, pr }) {
    // `author{__typename login}` surfaces the GraphQL actor TYPE ('Bot' vs 'User')
    // so a non-human direct comment can be detected GENERICALLY — by mechanism,
    // not by a hardcoded bot-name list — which fails closed for unknown bots.
    const query = 'query($o:String!,$n:String!,$pr:Int!,$after:String){repository(owner:$o,name:$n){pullRequest(number:$pr){comments(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{fullDatabaseId author{__typename login} body createdAt}}}}}';
    return this._paginateConnection(
      (after) => this._ghGraphqlPage(query, { owner, repo, pr }, after)
        ?.data?.repository?.pullRequest?.comments,
      (c) => ({
        // `id` is the stable REST comment id — the PR monitor keys `comment.posted`
        // on it so a re-read never re-emits an already-seen comment. Falls back to
        // author+createdAt when GitHub omits it.
        id: c.fullDatabaseId ? String(c.fullDatabaseId) : `${c.author?.login || ''}:${c.createdAt || ''}`,
        author: c.author?.login || '',
        authorTypename: c.author?.__typename || '',
        body: c.body || '',
        createdAt: c.createdAt || '',
      }),
    );
  }

  /**
   * Read submitted PR REVIEWS (not inline threads) — the latest review per
   * author, each with the commit it was submitted against. This is the
   * review-at-head signal that catches the #365 race: a CodeRabbit review from
   * an earlier commit whose `commit.oid` no longer matches HEAD is STALE, so the
   * post-push re-review is still pending. Uses GraphQL because `gh pr view`
   * cannot return a review's target commit oid. Fully paginated by cursor.
   *
   * @param {{ owner: string, repo: string, pr: string }} ctx
   * @returns {Promise<Array<{ author: string, state: string, submittedAt: string|null, commitOid: string|null, body: string }>>}
   */
  async readReviews({ owner, repo, pr }) {
    const query = 'query($o:String!,$n:String!,$pr:Int!,$after:String){repository(owner:$o,name:$n){pullRequest(number:$pr){reviews(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{author{__typename login} state submittedAt commit{oid} body}}}}}';
    const all = this._paginateConnection(
      (after) => this._ghGraphqlPage(query, { owner, repo, pr }, after)
        ?.data?.repository?.pullRequest?.reviews,
      (r) => ({
        author: String(r.author?.login || '').toLowerCase(),
        authorTypename: r.author?.__typename || '',
        state: String(r.state || '').toUpperCase(),
        submittedAt: r.submittedAt || null,
        commitOid: r.commit?.oid || null,
        body: r.body || '',
      }),
    );
    // Keep only the LATEST review per author (first:100 yields oldest→newest, so
    // a later entry supersedes an earlier one from the same login).
    const latest = new Map();
    for (const r of all) {
      if (!r.author) continue;
      latest.set(r.author, r);
    }
    return Array.from(latest.values());
  }

  /**
   * Read the HEAD commit's committed timestamp (epoch ms), or null when
   * unreadable. Anchors the pull-signal settle window to when the code last
   * changed — so a freshly-pushed PR whose CI passes BEFORE the review bots have
   * even run is REVIEW-PENDING, not CLEAN (#365 "never-ran" variant), and a bot
   * comment older than the last push is treated as stale, not a live blocker.
   *
   * @param {{ pr: string }} ctx
   * @returns {Promise<number|null>} epoch ms of the head commit, or null.
   */
  async readHeadCommitTime({ pr }) {
    const raw = this._gh('gh', ['pr', 'view', String(pr), '--json', 'commits', '-q', '.commits[-1].committedDate']);
    const t = Date.parse(String(raw || '').trim());
    return Number.isFinite(t) ? t : null;
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
