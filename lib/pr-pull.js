'use strict';

/**
 * PR pull-signal — the "extract WHY, hand back ONE compact fix-payload" half of
 * the shepherd (issue 33e1bbd3).
 *
 * `forge shepherd <pr>` decides a STATE (MERGE_READY/PENDING/ESCALATE...). It
 * does not tell an agent *why* a check failed or *what* review feedback to fix.
 * Without this, an agent must manually run `gh pr checks`, `gh run view
 * --log-failed`, grep the logs, and GraphQL-query threads — token-heavy and slow.
 *
 * `gatherPullSignal` does ALL of that IN CODE and returns one bounded payload:
 *   - `failures[]`  — per FAILED check: name, conclusion, jobUrl, the ACTUAL
 *     failure lines pulled from that job's log (not the whole log), and
 *     `alsoFailedOn` (identical excerpts across matrix jobs collapse to one).
 *   - `reviewThreads[]` — unresolved, non-outdated threads that need action,
 *     INCLUDING review bots (CodeRabbit etc.) because those comments ARE the
 *     fixes — mapped to `{ file, line, author, body, threadId, commentId }`.
 *   - `state` + a one-line `summary` from the existing decision pass.
 *
 * It NEVER merges and NEVER resolves threads — it only reads and extracts. The
 * state machine (lib/pr-shepherd.js) is untouched; this module composes over it.
 *
 * All `gh` I/O goes through an INJECTABLE runner (`runGh`) and a validated
 * pr-state adapter, so unit tests exercise the extraction/dedupe/shaping logic
 * against fixtures without ever touching real GitHub.
 *
 * @module pr-pull
 */

const { isFailed, runShepherdPass } = require('./pr-shepherd');

/** Token caps that keep the payload bounded regardless of PR size. */
const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_MAX_THREADS = 20;
const DEFAULT_MAX_EXCERPT_LINES = 30;
// Fetch a few more logs than we ultimately show, so matrix duplicates can
// collapse (via dedupe) BEFORE the maxFailures slice — otherwise N identical
// matrix failures would eat the whole failure budget and hide distinct ones.
const LOG_FETCH_MULTIPLIER = 3;

/**
 * Bot logins whose review threads ARE actionable fixes (their comments tell you
 * what to change). Distinct from pure-automation bots (github-actions, codecov,
 * dependabot) whose threads are noise, not review feedback.
 */
const REVIEW_BOT_LOGINS = new Set([
  'coderabbitai', 'coderabbitai[bot]',
  'greptile-apps', 'greptile-apps[bot]',
  'qodo-merge-pro', 'qodo-merge-pro[bot]',
  'sonarqubecloud', 'sonarqubecloud[bot]',
]);

/** Pure-automation bots whose threads are never review feedback. */
const AUTOMATION_BOT_LOGINS = new Set([
  'github-actions', 'github-actions[bot]',
  'codecov', 'codecov[bot]',
  'dependabot', 'dependabot[bot]',
]);

// Signals that a log line is part of the actual failure (test framework "fail"
// markers, assertion diffs, error prose) rather than passing/progress noise.
const FAILURE_SIGNAL = /\(fail\)|✗|✘|✖|×|\bFAIL(?:ED|URE)?\b|\bError:|\berror:|AssertionError|Assertion failed|expect\(|Expected:|Received:|^\s*not ok\b|npm ERR!/;

/**
 * Strip the `gh run view --log[-failed]` prefix from a line.
 *
 * gh emits `jobName\tstepName\t<ISO-timestamp> content` (and sometimes a bare
 * leading timestamp). Removing everything up to and including the timestamp
 * leaves just the content — which is what makes two matrix jobs' excerpts
 * byte-identical (the job-name/timestamp prefix is the only thing that differs).
 *
 * @param {string} line
 * @returns {string}
 */
function cleanLogLine(line) {
  const s = String(line).replace(/\r$/, '');
  const m = s.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/);
  if (m) return s.slice(m.index + m[0].length);
  return s;
}

/**
 * Extract the ACTUAL failure lines from a raw job log — the `(fail)` test lines,
 * assertion diffs, and error text — not the whole log. Falls back to the log
 * tail (where the error usually lands) when no failure signal is present.
 * Repeated identical lines collapse; the result is capped at `maxLines`.
 *
 * @param {string} logText
 * @param {{ maxLines?: number }} [opts]
 * @returns {string} newline-joined excerpt
 */
function extractFailureExcerpt(logText, opts = {}) {
  const maxLines = opts.maxLines || DEFAULT_MAX_EXCERPT_LINES;
  const cleaned = String(logText || '').split(/\r?\n/).map(cleanLogLine);
  const nonEmpty = cleaned.filter((l) => l.trim());
  const signal = nonEmpty.filter((l) => FAILURE_SIGNAL.test(l));
  const chosen = signal.length > 0 ? signal : nonEmpty.slice(-maxLines);

  // Collapse duplicate lines (matrix logs repeat the same assertion many times)
  // while preserving first-seen order.
  const seen = new Set();
  const unique = [];
  for (const line of chosen) {
    if (seen.has(line)) continue;
    seen.add(line);
    unique.push(line);
  }
  return unique.slice(0, maxLines).join('\n');
}

/**
 * Pull the numeric job id out of an Actions "details" URL
 * (`.../actions/runs/<run>/job/<job>`). Returns null when absent.
 *
 * @param {string} url
 * @returns {string | null}
 */
function jobIdFromUrl(url) {
  const m = String(url || '').match(/\/job\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Collapse identical failure excerpts across matrix jobs into ONE entry, keeping
 * the first job as the representative and recording how many OTHER jobs shared
 * the identical failure in `alsoFailedOn` (0 when unique). Distinct failures
 * with an empty excerpt are NOT merged (an empty excerpt is not evidence of
 * sameness).
 *
 * @param {Array<{name:string,conclusion:string,jobUrl:string,excerpt:string}>} rawFailures
 * @returns {Array<{name:string,conclusion:string,jobUrl:string,excerpt:string,alsoFailedOn:number}>}
 */
function dedupeFailures(rawFailures) {
  const groups = new Map();
  const order = [];
  (Array.isArray(rawFailures) ? rawFailures : []).forEach((f, index) => {
    const excerpt = String(f.excerpt || '');
    // Empty excerpts get a per-item key so unrelated "no evidence" failures stay
    // separate instead of collapsing into a single misleading entry.
    const key = excerpt.trim() ? excerpt : `__empty__${index}`;
    if (!groups.has(key)) {
      groups.set(key, { rep: f, count: 0 });
      order.push(key);
    } else {
      groups.get(key).count += 1;
    }
  });
  return order.map((key) => {
    const { rep, count } = groups.get(key);
    return {
      name: rep.name,
      conclusion: rep.conclusion,
      jobUrl: rep.jobUrl,
      excerpt: String(rep.excerpt || ''),
      alsoFailedOn: count,
    };
  });
}

function commentAuthorClass(author) {
  const a = String(author || '').toLowerCase();
  if (!a) return 'unknown';
  if (REVIEW_BOT_LOGINS.has(a)) return 'review-bot';
  if (AUTOMATION_BOT_LOGINS.has(a)) return 'automation';
  return 'human';
}

/**
 * Filter review threads to the ones that need action and map them to the compact
 * fix shape. Actionable = unresolved AND not outdated AND authored (in at least
 * one comment) by a human OR a REVIEW bot (CodeRabbit et al.), excluding the
 * shepherd's own login and pure-automation bots. Capped at `maxThreads`.
 *
 * @param {object[]} threads - from adapter.readComments
 * @param {string} [self] - the shepherd's own login (excluded to avoid self-wake)
 * @param {{ maxThreads?: number }} [opts]
 * @returns {Array<{file:string|null,line:number|null,author:string,body:string,threadId:string|null,commentId:string|null}>}
 */
function buildReviewThreads(threads, self, opts = {}) {
  const maxThreads = opts.maxThreads || DEFAULT_MAX_THREADS;
  const selfLower = String(self || '').toLowerCase();
  const out = [];
  for (const t of (Array.isArray(threads) ? threads : [])) {
    if (t.isResolved || t.resolved || t.isOutdated || t.outdated) continue;
    const comments = Array.isArray(t.comments) ? t.comments : [];
    // Anchor on the first comment whose author is a human or a review bot and is
    // not the shepherd itself — that comment carries the fix to act on.
    const anchor = comments.find((c) => {
      const author = String((c.author && c.author.login) || c.author || '').toLowerCase();
      if (!author || author === selfLower) return false;
      const cls = commentAuthorClass(author);
      return cls === 'human' || cls === 'review-bot';
    });
    if (!anchor) continue;
    out.push({
      file: t.path || null,
      line: typeof t.line === 'number' ? t.line : null,
      author: String((anchor.author && anchor.author.login) || anchor.author || ''),
      body: String(anchor.body || ''),
      threadId: t.threadId || t.id || null,
      commentId: anchor.commentId || anchor.databaseId || anchor.id || null,
    });
    if (out.length >= maxThreads) break;
  }
  return out;
}

/**
 * Assemble the final bounded payload, enforcing every token cap (failures,
 * threads, per-excerpt line count) and flagging truncation so a consumer knows
 * the view was trimmed.
 *
 * @param {object} args
 * @returns {object}
 */
function buildPullPayload({
  state,
  summary,
  reason,
  failures = [],
  reviewThreads = [],
  maxFailures = DEFAULT_MAX_FAILURES,
  maxThreads = DEFAULT_MAX_THREADS,
  maxExcerptLines = DEFAULT_MAX_EXCERPT_LINES,
}) {
  const cappedFailures = failures.slice(0, maxFailures).map((f) => ({
    ...f,
    excerpt: String(f.excerpt || '').split('\n').slice(0, maxExcerptLines).join('\n'),
  }));
  const cappedThreads = reviewThreads.slice(0, maxThreads);
  return {
    state,
    summary,
    ...(reason ? { reason } : {}),
    failures: cappedFailures,
    reviewThreads: cappedThreads,
    truncated: {
      failures: failures.length > maxFailures,
      reviewThreads: reviewThreads.length > maxThreads,
    },
  };
}

/**
 * Order failed checks so REQUIRED ones are diagnosed first (they gate merge),
 * then bound how many logs we fetch.
 */
function orderFailedChecks(checks, requiredSet) {
  const required = Array.isArray(requiredSet) ? requiredSet : [];
  const failed = (Array.isArray(checks) ? checks : []).filter(isFailed);
  return failed
    .map((c, i) => ({ c, i, req: required.includes(c.name) ? 0 : 1 }))
    .sort((a, b) => (a.req - b.req) || (a.i - b.i))
    .map((x) => x.c);
}

/**
 * One-line human summary of the pull signal.
 */
function summarize({ state, failureCount, threadCount }) {
  const parts = [];
  parts.push(`${failureCount} failing check${failureCount === 1 ? '' : 's'}`);
  parts.push(`${threadCount} review thread${threadCount === 1 ? '' : 's'} to address`);
  return `${state}: ${parts.join(', ')}.`;
}

/**
 * Gather the complete pull signal for a PR: decision state + why-it-failed
 * excerpts (matrix-deduped) + the review-thread fix-list. Pure orchestration
 * over a validated pr-state adapter and an injected `gh` runner — no live
 * GitHub, no merging, no thread resolution.
 *
 * @param {object} ctx
 * @param {string} ctx.pr
 * @param {string} ctx.owner
 * @param {string} ctx.repo
 * @param {string} ctx.base    - base BRANCH name (branch-protection lookup)
 * @param {string} ctx.baseRef - base REF for divergence (e.g. origin/master)
 * @param {string} [ctx.cwd]
 * @param {string} [ctx.self]  - shepherd's own login
 * @param {object} ctx.adapter - validated pr-state adapter
 * @param {(args: string[]) => string} ctx.runGh - injected `gh` runner (args → stdout)
 * @param {Function} [ctx.runPass] - decision pass (default runShepherdPass), injectable for tests
 * @param {number} [ctx.maxFailures]
 * @param {number} [ctx.maxThreads]
 * @param {number} [ctx.maxExcerptLines]
 * @returns {Promise<object>} the bounded pull payload
 */
async function gatherPullSignal(ctx) {
  const {
    pr, owner, repo, base, cwd, self, adapter, runGh,
    runPass = runShepherdPass,
    maxFailures = DEFAULT_MAX_FAILURES,
    maxThreads = DEFAULT_MAX_THREADS,
    maxExcerptLines = DEFAULT_MAX_EXCERPT_LINES,
  } = ctx;

  if (!adapter || typeof adapter.readState !== 'function') {
    throw new Error('gatherPullSignal requires a pr-state adapter with readState');
  }
  if (typeof runGh !== 'function') {
    throw new Error('gatherPullSignal requires an injected `runGh` runner');
  }

  // Decision state (reuses the existing state machine unchanged).
  const pass = await runPass({ ...ctx, adapter });

  // Read CI + required set + threads directly for the extraction half.
  const state = await adapter.readState(pr);
  let requiredSet = null;
  try {
    requiredSet = await adapter.readRequiredChecks({ owner, repo, base });
  } catch (_err) {
    void _err; // unreadable protection → keep null ("unknown"), still diagnose
  }

  // Fetch logs for failed checks (required first), bounded so matrix dupes can
  // collapse before the final slice. Each fetch is guarded — one bad log must
  // not sink the payload.
  const failedChecks = orderFailedChecks(state.checks, requiredSet)
    .slice(0, maxFailures * LOG_FETCH_MULTIPLIER);
  const rawFailures = failedChecks.map((check) => {
    const jobId = jobIdFromUrl(check.detailsUrl);
    let log = '';
    if (jobId) {
      try {
        log = runGh(['run', 'view', '--job', jobId, '--log-failed']) || '';
      } catch (_err) {
        log = ''; // degrade to an empty excerpt, keep the failure visible
      }
    }
    return {
      name: check.name,
      conclusion: check.conclusion,
      jobUrl: check.detailsUrl || null,
      excerpt: extractFailureExcerpt(log, { maxLines: maxExcerptLines }),
    };
  });
  const failures = dedupeFailures(rawFailures);

  // Review-thread fix-list (includes CodeRabbit; never resolves anything).
  let threads = [];
  try {
    threads = typeof adapter.readComments === 'function'
      ? await adapter.readComments({ owner, repo, pr, cwd })
      : [];
  } catch (_err) {
    void _err; // unreadable threads → keep the empty fix-list, don't sink payload
  }
  const reviewThreads = buildReviewThreads(threads, self, { maxThreads });

  const summary = summarize({
    state: pass.state,
    failureCount: failures.length,
    threadCount: reviewThreads.length,
  });

  return buildPullPayload({
    state: pass.state,
    reason: pass.reason,
    summary,
    failures,
    reviewThreads,
    maxFailures,
    maxThreads,
    maxExcerptLines,
  });
}

module.exports = {
  gatherPullSignal,
  cleanLogLine,
  extractFailureExcerpt,
  jobIdFromUrl,
  dedupeFailures,
  buildReviewThreads,
  buildPullPayload,
  REVIEW_BOT_LOGINS,
  AUTOMATION_BOT_LOGINS,
};
