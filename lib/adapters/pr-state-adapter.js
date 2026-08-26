'use strict';

/**
 * PR-state adapter (`kind: 'pr-state'`).
 *
 * Wraps read-only GitHub/git inspection plus a small set of idempotent,
 * reversible side-effects used by the PR shepherd:
 *   - `readState`           → `gh pr view --json ...`
 *   - `readRequiredChecks`  → `gh api repos/{o}/{r}/branches/{base}/protection/required_status_checks`
 *   - `readDivergence`      → `git rev-list --left-right --count {baseRef}...{headRef}`
 *   - `detectConflicts`     → `git merge-tree --write-tree {baseRef} {headRef}` (predict-only)
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

const GITHUB_ACTOR_TYPENAMES = new Set([
  'Bot', 'EnterpriseUserAccount', 'Mannequin', 'Organization', 'User',
]);
const FULL_HEAD_SHA = /^[0-9a-f]{40}$/i;
const POSITIVE_PR_NUMBER = /^[1-9][0-9]*$/;
const CHECK_RUN_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'COMPLETED', 'WAITING', 'PENDING', 'REQUESTED']);
const CHECK_RUN_CONCLUSIONS = new Set([
  '', 'SUCCESS', 'FAILURE', 'NEUTRAL', 'CANCELLED', 'SKIPPED', 'TIMED_OUT',
  'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE',
]);
const STATUS_CONTEXT_STATES = new Set(['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS']);
const MERGE_STATE_STATUSES = new Set([
  'BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE',
]);
const PULL_REQUEST_REVIEW_STATES = new Set([
  'APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING',
]);

function canonicalPrNumber(value) {
  const raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof raw === 'string' && POSITIVE_PR_NUMBER.test(raw) ? Number(raw) : null;
}

function validRollupNode(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return false;
  if (check.__typename === 'CheckRun') {
    const status = String(check.status || '').toUpperCase();
    const conclusion = String(check.conclusion || '').toUpperCase();
    return typeof check.name === 'string' && Boolean(check.name.trim())
      && CHECK_RUN_STATUSES.has(status)
      && Object.prototype.hasOwnProperty.call(check, 'conclusion')
      && (check.conclusion === null || typeof check.conclusion === 'string')
      && CHECK_RUN_CONCLUSIONS.has(conclusion)
      && (status === 'COMPLETED' ? Boolean(conclusion) : !conclusion);
  }
  if (check.__typename === 'StatusContext') {
    return typeof check.context === 'string' && Boolean(check.context.trim())
      && typeof check.state === 'string'
      && STATUS_CONTEXT_STATES.has(check.state.toUpperCase());
  }
  return false;
}

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
   * @param {string} [options.repository] - Exact owner/repo for numeric PR reads.
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
    this._repository = options.repository || null;
    this.lastProtectionStatus = null;
  }

  /**
   * Read normalized PR/CI state.
   *
   * @param {string} pr - PR number or URL.
   * @returns {Promise<{ headSha: string, mergeable: string, mergeStateStatus: string, checks: object[], threads: object[] }>}
   */
  async readState(pr) {
    const raw = this._gh('gh', [
      'pr', 'view', String(pr),
      ...(this._repository ? ['--repo', this._repository] : []),
      '--json', PR_VIEW_FIELDS,
    ]);
    const data = JSON.parse(raw || '{}');
    const lifecycleReadable = typeof data.state === 'string'
      && ['OPEN', 'MERGED', 'CLOSED'].includes(data.state.toUpperCase())
      && typeof data.isDraft === 'boolean';
    const mergeStateStatus = typeof data.mergeStateStatus === 'string'
      ? data.mergeStateStatus.toUpperCase()
      : '';
    const mergeStateReadable = MERGE_STATE_STATUSES.has(mergeStateStatus)
      && mergeStateStatus !== 'UNKNOWN';
    const rollupReadable = Array.isArray(data.statusCheckRollup)
      && data.statusCheckRollup.every(validRollupNode);
    const providerEvidenceReadable = lifecycleReadable && mergeStateReadable && rollupReadable
      && typeof data.headRefOid === 'string' && FULL_HEAD_SHA.test(data.headRefOid);
    const rollup = rollupReadable ? data.statusCheckRollup : [];
    return {
      headSha: typeof data.headRefOid === 'string' ? data.headRefOid : '',
      state: lifecycleReadable ? data.state.toUpperCase() : 'UNKNOWN',
      mergeable: data.mergeable || 'UNKNOWN',
      mergeStateStatus: mergeStateReadable ? mergeStateStatus : 'UNKNOWN',
      reviewDecision: data.reviewDecision || null,
      isDraft: typeof data.isDraft === 'boolean' ? data.isDraft : null,
      providerEvidenceReadable,
      checks: rollup.map((check) => {
        const statusContext = check.__typename === 'StatusContext';
        const state = String(check.state || '').toUpperCase();
        return {
          name: check.name || check.context || '',
          status: statusContext
            ? (['SUCCESS', 'FAILURE', 'ERROR'].includes(state) ? 'COMPLETED' : 'IN_PROGRESS')
            : String(check.status).toUpperCase(),
          conclusion: statusContext ? state : String(check.conclusion || '').toUpperCase(),
          databaseId: check.databaseId,
          detailsUrl: check.detailsUrl || check.targetUrl,
        };
      }),
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
   * Rollup `isRequired` data cannot prove the complete protected set because a
   * required context that never ran is absent. `lastRequiredSource` is therefore
   * `'protection'` only when an authoritative set is returned, and `null` when
   * protection is unreadable.
   * Re-throws non-auth protection errors (unchanged).
   *
   * @param {{ owner: string, repo: string, base: string, pr?: string|number }} ctx
   * @returns {Promise<string[] | null>}
   */
  async readRequiredCheckPolicy({ owner, repo, base }) {
    this.lastRequiredSource = null;
    const fromProtection = this._readProtectionRequired({ owner, repo, base });
    if (Array.isArray(fromProtection)) {
      this.lastRequiredSource = 'protection';
      return fromProtection;
    }
    return null;
  }

  async readRequiredChecks({ owner, repo, base, pr }) {
    const fromProtection = await this.readRequiredCheckPolicy({ owner, repo, base });
    if (Array.isArray(fromProtection)) return [...new Set(fromProtection.map((entry) => entry.context))];
    if (this.lastProtectionStatus !== 'unavailable') return null;
    // Rollup `isRequired` is retained only as diagnostic evidence. It is not the
    // authoritative policy and therefore cannot authorize merge readiness.
    this._readRollupRequired({ owner, repo, pr });
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
    this.lastProtectionStatus = 'malformed';
    const apiPath = `repos/${owner}/${repo}/branches/${encodeURIComponent(base)}/protection/required_status_checks`;
    try {
      const raw = this._gh('gh', ['api', apiPath]);
      const data = JSON.parse(raw || '{}');
      const hasContexts = Object.prototype.hasOwnProperty.call(data, 'contexts');
      const hasChecks = Object.prototype.hasOwnProperty.call(data, 'checks');
      if ((hasContexts && !Array.isArray(data.contexts))
        || (hasChecks && !Array.isArray(data.checks))) return null;
      const normalizeContexts = (items) => {
        if (!Array.isArray(items)) return null;
        if (items.some((item) => typeof item !== 'string' || item.trim().length === 0)) return null;
        return [...new Set(items)];
      };
      const contexts = normalizeContexts(data.contexts);
      let checks = null;
      if (Array.isArray(data.checks)) {
        if (data.checks.some((item) => !item || typeof item.context !== 'string'
          || item.context.length === 0
          || !Object.prototype.hasOwnProperty.call(item, 'app_id')
          || (item.app_id !== null
            && (!Number.isInteger(item.app_id) || item.app_id <= 0)))) return null;
        const deduped = new Map();
        const identityByContext = new Map();
        for (const item of data.checks) {
          const entry = { context: item.context, appId: item.app_id };
          const identity = entry.appId === null ? '*' : String(entry.appId);
          if (identityByContext.has(entry.context)
            && identityByContext.get(entry.context) !== identity) return null;
          identityByContext.set(entry.context, identity);
          deduped.set(`${entry.context}\u0000${identity}`, entry);
        }
        checks = [...deduped.values()];
      }
      if (contexts && checks) {
        const contextNames = [...contexts].sort((a, b) => a.localeCompare(b));
        const checkNames = [...new Set(checks.map((entry) => entry.context))].sort((a, b) => a.localeCompare(b));
        if (contextNames.length !== checkNames.length
          || contextNames.some((value, index) => value !== checkNames[index])) return null;
        this.lastProtectionStatus = 'authoritative';
        return checks;
      }
      if (contexts) {
        this.lastProtectionStatus = 'authoritative';
        return contexts.map((context) => ({ context, appId: null }));
      }
      if (checks) {
        this.lastProtectionStatus = 'authoritative';
        return checks;
      }
      // Unexpected/changed payload shape — treat as unreadable, not "no required
      // checks", so merge readiness is never computed from bad data.
      return null;
    } catch (error) {
      const auth = classifyAuthError(error);
      if (auth) {
        this.lastProtectionStatus = 'unavailable';
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
    const prNum = canonicalPrNumber(pr);
    if (prNum === null) return null;
    const query = [
      'query($after:String){repository(owner:"', owner, '",name:"', repo, '"){',
      'pullRequest(number:', prNum, '){headRef{target{... on Commit{statusCheckRollup{',
      'contexts(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{__typename ',
      '... on CheckRun{name isRequired(pullRequestNumber:', prNum, ')} ',
      '... on StatusContext{context isRequired(pullRequestNumber:', prNum, ')}}}}}}}}}}',
    ].join('');
    try {
      const projected = this._paginateConnection(
        (after) => {
          const args = ['api', 'graphql', '-f', `query=${query}`];
          if (after) args.push('-f', `after=${after}`);
          const data = this._parseGraphqlResponse(this._gh('gh', args));
          return data?.data?.repository?.pullRequest?.headRef?.target
            ?.statusCheckRollup?.contexts;
        },
        (node) => {
          if (!['CheckRun', 'StatusContext'].includes(node.__typename)
            || typeof node.isRequired !== 'boolean') {
            throw new Error('Rollup required-check node is malformed');
          }
          const name = node.__typename === 'CheckRun' ? node.name : node.context;
          if (typeof name !== 'string' || !name.trim()) {
            throw new Error('Rollup required-check node has no context identity');
          }
          return node.isRequired ? name : null;
        },
      );
      return [...new Set(projected.filter(Boolean))];
    } catch {
      return null;
    }
  }

  /**
   * Read ahead/behind divergence against the base ref.
   *
   * `cwd` is threaded through to the git runner so divergence is computed
   * against the target worktree/checkout, not the process directory.
   *
   * @param {{ baseRef: string, cwd?: string, headRef?: string }} ctx
   * @returns {Promise<{ behind: number, ahead: number }>}
   */
  async readDivergence({ baseRef, cwd, headRef = 'HEAD' }) {
    const out = this._git(
      'git',
      ['rev-list', '--left-right', '--count', `${baseRef}...${headRef}`],
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
   * `detectConflicts` compares the selected PR head (or legacy `HEAD` default)
   * against the CURRENT `origin/<base>`, not a
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
    const number = canonicalPrNumber(pr);
    if (!number) throw new Error('PR selector must be one canonical positive decimal number');
    // `id`/`path`/`line` are surfaced so a consumer (e.g. the monitor bundle in
    // lib/pr-bundle.js) can hand an agent the thread id to resolve and the
    // file/line to act on — not just the body. Added fields are backward
    // compatible; the shepherd's existing thread filtering ignores them.
    //
    // Both connections are FULLY paginated (cursors, not a first:100 cap): a
    // large PR must never silently drop a thread or a later reply, or the bundle
    // would declare "complete" on partial data and the monitor would skip work.
    const threads = this._fetchAllReviewThreads({ owner, repo, pr: number });
    return threads.map((t) => {
      const allComments = t.comments.nodes;
      return {
        threadId: t.id,
        path: t.path || null,
        line: typeof t.line === 'number' ? t.line : null,
        isResolved: t.isResolved,
        isOutdated: t.isOutdated,
        comments: allComments.map((c) => {
          const commentId = c.fullDatabaseId ? String(c.fullDatabaseId) : '';
          const author = String(c.author?.login || '');
          const authorType = String(c.author?.__typename || '');
          if (!commentId) throw new Error(`Review thread ${t.id} comment is missing stable database id`);
          if (!author || !GITHUB_ACTOR_TYPENAMES.has(authorType)) {
            throw new Error(`Review thread ${t.id} comment ${commentId} is missing valid author identity`);
          }
          if (typeof c.body !== 'string') throw new Error(`Review thread ${t.id} comment ${commentId} has malformed body`);
          return { author, authorType, body: c.body, commentId };
        }),
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
    const query = 'query($o:String!,$n:String!,$pr:Int!,$after:String){repository(owner:$o,name:$n){pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line comments(first:100){pageInfo{hasNextPage endCursor} nodes{fullDatabaseId author{__typename login} body}}}}}}}';
    return this._paginateConnection(
      (after) => this._ghGraphqlPage(query, { owner, repo, pr }, after)
        ?.data?.repository?.pullRequest?.reviewThreads,
      (t) => {
        if (typeof t.id !== 'string' || !t.id
          || typeof t.isResolved !== 'boolean' || typeof t.isOutdated !== 'boolean') {
          throw new Error('GraphQL review thread node is malformed');
        }
        const comments = this._validateGraphqlConnection(t.comments, `Review thread ${t.id} comments`);
        const nodes = comments.pageInfo.hasNextPage
          ? this._fetchAllThreadComments(t.id, comments)
          : comments.nodes;
        return { ...t, comments: { nodes } };
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
    return this._parseGraphqlResponse(this._gh('gh', args));
  }

  _parseGraphqlResponse(raw) {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('GraphQL response envelope is malformed');
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'errors')
      && (!Array.isArray(parsed.errors) || parsed.errors.length > 0)) {
      throw new Error('GraphQL response contains errors');
    }
    return parsed;
  }

  _validateGraphqlConnection(conn, label = 'GraphQL connection') {
    if (!conn || typeof conn !== 'object' || Array.isArray(conn)
      || !Array.isArray(conn.nodes) || conn.nodes.some((node) => !node || typeof node !== 'object' || Array.isArray(node))
      || !conn.pageInfo || typeof conn.pageInfo !== 'object' || Array.isArray(conn.pageInfo)
      || typeof conn.pageInfo.hasNextPage !== 'boolean'
      || (conn.pageInfo.endCursor !== null && typeof conn.pageInfo.endCursor !== 'string')
      || (conn.pageInfo.hasNextPage && !conn.pageInfo.endCursor)) {
      throw new Error(`${label} is missing valid nodes/pageInfo`);
    }
    return conn;
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
      const previous = after;
      const conn = this._validateGraphqlConnection(runPage(after));
      for (const node of conn.nodes) all.push(mapNode(node));
      after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
      if (after !== null && after === previous) {
        throw new Error('GraphQL pagination cursor did not advance');
      }
      guard += 1;
      if (guard >= MAX_PAGES && after !== null) {
        throw new Error('GraphQL pagination exceeded the page limit');
      }
    } while (after !== null);
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
    const query = 'query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{fullDatabaseId author{__typename login} body}}}}}';
    if (typeof threadId !== 'string' || !threadId) throw new Error('Review thread id is malformed');
    let conn = this._validateGraphqlConnection(initial, `Review thread ${threadId} comments`);
    const acc = [...conn.nodes];
    let after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    let guard = 0;
    const MAX_PAGES = 1000;
    while (after !== null) {
      const previous = after;
      const raw = this._gh('gh', [
        'api', 'graphql', '-f', `query=${query}`,
        '-f', `id=${threadId}`, '-f', `after=${after}`,
      ]);
      const data = this._parseGraphqlResponse(raw);
      conn = this._validateGraphqlConnection(
        data?.data?.node?.comments,
        `Review thread ${threadId} comments`,
      );
      acc.push(...conn.nodes);
      after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
      if (after !== null && after === previous) {
        throw new Error('GraphQL pagination cursor did not advance');
      }
      guard += 1;
      if (guard >= MAX_PAGES && after !== null) {
        throw new Error('GraphQL pagination exceeded the page limit');
      }
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
    const query = 'query($o:String!,$n:String!,$pr:Int!,$after:String){repository(owner:$o,name:$n){pullRequest(number:$pr){comments(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{fullDatabaseId author{__typename login} body createdAt updatedAt}}}}}';
    return this._paginateConnection(
      (after) => this._ghGraphqlPage(query, { owner, repo, pr }, after)
        ?.data?.repository?.pullRequest?.comments,
      (c) => {
        const id = c.fullDatabaseId ? String(c.fullDatabaseId) : '';
        if (!id) throw new Error('Issue comment is missing stable database id');
        if (!c.author?.login) throw new Error(`Issue comment ${id} is missing author identity`);
        if (!GITHUB_ACTOR_TYPENAMES.has(String(c.author?.__typename || ''))) {
          throw new Error(`Issue comment ${id} has missing or malformed actor type`);
        }
        if (typeof c.body !== 'string' || typeof c.createdAt !== 'string' || !c.createdAt) {
          throw new Error(`Issue comment ${id} has malformed body or timestamp`);
        }
        return {
          id,
          author: c.author.login,
          authorTypename: c.author.__typename,
          body: c.body,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt || c.createdAt,
        };
      },
    );
  }

  /**
   * Read submitted PR REVIEWS (not inline threads) — the latest review per
   * author, each with the commit it was submitted against. This is the
   * review-at-head signal that catches the #365 race: any reviewer submission
   * from an earlier commit whose `commit.oid` no longer matches HEAD is STALE,
   * so the post-push re-review is still pending. Uses GraphQL because `gh pr view`
   * cannot return a review's target commit oid. Fully paginated by cursor.
   *
   * @param {{ owner: string, repo: string, pr: string }} ctx
   * @returns {Promise<Array<{ author: string, state: string, createdAt: string, updatedAt: string, submittedAt: string, activityAt: string, commitOid: string, body: string }>>}
   */
  async readReviews({ owner, repo, pr }) {
    const query = 'query($o:String!,$n:String!,$pr:Int!,$after:String){repository(owner:$o,name:$n){pullRequest(number:$pr){reviews(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id author{__typename login} state createdAt updatedAt submittedAt commit{oid} body}}}}}';
    const all = this._paginateConnection(
      (after) => this._ghGraphqlPage(query, { owner, repo, pr }, after)
        ?.data?.repository?.pullRequest?.reviews,
      (r) => {
        if (typeof r.id !== 'string' || !r.id) {
          throw new Error('Review is missing stable GraphQL id');
        }
        const id = r.id;
        if (typeof r.author?.login !== 'string' || !r.author.login) {
          throw new Error(`Review ${id} is missing author identity`);
        }
        const author = r.author.login.toLowerCase().replace(/\[bot\]$/, '');
        if (!author) throw new Error(`Review ${id} has empty normalized author identity`);
        if (typeof r.author?.__typename !== 'string'
          || !GITHUB_ACTOR_TYPENAMES.has(r.author.__typename)) {
          throw new Error(`Review ${id} has missing or malformed actor type`);
        }
        const state = typeof r.state === 'string' ? r.state.toUpperCase() : '';
        if (!PULL_REQUEST_REVIEW_STATES.has(state)
          || typeof r.createdAt !== 'string' || !r.createdAt
          || typeof r.updatedAt !== 'string' || !r.updatedAt
          || typeof r.submittedAt !== 'string' || !r.submittedAt
          || typeof r.commit?.oid !== 'string' || !FULL_HEAD_SHA.test(r.commit.oid)
          || typeof r.body !== 'string') {
          throw new Error(`Review ${id} has malformed state, timestamp, commit, or body`);
        }
        return {
          id,
          author,
          authorTypename: r.author.__typename,
          state,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          submittedAt: r.submittedAt,
          commitOid: r.commit.oid,
          body: r.body,
        };
      },
    );
    // Keep only the LATEST review per author (first:100 yields oldest→newest, so
    // a later entry supersedes an earlier one from the same login).
    const latest = new Map();
    const latestSubmission = new Map();
    const latestActivity = new Map();
    for (const r of all) {
      const submitted = Date.parse(r.submittedAt);
      if (!Number.isFinite(submitted)) {
        throw new Error(`Review ${r.id} has malformed submission timestamp`);
      }
      if (!latestSubmission.has(r.author) || submitted >= latestSubmission.get(r.author)) {
        latest.set(r.author, r);
        latestSubmission.set(r.author, submitted);
      }
      const activity = Math.max(
        Date.parse(r.createdAt),
        Date.parse(r.updatedAt),
        Date.parse(r.submittedAt),
      );
      if (!Number.isFinite(activity)) {
        throw new Error(`Review ${r.id} has malformed activity timestamps`);
      }
      latestActivity.set(r.author, Math.max(latestActivity.get(r.author) || 0, activity));
    }
    return Array.from(latest.values()).map((review) => ({
      ...review,
      activityAt: new Date(latestActivity.get(review.author)).toISOString(),
    }));
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
    const raw = this._gh('gh', [
      'pr', 'view', String(pr),
      ...(this._repository ? ['--repo', this._repository] : []),
      '--json', 'commits', '-q', '.commits[-1].committedDate',
    ]);
    const t = Date.parse(String(raw || '').trim());
    return Number.isFinite(t) ? t : null;
  }

  /**
   * Predict files that would conflict when merging `baseRef` into `headRef` WITHOUT
   * touching the working tree, via `git merge-tree --write-tree`. Returns
   * `{ supported: false, reason }` when conflict prediction is unavailable (git
   * < 2.38, an unreadable ref, or a non-conflict error) so the bundle degrades
   * gracefully rather than failing the whole gather.
   *
   * @param {{ baseRef: string, cwd?: string, headRef?: string }} ctx
   * @returns {Promise<{ supported: boolean, conflicted?: boolean, files?: string[], reason?: string }>}
   */
  async detectConflicts({ baseRef, cwd, headRef = 'HEAD' }) {
    const opts = cwd ? { cwd } : undefined;
    try {
      // Exit 0 = clean merge. `--name-only` reduces the conflict report to bare
      // paths; `--no-messages` suppresses the human-readable conflict prose.
      this._git(
        'git',
        ['merge-tree', '--write-tree', '--name-only', '--no-messages', baseRef, headRef],
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
