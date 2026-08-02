'use strict';

/**
 * merge command — opt-in conditional auto-merge.
 *
 * `forge merge --auto <pr> --expect-head <sha> --issue <id>` is the ONLY path by which Forge will merge a PR on
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
const { runIssueOperation } = require('../forge-issues');
const { PrStateAdapter } = require('../adapters/pr-state-adapter');
const { stripGlobalFlags } = require('../global-flags');

const FULL_HEAD_SHA = /^[0-9a-f]{40}$/i;
const FORGE_ISSUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_PR_NUMBER = /^[1-9][0-9]*$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CHECK_RUN_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'COMPLETED', 'WAITING', 'PENDING', 'REQUESTED']);
const CHECK_RUN_CONCLUSIONS = new Set([
  '', 'SUCCESS', 'FAILURE', 'NEUTRAL', 'CANCELLED', 'SKIPPED', 'TIMED_OUT',
  'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE',
]);
const STATUS_CONTEXT_STATES = new Set(['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS']);
const REVIEW_ACTOR_TYPENAMES = new Set([
  'Bot', 'EnterpriseUserAccount', 'Mannequin', 'Organization', 'User',
]);
const REVIEW_STATES = new Set([
  'APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING',
]);

function normalizeFullHeadSha(value) {
  return typeof value === 'string' && FULL_HEAD_SHA.test(value) ? value.toLowerCase() : null;
}

function normalizePrNumber(value) {
  if (typeof value !== 'string' || !POSITIVE_PR_NUMBER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

function normalizeKernelPrNumber(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' ? normalizePrNumber(value) : null;
}

function normalizeRepository(value) {
  return typeof value === 'string' && REPOSITORY_NAME.test(value) ? value.toLowerCase() : null;
}

function parseMergeArgs(argv) {
  const values = { auto: false, pr: null, expectedHead: null, issueId: null, error: null };
  const seen = new Set();
  const input = Array.isArray(argv) ? argv : [];

  for (let index = 0; index < input.length; index += 1) {
    const raw = String(input[index]);
    if (raw === '--auto') {
      values.auto = true;
      continue;
    }

    let option = null;
    let inlineValue = null;
    if (raw === '--expect-head' || raw === '--issue') option = raw;
    else if (raw.startsWith('--expect-head=')) {
      option = '--expect-head';
      inlineValue = raw.slice('--expect-head='.length);
    } else if (raw.startsWith('--issue=')) {
      option = '--issue';
      inlineValue = raw.slice('--issue='.length);
    }

    if (option) {
      if (seen.has(option)) {
        values.error = `Duplicate ${option} is not allowed.`;
        break;
      }
      seen.add(option);
      let value = inlineValue;
      if (value === null) {
        const candidate = input[index + 1];
        if (candidate === undefined || String(candidate).startsWith('--')) {
          values.error = `${option} requires a value.`;
          break;
        }
        value = String(candidate);
        index += 1;
      }
      if (!value) {
        values.error = `${option} requires a value.`;
        break;
      }
      if (option === '--expect-head') values.expectedHead = normalizeFullHeadSha(value);
      else values.issueId = FORGE_ISSUE_ID.test(value) ? value.toLowerCase() : null;
      if ((option === '--expect-head' && !values.expectedHead)
        || (option === '--issue' && !values.issueId)) {
        values.error = `${option} has an invalid value.`;
        break;
      }
      continue;
    }

    if (raw.startsWith('--')) {
      values.error = `Unknown merge option: ${raw}`;
      break;
    }
    if (values.pr !== null) {
      values.error = 'Exactly one PR number is required.';
      break;
    }
    values.pr = normalizePrNumber(raw);
    if (!values.pr) {
      values.error = 'PR selector must be one positive decimal PR number.';
      break;
    }
  }

  return values;
}

function resolveOwnershipActor(env = process.env) {
  return (typeof env.FORGE_ACTOR === 'string' && env.FORGE_ACTOR.trim())
    || (typeof env.FORGE_SESSION_ID === 'string' && env.FORGE_SESSION_ID.trim())
    || null;
}

async function defaultVerifyIssueOwnership({
  issueId, projectRoot, actor: expectedActor, env = process.env, runIssue = runIssueOperation,
}) {
  const actor = expectedActor || resolveOwnershipActor(env);
  if (!actor) return { owned: false, actor: null, error: 'FORGE_ACTOR or FORGE_SESSION_ID is required.' };
  const frozenEnv = { ...env, FORGE_ACTOR: actor };
  const result = await runIssue('owns', [issueId], projectRoot, { env: frozenEnv });
  const data = result && result.data;
  const owned = result && result.ok === true && data && data.owned === true
    && data.expired === false && data.actor === actor && data.claimed_by === actor;
  return {
    owned: Boolean(owned),
    actor,
    claimedBy: data && data.claimed_by,
    expired: data && typeof data.expired === 'boolean' ? data.expired : null,
    error: result && result.error,
  };
}

async function defaultVerifyPrIssueBinding({
  issueId,
  pr,
  projectRoot,
  prContext,
  buildBroker,
}) {
  const number = normalizePrNumber(String(pr));
  const repository = normalizeRepository(prContext && prContext.repository);
  if (!number || !repository || !prContext || prContext.number !== Number(number)) {
    return { bound: false, error: 'PR identity is unreadable or does not match the requested PR number.' };
  }

  let built;
  const ownsDriver = !buildBroker;
  try {
    if (buildBroker) {
      built = await buildBroker({ projectRoot });
    } else {
      const { resolveGitCommonDir } = require('../kernel/broker');
      const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
      const gitCommonDir = resolveGitCommonDir(projectRoot);
      const deps = await buildMigratedKernelIssueDeps({ projectRoot, gitCommonDir });
      built = { gitCommonDir, broker: deps.kernelBroker, driver: deps.kernelDriver };
    }
    if (!built || !built.broker || typeof built.broker.listOpenPrs !== 'function'
      || typeof built.gitCommonDir !== 'string' || !built.gitCommonDir) {
      return { bound: false, error: 'Kernel PR linkage reader is unavailable.' };
    }
    const rows = await built.broker.listOpenPrs(built.gitCommonDir);
    if (!Array.isArray(rows)) return { bound: false, error: 'Kernel PR linkage is unreadable.' };
    const sameRepositoryRows = rows.filter((row) => row && normalizeRepository(row.repo) === repository);
    if (sameRepositoryRows.some((row) => !normalizeKernelPrNumber(row.number))) {
      return { bound: false, error: 'Kernel PR linkage contains a malformed PR number.' };
    }
    const matches = sameRepositoryRows.filter((row) => row
      && normalizeKernelPrNumber(row.number) === number);
    if (matches.length !== 1) {
      return { bound: false, error: 'Kernel PR linkage is missing or ambiguous.' };
    }
    const row = matches[0];
    const bound = row.state === 'open' && row.issue_id === issueId;
    return {
      bound,
      repository,
      number: Number(number),
      issueId: row.issue_id || null,
      error: bound ? null : 'Kernel PR row is not open or is linked to a different issue.',
    };
  } catch (err) {
    return { bound: false, error: `Kernel PR linkage verification failed: ${err.message}` };
  } finally {
    if (ownsDriver && built && built.driver && typeof built.driver.close === 'function') built.driver.close();
  }
}

function strictCheckSuccess(check) {
  if (!check || typeof check !== 'object') return false;
  const hasStatus = Object.prototype.hasOwnProperty.call(check, 'status');
  const hasConclusion = Object.prototype.hasOwnProperty.call(check, 'conclusion');
  const hasState = Object.prototype.hasOwnProperty.call(check, 'state');
  if (hasState) {
    return !hasStatus && !hasConclusion && String(check.state || '').toUpperCase() === 'SUCCESS';
  }
  return hasStatus && hasConclusion
    && String(check.status || '').toUpperCase() === 'COMPLETED'
    && String(check.conclusion || '').toUpperCase() === 'SUCCESS';
}

function malformedCheckObservation(check) {
  if (!check || typeof check !== 'object') return true;
  const name = check.name || check.context;
  if (typeof name !== 'string' || !name.trim()) return true;
  if (!Object.prototype.hasOwnProperty.call(check, 'appId')) return true;
  const hasStatus = Object.prototype.hasOwnProperty.call(check, 'status');
  const hasConclusion = Object.prototype.hasOwnProperty.call(check, 'conclusion');
  const hasState = Object.prototype.hasOwnProperty.call(check, 'state');
  const status = String(check.status || '').toUpperCase();
  const conclusion = String(check.conclusion || '').toUpperCase();
  const state = String(check.state || '').toUpperCase();
  if (hasState) {
    return hasStatus || hasConclusion || check.appId !== null
      || typeof check.state !== 'string' || !STATUS_CONTEXT_STATES.has(state);
  }
  if (!hasStatus || !hasConclusion || !Number.isInteger(check.appId) || check.appId <= 0) return true;
  if (hasStatus && (typeof check.status !== 'string' || !CHECK_RUN_STATUSES.has(status))) return true;
  if (hasConclusion && check.conclusion !== null && typeof check.conclusion !== 'string') return true;
  if (hasConclusion && !CHECK_RUN_CONCLUSIONS.has(conclusion)) return true;
  if (hasStatus && status === 'COMPLETED' && !conclusion) return true;
  if (hasStatus && status !== 'COMPLETED' && conclusion) return true;
  return ['status', 'conclusion', 'state']
    .some((key) => String(check[key] || '').toUpperCase() === 'UNREADABLE');
}

function mandatorySettleError(context) {
  if (!context || !Array.isArray(context.comments)) return 'Mandatory settle evidence is unreadable.';
  const nowMs = typeof context.now === 'number' ? context.now : Date.parse(context.now);
  if (!Number.isFinite(nowMs)) return 'Mandatory settle clock is unreadable.';
  const stamps = context.comments.map((comment) => Date.parse(comment && comment.at));
  if (stamps.some((stamp) => Number.isNaN(stamp))) return 'Mandatory settle comment evidence is unreadable.';
  if (context.lastActivityAt !== undefined && context.lastActivityAt !== null) {
    const lastActivity = typeof context.lastActivityAt === 'number'
      ? context.lastActivityAt : Date.parse(context.lastActivityAt);
    if (!Number.isFinite(lastActivity)) return 'Mandatory settle activity evidence is unreadable.';
    stamps.push(lastActivity);
  }
  if (stamps.length === 0) return null;
  const quietMs = nowMs - Math.max(...stamps);
  return quietMs >= 10 * 60_000
    ? null
    : 'Mandatory 10-minute settle has not elapsed since the latest comment or edit.';
}

function normalizeRequiredEntry(entry) {
  if (!entry || typeof entry.context !== 'string' || !entry.context.trim()) return null;
  if (!Object.prototype.hasOwnProperty.call(entry, 'appId')) return null;
  if (entry.appId !== null && (!Number.isInteger(entry.appId) || entry.appId <= 0)) return null;
  return { context: entry.context, appId: entry.appId };
}

function normalizeRollupObservation(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.__typename === 'StatusContext') {
    return { name: entry.context, state: entry.state };
  }
  if (entry.__typename === 'CheckRun') {
    return { name: entry.name, status: entry.status, conclusion: entry.conclusion };
  }
  return null;
}

function malformedRollupObservation(observation) {
  if (!observation || typeof observation.name !== 'string' || !observation.name.trim()) return true;
  const hasState = Object.prototype.hasOwnProperty.call(observation, 'state');
  if (hasState) {
    return Object.prototype.hasOwnProperty.call(observation, 'status')
      || Object.prototype.hasOwnProperty.call(observation, 'conclusion')
      || typeof observation.state !== 'string'
      || !STATUS_CONTEXT_STATES.has(observation.state.toUpperCase());
  }
  const status = String(observation.status || '').toUpperCase();
  const conclusion = String(observation.conclusion || '').toUpperCase();
  if (typeof observation.status !== 'string' || !CHECK_RUN_STATUSES.has(status)) return true;
  if (observation.conclusion !== null && typeof observation.conclusion !== 'string') return true;
  if (!CHECK_RUN_CONCLUSIONS.has(conclusion)) return true;
  if (status === 'COMPLETED' && !conclusion) return true;
  return status !== 'COMPLETED' && Boolean(conclusion);
}

function evaluateProtectedRequiredChecks(context) {
  if (!context || context.requiredCheckSource !== 'protection'
    || !Array.isArray(context.requiredChecks) || !Array.isArray(context.checks)) {
    return { allowed: false, reason: 'Protected required-check policy is unreadable or non-authoritative.' };
  }
  const required = context.requiredChecks.map(normalizeRequiredEntry);
  if (required.some((entry) => !entry)) {
    return { allowed: false, reason: 'Protected required-check policy contains malformed entries.' };
  }
  const policyApps = new Map();
  for (const entry of required) {
    if (!policyApps.has(entry.context)) policyApps.set(entry.context, new Set());
    policyApps.get(entry.context).add(entry.appId === null ? '*' : String(entry.appId));
  }
  if ([...policyApps.values()].some((apps) => apps.size > 1)) {
    return { allowed: false, reason: 'Protected required-check policy contains conflicting application identities.' };
  }
  if (context.checks.some(malformedCheckObservation)) {
    return { allowed: false, reason: 'Check-run observation collection contains malformed entries.' };
  }
  const missing = [];
  const nonSuccess = [];
  for (const entry of required) {
    const matching = context.checks.filter((check) => check
      && (check.name || check.context) === entry.context
      && (entry.appId === null || check.appId === entry.appId));
    const label = entry.appId === null ? entry.context : `${entry.context}@app:${entry.appId}`;
    if (matching.length === 0) missing.push(label);
    else if (matching.some((check) => !strictCheckSuccess(check))) nonSuccess.push(label);
  }
  if (missing.length || nonSuccess.length) {
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
    if (nonSuccess.length) parts.push(`non-success: ${nonSuccess.join(', ')}`);
    return {
      allowed: false,
      reason: `Protected required checks are not successful (${parts.join('; ')}).`,
      details: { missing, nonSuccess },
    };
  }
  return { allowed: true, details: { missing: [], nonSuccess: [] } };
}

function mandatoryContextError(context, expectedHead) {
  const observedHead = normalizeFullHeadSha(context && context.headSha);
  if (!observedHead || observedHead !== expectedHead) {
    return 'PR head changed or could not be verified against --expect-head.';
  }
  if (context.state !== 'OPEN') return 'PR lifecycle state is unreadable or is not OPEN.';
  if (context.isDraft !== false) return 'PR draft status is unreadable or the PR is still a draft.';
  if (context.conflicting !== false) return 'PR conflict status is unreadable or conflicting.';
  if (context.unresolvedThreads !== 0) return 'Review-thread state is unreadable or unresolved threads remain.';
  if (context.reviewEvidenceReadable !== true || !Array.isArray(context.reviews)) {
    return 'Review evidence is unreadable.';
  }
  for (const review of context.reviews) {
    const state = review && typeof review.state === 'string' ? review.state.toUpperCase() : '';
    const timestamps = review
      ? [review.createdAt, review.updatedAt, review.submittedAt, review.activityAt]
      : [];
    if (!review || typeof review.id !== 'string' || !review.id
      || typeof review.author !== 'string' || !review.author
      || !REVIEW_ACTOR_TYPENAMES.has(review.authorTypename)
      || !REVIEW_STATES.has(state)
      || typeof review.commitOid !== 'string' || !FULL_HEAD_SHA.test(review.commitOid)
      || typeof review.body !== 'string'
      || timestamps.length !== 4
      || timestamps.some((value) => typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) {
      return 'Review evidence contains malformed identity, state, timestamp, or commit-head data.';
    }
    if (state !== 'DISMISSED' && review.commitOid.toLowerCase() !== expectedHead) {
      return 'Latest active review evidence is stale for the expected PR head.';
    }
    if (state === 'CHANGES_REQUESTED' || state === 'PENDING') {
      return `Latest review state ${state} does not authorize merging.`;
    }
  }
  const settleError = mandatorySettleError(context);
  if (settleError) return settleError;
  if (!Array.isArray(context.checks) || context.checks.some(malformedCheckObservation)
    || context.checks.some((check) => !strictCheckSuccess(check))) {
    return 'Every check-run and status observation must be complete and successful.';
  }
  if (Object.prototype.hasOwnProperty.call(context, 'providerObservations')) {
    if (!Array.isArray(context.providerObservations)
      || context.providerObservations.some(malformedRollupObservation)
      || context.providerObservations.some((check) => !strictCheckSuccess(check))) {
      return 'The complete provider rollup must contain only terminal successful observations.';
    }
  }
  const protectedGate = evaluateProtectedRequiredChecks(context);
  return protectedGate.allowed ? null : protectedGate.reason;
}

/** Default `gh` runner. Only reached by the default fetch/merge seams (never in unit tests). */
function defaultGh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...options }); // NOSONAR S4036 - hardcoded CLI (gh), args array (no shell), developer-tool context
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
function fetchUnresolvedThreadCount(gh, { owner, repo, pr }) {
  try {
    if (!owner || !repo) return undefined;
    // Paginate through ALL review threads — a PR can have >100, and the ones on
    // later pages could be the unresolved/newest ones. Stopping at page 1 would
    // both miss them and make a large PR un-mergeable. Loop on the GraphQL cursor
    // until hasNextPage is false; any unreadable page → undefined (fail closed).
    const query = 'query($o:String!,$n:String!,$pr:Int!,$after:String){repository(owner:$o,name:$n)'
      + '{pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{isResolved isOutdated}}}}}';
    let after = '';
    let count = 0;
    for (let page = 0; page < 100; page += 1) { // 100-page cap = 10k threads backstop
      const args = ['api', 'graphql', '-f', `query=${query}`,
        '-F', `o=${owner}`, '-F', `n=${repo}`, '-F', `pr=${Number(pr)}`];
      if (after) args.push('-F', `after=${after}`);
      const data = JSON.parse(gh(args) || '{}');
      if (Object.prototype.hasOwnProperty.call(data, 'errors')
        && (!Array.isArray(data.errors) || data.errors.length > 0)) return undefined;
      const threads = (((data.data || {}).repository || {}).pullRequest || {}).reviewThreads;
      if (!threads || !Array.isArray(threads.nodes) || !threads.pageInfo
        || typeof threads.pageInfo.hasNextPage !== 'boolean'
        || (threads.pageInfo.endCursor !== null && typeof threads.pageInfo.endCursor !== 'string')
        || threads.nodes.some((thread) => !thread || typeof thread.isResolved !== 'boolean'
          || typeof thread.isOutdated !== 'boolean')) return undefined;
      count += threads.nodes.filter((thread) => thread.isResolved === false && thread.isOutdated === false).length;
      if (!threads.pageInfo.hasNextPage) return count;
      const nextCursor = threads.pageInfo.endCursor;
      if (typeof nextCursor !== 'string' || !nextCursor || nextCursor === after) return undefined;
      after = nextCursor;
    }
    return undefined; // exceeded the page cap → fail closed rather than undercount
  } catch (_err) {
    return undefined;
  }
}

function fetchCheckRunObservations(gh, { owner, repo, head }) {
  try {
    const pages = JSON.parse(gh([
      'api', '--paginate', '--slurp',
      `repos/${owner}/${repo}/commits/${head}/check-runs?filter=latest&per_page=100`,
    ]) || 'null');
    if (!Array.isArray(pages) || pages.length === 0
      || pages.some((page) => !page || !Array.isArray(page.check_runs)
        || !Number.isInteger(page.total_count) || page.total_count < 0)) return null;
    const runs = pages.flatMap((page) => page.check_runs);
    if (pages.some((page) => page.total_count !== pages[0].total_count)
      || pages[0].total_count !== runs.length) return null;
    if (runs.some((run) => {
      const name = run && typeof run.name === 'string' && run.name.trim() ? run.name : null;
      const appId = run && run.app && Number.isInteger(run.app.id) && run.app.id > 0 ? run.app.id : null;
      const headSha = normalizeFullHeadSha(run && run.head_sha);
      const status = String(run && run.status || '').toUpperCase();
      const conclusion = String(run && run.conclusion || '').toUpperCase();
      return !run || !Number.isInteger(run.id) || run.id <= 0 || !name || !appId || headSha !== head
        || !CHECK_RUN_STATUSES.has(status)
        || !Object.prototype.hasOwnProperty.call(run, 'conclusion')
        || (run.conclusion !== null && typeof run.conclusion !== 'string')
        || !CHECK_RUN_CONCLUSIONS.has(conclusion)
        || (status === 'COMPLETED' ? !conclusion : Boolean(conclusion));
    })) return null;
    return runs.map((run) => {
      const name = run.name;
      const appId = run.app.id;
      return {
        id: run.id,
        name,
        appId,
        status: String(run.status).toUpperCase(),
        conclusion: String(run.conclusion || '').toUpperCase(),
      };
    });
  } catch (_err) {
    return null;
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
async function defaultFetchPrContext({ pr, gh = defaultGh, now = Date.now() }) {
  const view = ghJson(gh, ['pr', 'view', String(pr), '--json',
    'number,headRefOid,baseRefName,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,comments,updatedAt']) || {};

  const rollup = Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : null;

  const comments = Array.isArray(view.comments)
    ? view.comments.map((c) => ({
      author: (c.author && c.author.login) || '',
      at: [c.createdAt, c.updatedAt, c.submittedAt]
        .filter(Boolean)
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || '',
    }))
    : [];

  const repoIdentity = ghJson(gh, ['repo', 'view', '--json', 'owner,name']);
  const owner = repoIdentity && repoIdentity.owner && repoIdentity.owner.login;
  const repo = repoIdentity && repoIdentity.name;
  const adapter = owner && repo
    ? new PrStateAdapter({ gh: (_cmd, adapterArgs) => gh(adapterArgs) })
    : null;
  const reviews = adapter ? await adapter.readReviews({ owner, repo, pr }) : [];
  const approvals = reviews
    .filter((r) => String(r.state).toUpperCase() === 'APPROVED')
    .map((r) => ({ author: typeof r.author === 'string' ? r.author : '' }));

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
    ...reviews.flatMap((r) => [r.activityAt, r.createdAt, r.updatedAt, r.submittedAt]),
    view.updatedAt || '',
  ].map((s) => Date.parse(s)).filter((n) => !Number.isNaN(n));
  const lastActivityAt = stamps.length ? Math.max(...stamps) : undefined;

  const base = typeof view.baseRefName === 'string' ? view.baseRefName : null;
  const headSha = normalizeFullHeadSha(view.headRefOid);
  let requiredChecks = null;
  let requiredCheckSource = null;
  let checks = null;
  const providerObservations = rollup ? rollup.map(normalizeRollupObservation) : null;
  if (adapter && base) {
    requiredChecks = await adapter.readRequiredCheckPolicy({ owner, repo, base });
    requiredCheckSource = adapter.lastRequiredSource;
    const checkRuns = headSha ? fetchCheckRunObservations(gh, { owner, repo, head: headSha }) : null;
    if (rollup && checkRuns && providerObservations.every((entry) => entry !== null)) {
      const statuses = rollup
        .filter((entry) => entry && entry.__typename === 'StatusContext')
        .map((entry) => ({
          name: typeof entry.context === 'string' ? entry.context : '',
          appId: null,
          state: String(entry.state || '').toUpperCase(),
        }));
      checks = [...checkRuns, ...statuses];
    }
  }

  return {
    number: Number.isInteger(view.number) ? view.number : null,
    repository: owner && repo ? `${owner}/${repo}` : null,
    headSha: view.headRefOid || null,
    checks,
    providerObservations,
    requiredChecks,
    requiredCheckSource,
    requiredChecksKnown: requiredCheckSource === 'protection' && Array.isArray(requiredChecks),
    unresolvedThreads: fetchUnresolvedThreadCount(gh, { owner, repo, pr }),
    behindBase,
    conflicting,
    isDraft,
    state,
    approvals,
    reviews,
    reviewEvidenceReadable: adapter !== null,
    comments,
    lastActivityAt,
    now,
  };
}

/** Default merge action (squash), atomically bound to the reviewed remote head. */
function defaultMergePr({ pr, expectedHead, repository, gh = defaultGh }) {
  const head = normalizeFullHeadSha(expectedHead);
  const repo = normalizeRepository(repository);
  if (!head) throw new Error('A full 40-character expected PR head SHA is required.');
  if (!normalizePrNumber(String(pr)) || !repo) throw new Error('A canonical PR number and repository are required.');
  gh(['pr', 'merge', String(pr), '--repo', repo, '--squash', '--match-head-commit', head]);
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
  const parsed = parseMergeArgs(stripGlobalFlags(argv));
  const pr = parsed.pr;
  const root = projectRoot || process.cwd();

  if (!parsed.auto || !pr) {
    return {
      success: false,
      merged: false,
      error: 'Usage: forge merge --auto <pr> --expect-head <40-char-sha> --issue <issue-id>',
    };
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

  if (parsed.error || !parsed.expectedHead || !parsed.issueId) {
    const reason = parsed.error
      || 'Enabled auto-merge requires --expect-head <full 40-character SHA> and --issue <Forge issue ID>.';
    return { success: false, merged: false, enabled: true, error: reason };
  }

  const verifyIssueOwnership = deps.verifyIssueOwnership || defaultVerifyIssueOwnership;
  const ownershipEnv = deps.env || process.env;
  const ownershipActor = resolveOwnershipActor(ownershipEnv);
  const ownershipInput = {
    issueId: parsed.issueId,
    projectRoot: root,
    actor: ownershipActor,
    env: { ...ownershipEnv },
  };
  let ownership;
  try {
    ownership = await verifyIssueOwnership(ownershipInput);
  } catch (err) {
    return { success: false, merged: false, error: `Failed to verify issue ownership: ${err.message}` };
  }
  if (!ownership || ownership.owned !== true || ownership.expired !== false
    || typeof ownership.actor !== 'string' || ownership.actor !== ownershipActor
    || typeof ownership.claimedBy !== 'string' || ownership.claimedBy !== ownershipActor) {
    return {
      success: false,
      merged: false,
      error: `Active Kernel ownership claim is required for issue ${parsed.issueId}; refusing to merge.`,
    };
  }

  const fetchPrContext = deps.fetchPrContext || defaultFetchPrContext;
  const mergePr = deps.mergePr || defaultMergePr;
  const verifyPrIssueBinding = deps.verifyPrIssueBinding || defaultVerifyPrIssueBinding;
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
  if (prState === 'MERGED' || prState === 'CLOSED') {
    const reason = `PR #${pr} is ${prState} (not OPEN) — nothing to merge. No action taken.`;
    process.stdout.write(`${reason}\n`);
    return { success: true, merged: false, enabled: true, state: prState, reason };
  }

  const mandatoryError = mandatoryContextError(prContext, parsed.expectedHead);
  if (mandatoryError) return { success: false, merged: false, error: mandatoryError };
  const leasedRepository = normalizeRepository(prContext && prContext.repository);
  if (!leasedRepository) {
    return { success: false, merged: false, error: 'PR repository identity is unreadable; refusing to merge.' };
  }

  let binding;
  try {
    binding = await verifyPrIssueBinding({
      issueId: parsed.issueId,
      pr,
      projectRoot: root,
      prContext,
      buildBroker: deps.buildPrBindingBroker,
    });
  } catch (err) {
    return { success: false, merged: false, error: `Failed to verify PR issue binding: ${err.message}` };
  }
  if (!binding || binding.bound !== true) {
    return { success: false, merged: false, error: 'PR is not authoritatively linked to the supplied Forge issue.' };
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
  if (freshState === 'MERGED' || freshState === 'CLOSED') {
    const reason = `PR #${pr} became ${freshState} (not OPEN) before merge — nothing to merge. No action taken.`;
    process.stdout.write(`${reason}\n`);
    return { success: true, merged: false, enabled: true, state: freshState, reason };
  }
  const freshMandatoryError = mandatoryContextError(freshContext, parsed.expectedHead);
  if (freshMandatoryError) return { success: false, merged: false, error: freshMandatoryError };
  const freshRepository = normalizeRepository(freshContext && freshContext.repository);
  if (!freshRepository || freshRepository !== leasedRepository) {
    return { success: false, merged: false, error: 'PR repository identity changed or became unreadable before merge.' };
  }
  const recheck = evaluateMergeRules(freshContext, rules);
  if (!recheck.allowed) {
    process.stdout.write(`Auto-merge ABORTED for PR #${pr} — state changed since first check; ${recheck.unmet.length} rule(s) now unmet:\n`);
    for (const item of recheck.unmet) {
      process.stdout.write(`  x ${item.rule} — ${item.reason}\n`);
    }
    return { success: true, merged: false, enabled: true, allowed: false, unmet: recheck.unmet, reason: 'PR state changed before merge (live re-check failed)' };
  }

  let freshBinding;
  try {
    freshBinding = await verifyPrIssueBinding({
      issueId: parsed.issueId,
      pr,
      projectRoot: root,
      prContext: freshContext,
      buildBroker: deps.buildPrBindingBroker,
    });
  } catch (err) {
    return { success: false, merged: false, error: `Failed to re-verify PR issue binding: ${err.message}` };
  }
  if (!freshBinding || freshBinding.bound !== true) {
    return { success: false, merged: false, error: 'PR issue linkage changed or is unreadable before merge.' };
  }

  let finalOwnership;
  try {
    finalOwnership = await verifyIssueOwnership(ownershipInput);
  } catch (err) {
    return { success: false, merged: false, error: `Failed to re-verify issue ownership before merge: ${err.message}` };
  }
  if (!finalOwnership || finalOwnership.owned !== true || finalOwnership.expired !== false
    || typeof finalOwnership.actor !== 'string' || finalOwnership.actor !== ownershipActor
    || typeof finalOwnership.claimedBy !== 'string' || finalOwnership.claimedBy !== ownershipActor) {
    return { success: false, merged: false, error: 'Kernel ownership changed or expired before merge; refusing to merge.' };
  }

  try {
    const mergeResult = await mergePr({
      pr,
      expectedHead: parsed.expectedHead,
      repository: leasedRepository,
      issueId: parsed.issueId,
      projectRoot: root,
      gh,
    });
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
  usage: 'Usage: forge merge --auto <pr> --expect-head <40-char-sha> --issue <issue-id>',
  handler,
  // Exported seams for testing / reuse.
  defaultFetchPrContext,
  defaultMergePr,
  defaultVerifyPrIssueBinding,
  defaultVerifyIssueOwnership,
  evaluateProtectedRequiredChecks,
  normalizeFullHeadSha,
  normalizePrNumber,
  parseMergeArgs,
};
