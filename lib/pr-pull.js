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

const { isFailed, isGreen, runShepherdPass } = require('./pr-shepherd');

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

/** Pure-automation bots whose review THREADS are never review feedback. NOTE:
 * codecov lives here for THREAD classification (its inline threads are noise),
 * but its plain status COMMENT is still scanned for a failure signal by the
 * bot-status scanner below — the two paths are deliberately independent so a
 * failure-signalling status comment is never dropped as "automation noise". */
const AUTOMATION_BOT_LOGINS = new Set([
  'github-actions', 'github-actions[bot]',
  'codecov', 'codecov[bot]',
  'dependabot', 'dependabot[bot]',
]);

/**
 * Status/deploy/quality bots that report FAILURE by posting a plain PR ISSUE
 * comment (a Quality-Gate/Deployment/coverage summary) rather than — or in
 * addition to — a check-run or commit-status. Their latest comment is scanned
 * for a failure signal by `buildBotStatusBlockers`. This is the FALLBACK path
 * for bots that only comment; the structured statusCheckRollup signal (handled
 * by classifyRequiredChecks) stays the primary, reliable catch.
 */
const STATUS_BOT_LOGINS = new Set([
  'vercel', 'vercel[bot]',
  'netlify', 'netlify[bot]',
  'sonarqubecloud', 'sonarqubecloud[bot]',
  'codecov', 'codecov[bot]', 'codecov-commenter',
  'cloudflare-pages', 'cloudflare-pages[bot]',
  'cloudflare-workers-and-pages', 'cloudflare-workers-and-pages[bot]',
  'render', 'render[bot]',
]);

// A line in a bot status comment that signals FAILURE / not-ready: an explicit
// failed quality gate, a failed/errored deployment, dropped coverage, or a
// failure glyph. Kept line-scoped (matched per line) so an unrelated word in a
// success comment ("0 failed") is unlikely to trip it, and so the matched line
// itself becomes the human-readable summary.
const BOT_STATUS_FAILURE_SIGNAL = /quality gate failed|failed the quality gate|deployment (?:has )?failed|deploy(?:ment)? (?:error|errored)|failed to deploy|build failed|coverage (?:decreased|dropped|declined|reduced)|patch coverage[^\n]*\bfail|❌|✖|✗|:x:|:no_entry(?:_sign)?:|⛔/i;

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

/** Lowercased login of an issue comment ({author:{login}} or a bare string). */
function issueCommentLogin(comment) {
  return String((comment.author && comment.author.login) || comment.author || '').toLowerCase();
}

/** Drop the trailing `[bot]` suffix for a readable bot name in the blocker text. */
function prettyBotName(login) {
  return String(login || '').replace(/\[bot\]$/i, '');
}

/**
 * The first line of a bot comment body that signals FAILURE, trimmed and capped —
 * or null when the comment shows no failure signal (i.e. it is healthy/ready, so
 * an earlier failure has been superseded).
 */
function botFailureSummary(body) {
  const lines = String(body || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (BOT_STATUS_FAILURE_SIGNAL.test(line)) return line.slice(0, 200);
  }
  return null;
}

/**
 * Scan plain PR ISSUE comments from known status/deploy/quality bots and surface
 * an actionable blocker for each bot whose LATEST comment signals failure.
 *
 * ACTIONABLE-ONLY + SUPERSESSION: only the newest comment per bot (by
 * `createdAt`, not array order) is examined — a later success comment supersedes
 * an earlier failure, and a bot edit-in-place is reflected in that one comment's
 * final body. Comments from non-status bots and humans are ignored (their
 * feedback flows through the review-thread path, not here). Capped at `cap`.
 *
 * @param {Array<{author:(object|string),body:string,createdAt?:string}>} comments
 * @param {{ cap?: number }} [opts]
 * @returns {Array<{ type: 'bot-status', detail: string }>}
 */
function buildBotStatusBlockers(comments, opts = {}) {
  const cap = opts.cap || DEFAULT_MAX_THREADS;
  const latestByBot = new Map();
  for (const c of (Array.isArray(comments) ? comments : [])) {
    const login = issueCommentLogin(c);
    if (!STATUS_BOT_LOGINS.has(login)) continue;
    const ts = Date.parse(c.createdAt || c.updatedAt || '') || 0;
    const prev = latestByBot.get(login);
    // `>=` so a same-timestamp (or timestamp-less) tie keeps the LATER array
    // entry — GitHub returns issue comments oldest-first.
    if (!prev || ts >= prev.ts) latestByBot.set(login, { ts, login, body: String(c.body || '') });
  }
  const out = [];
  for (const { login, body } of latestByBot.values()) {
    const summary = botFailureSummary(body);
    if (!summary) continue; // latest comment is healthy → superseded, not actionable
    out.push({
      type: 'bot-status',
      detail: `${prettyBotName(login)} reports a failing status: ${summary}`,
    });
    if (out.length >= cap) break;
  }
  return out;
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

/** A check whose conclusion is SKIPPED — green-ish by `isGreen`, but for a
 * REQUIRED context a skip means the gate never actually ran to success, so
 * branch protection keeps the PR blocked. Detected separately from real greens. */
function isSkipped(check) {
  return String(check.conclusion || '').toUpperCase() === 'SKIPPED';
}

/** A check still in flight (not green, not failed) — e.g. IN_PROGRESS/QUEUED or
 * a status context with no conclusion yet. */
function isPending(check) {
  return !isGreen(check) && !isFailed(check);
}

/**
 * Classify the branch-protection REQUIRED set against what the PR actually
 * produced — the ONLY reliable way to explain a PR that is BLOCKED while every
 * visible check is green. A required context is:
 *   - `missing`  — it never reported at all (a workflow that didn't trigger);
 *   - `skipped`  — every instance resolved SKIPPED (the policy-block cause: a
 *     required gate that skipped is NOT a success to branch protection);
 *   - `failing`  — any instance failed;
 *   - `pending`  — still running / not yet reported a conclusion.
 * Green required checks are intentionally OMITTED — the payload is actionable-only.
 * Matrix duplicates (same context name reported by multiple jobs) are aggregated
 * with failing > pending > skipped > green precedence.
 *
 * @param {object[]} checks - normalized rollup from readState.
 * @param {string[]|null} requiredSet - branch-protection contexts, or null when unreadable.
 * @returns {{ missing: string[], skipped: string[], pending: string[], failing: string[], unreadable: boolean }}
 */
function classifyRequiredChecks(checks, requiredSet) {
  if (!Array.isArray(requiredSet)) {
    return { missing: [], skipped: [], pending: [], failing: [], unreadable: true };
  }
  const byName = new Map();
  for (const c of (Array.isArray(checks) ? checks : [])) {
    const name = c.name || c.context || '';
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(c);
  }
  const missing = []; const skipped = []; const pending = []; const failing = [];
  for (const name of requiredSet) {
    const instances = byName.get(name);
    if (!instances || instances.length === 0) { missing.push(name); continue; }
    if (instances.some(isFailed)) { failing.push(name); continue; }
    if (instances.some(isPending)) { pending.push(name); continue; }
    // All instances are green-ish. If EVERY instance only ever skipped, the
    // required gate did not truly pass → policy block.
    if (instances.every(isSkipped)) { skipped.push(name); continue; }
    // otherwise a genuine success — omitted (actionable-only).
  }
  return { missing, skipped, pending, failing, unreadable: false };
}

/**
 * The unique names of checks still pending (any check, not just required),
 * deduped and bounded — surfaced so an agent knows the PR is simply not done yet
 * versus actively broken.
 */
function pendingCheckNames(checks, cap = DEFAULT_MAX_THREADS) {
  const seen = new Set();
  for (const c of (Array.isArray(checks) ? checks : [])) {
    if (isPending(c)) seen.add(c.name || c.context || '');
  }
  return [...seen].filter(Boolean).slice(0, cap);
}

const AND_LIST_CAP = 6;

/** Join a list of names for a blocker detail, truncating with a count. */
function joinNames(names) {
  const list = names.slice(0, AND_LIST_CAP);
  const extra = names.length - list.length;
  return extra > 0 ? `${list.join(', ')} (+${extra} more)` : list.join(', ');
}

/** Push `item` onto `arr` only when it is truthy (small helper so the blocker
 * assembly reads as a flat list without repeated `if`/`push` nesting). */
function pushMaybe(arr, item) {
  if (item) arr.push(item);
}

/** The draft blocker, or null when the PR is not a draft. */
function draftBlocker(draft) {
  return draft
    ? { type: 'draft', detail: 'PR is a draft — mark it "Ready for review" before it can merge.' }
    : null;
}

/**
 * The conflict blocker. A predicted conflict (`conflicts.conflicted === true`)
 * ALWAYS produces a blocker — even when the `files` list is empty/unparseable and
 * `mergeable`/`mergeStateStatus` don't literally say CONFLICTING/DIRTY — so the
 * payload's `conflicts` object and `blockers[]` never disagree. Falls back to the
 * mergeable/status signal when no file-level prediction is available.
 */
function conflictBlocker(conflicts, merge, status) {
  if (conflicts && conflicts.conflicted) {
    const files = Array.isArray(conflicts.files) ? conflicts.files : [];
    const detail = files.length > 0
      ? `Merge conflict in ${files.length} file(s): ${joinNames(files)} — resolve against base.`
      : 'Merge conflict detected against base — resolve and push.';
    return { type: 'conflict', detail };
  }
  if (merge === 'CONFLICTING' || status === 'DIRTY') {
    return { type: 'conflict', detail: 'Branch conflicts with base (mergeable=CONFLICTING) — rebase/merge base and resolve.' };
  }
  return null;
}

/** All required-check blockers (failing / missing / skipped / pending) in
 * most-actionable-first order. Empty when the required set is all green. */
function requiredCheckBlockers(rc) {
  const out = [];
  if ((rc.failing || []).length > 0) {
    out.push({ type: 'check-failing', detail: `Required check(s) failing: ${joinNames(rc.failing)} — see failures[] for the exact log excerpt.` });
  }
  if ((rc.missing || []).length > 0) {
    out.push({ type: 'check-missing', detail: `Required check(s) never reported: ${joinNames(rc.missing)} — the workflow did not trigger; push a commit or re-run CI.` });
  }
  if ((rc.skipped || []).length > 0) {
    out.push({ type: 'check-skipped', detail: `Required check(s) SKIPPED: ${joinNames(rc.skipped)} — a required gate that skips is NOT a pass to branch protection; it must run to success (this is why an all-green PR can stay BLOCKED).` });
  }
  if ((rc.pending || []).length > 0) {
    out.push({ type: 'check-pending', detail: `Required check(s) still running: ${joinNames(rc.pending)} — wait for them to finish.` });
  }
  return out;
}

/** The review-decision blocker (changes requested / review required), or null
 * when the decision is APPROVED or not required (actionable-only). */
function reviewDecisionBlocker(decision) {
  if (decision === 'CHANGES_REQUESTED') {
    return { type: 'changes-requested', detail: 'A reviewer requested changes — address the feedback and re-request review.' };
  }
  if (decision === 'REVIEW_REQUIRED') {
    return { type: 'review-required', detail: 'An approving review is still required before merge.' };
  }
  return null;
}

/**
 * Last-resort blocker for a PR that is NOT clean yet nothing concrete explained
 * why. Emitted ONLY when no specific blocker fired, so a non-mergeable PR is
 * never silently invisible (the #353 failure mode). Covers, in priority order:
 *   - unreadable required checks (a branch-protection 403 must not stay hidden);
 *   - UNSTABLE with a failing non-required check;
 *   - BLOCKED by branch protection;
 *   - any OTHER non-clean, known status (BEHIND, HAS_HOOKS, …) whose cause wasn't
 *     otherwise derivable — e.g. BEHIND when the commit count was unavailable.
 * A clean or unknown status yields no fallback.
 */
function fallbackBlocker(status, rc, failuresCount) {
  if (rc.unreadable) {
    return { type: 'check-required-unreadable', detail: 'Branch-protection required checks could not be read (e.g. a 403 from the protection API) — cannot confirm the required gates passed; verify branch-protection settings and token permissions.' };
  }
  if (status === 'UNSTABLE') {
    return failuresCount > 0
      ? { type: 'unstable', detail: 'A non-required check is failing (mergeStateStatus=UNSTABLE). It does not gate merge but is worth fixing — see failures[].' }
      : null;
  }
  if (status === 'BLOCKED') {
    return { type: 'blocked-unknown', detail: 'Merge is blocked by branch protection (mergeStateStatus=BLOCKED) but no failing check, missing/skipped required check, unresolved thread, or negative review was detected — check required reviews, code-owner approval, or other protection rules.' };
  }
  if (status && status !== 'CLEAN' && status !== 'UNKNOWN') {
    return { type: 'blocked-unknown', detail: `Merge is not clean (mergeStateStatus=${status}) but no specific cause was derivable — update the branch and re-check required gates, reviews, or protection rules.` };
  }
  return null;
}

/**
 * Compute the ordered, deduped list of concrete merge BLOCKERS — the
 * human-readable WHY behind `mergeStateStatus`. Ordered most-actionable-first so
 * an agent fixes the real gate, not a symptom. Every entry is something to ACT
 * on; nothing that is already satisfied is listed (actionable-only). When the
 * status is non-clean but no specific cause is derivable from the available
 * signals, a single explicit fallback blocker is emitted so the block is never
 * silently invisible (the #353 failure mode). Per-concern logic lives in the
 * small helpers above; this function just orders and assembles them.
 *
 * @param {object} args
 * @returns {Array<{ type: string, detail: string }>}
 */
function computeBlockers({
  mergeable,
  mergeStateStatus,
  draft = false,
  reviewDecision = null,
  requiredClass = { missing: [], skipped: [], pending: [], failing: [], unreadable: false },
  botStatusBlockers = [],
  unresolvedThreadCount = 0,
  behind = 0,
  conflicts = null,
  failuresCount = 0,
}) {
  const status = String(mergeStateStatus || '').toUpperCase();
  const merge = String(mergeable || '').toUpperCase();
  const decision = String(reviewDecision || '').toUpperCase();
  const rc = requiredClass || {};
  const out = [];

  pushMaybe(out, draftBlocker(draft));
  pushMaybe(out, conflictBlocker(conflicts, merge, status));
  out.push(...requiredCheckBlockers(rc));
  // Bot status/deploy/quality comment failures (Vercel/SonarCloud/Codecov...) —
  // as actionable as a failing check, so they slot in right after them.
  out.push(...(Array.isArray(botStatusBlockers) ? botStatusBlockers : []));
  if (behind > 0) {
    out.push({ type: 'behind', detail: `Branch is ${behind} commit(s) behind base — update/rebase the branch (protection requires branches be up to date).` });
  }
  pushMaybe(out, reviewDecisionBlocker(decision));
  if (unresolvedThreadCount > 0) {
    out.push({ type: 'unresolved-threads', detail: `${unresolvedThreadCount} unresolved review thread(s) must be resolved before merge (see reviewThreads[]).` });
  }

  // Nothing concrete explained a non-clean status → make the block visible.
  if (out.length === 0) {
    pushMaybe(out, fallbackBlocker(status, rc, failuresCount));
  }

  return out;
}

/** Summary lines for the blockers section (numbered, or a "none" note). */
function blockerLines(blockers) {
  if (blockers.length === 0) {
    return ['Blockers: none detected (nothing actionable this pass).'];
  }
  const lines = [`Blockers (${blockers.length}):`];
  blockers.forEach((b, i) => lines.push(`  ${i + 1}. [${b.type}] ${b.detail}`));
  return lines;
}

/** Summary lines for the failing-checks section (empty when none). */
function failureLines(failures) {
  if (failures.length === 0) return [];
  const lines = [`Failing checks (${failures.length}):`];
  for (const f of failures) {
    const also = f.alsoFailedOn ? ` (+${f.alsoFailedOn} matrix job(s))` : '';
    lines.push(`  • ${f.name}${also}`);
    const first = String(f.excerpt || '').split('\n').filter(Boolean)[0];
    if (first) lines.push(`      ${first}`);
  }
  return lines;
}

/** Summary lines for the unresolved-review-threads section (empty when none). */
function threadLines(threads) {
  if (threads.length === 0) return [];
  const lines = [`Unresolved review threads (${threads.length}):`];
  for (const t of threads) {
    const loc = t.file ? `${t.file}${t.line != null ? `:${t.line}` : ''}` : '(general)';
    const firstLine = String(t.body || '').split('\n').filter(Boolean)[0] || '';
    lines.push(`  • ${loc} — ${t.author}: ${firstLine.slice(0, 120)}`);
  }
  return lines;
}

/**
 * Render the bounded payload as a compact human-readable summary (the non-JSON
 * view). Actionable-only, so a maintainer reads exactly what to fix. Section
 * construction lives in the small helpers above; this function just orders them.
 *
 * @param {object} payload - a payload produced by buildPullPayload.
 * @returns {string}
 */
function renderPullSummary(payload) {
  const p = payload || {};
  const lines = [];
  const merge = `mergeable=${p.mergeable || 'UNKNOWN'}, mergeStateStatus=${p.mergeStateStatus || 'UNKNOWN'}`;
  lines.push(`PR #${p.pr || '?'} — ${p.state || 'UNKNOWN'} (${merge})`);
  if (p.summary) lines.push(p.summary);
  lines.push(...blockerLines(Array.isArray(p.blockers) ? p.blockers : []));
  lines.push(...failureLines(Array.isArray(p.failures) ? p.failures : []));
  lines.push(...threadLines(Array.isArray(p.reviewThreads) ? p.reviewThreads : []));
  return lines.join('\n');
}

/** `{ pr }` (stringified) when a PR number is given, else `{}`. */
function prField(pr) {
  return pr !== undefined ? { pr: String(pr) } : {};
}

/** Surface reviewDecision only when it is a BLOCKER (actionable-only): APPROVED
 * and "not required" ('') are omitted. */
function reviewDecisionField(reviewDecision) {
  return (reviewDecision === 'CHANGES_REQUESTED' || reviewDecision === 'REVIEW_REQUIRED')
    ? { reviewDecision }
    : {};
}

/**
 * Actionable-only required-check block: included only when SOMETHING about the
 * required set needs attention (missing/skipped/pending/failing) or it was
 * unreadable. All-green required sets are omitted entirely.
 */
function requiredChecksField(requiredChecks) {
  const rc = requiredChecks || {};
  const hasMissing = !!(rc.missing && rc.missing.length);
  const hasSkipped = !!(rc.skipped && rc.skipped.length);
  const hasPending = !!(rc.pending && rc.pending.length);
  const hasFailing = !!(rc.failing && rc.failing.length);
  if (!(hasMissing || hasSkipped || hasPending || hasFailing || rc.unreadable)) return {};
  return {
    requiredChecks: {
      ...(hasMissing ? { missing: rc.missing } : {}),
      ...(hasSkipped ? { skipped: rc.skipped } : {}),
      ...(hasPending ? { pending: rc.pending } : {}),
      ...(hasFailing ? { failing: rc.failing } : {}),
      ...(rc.unreadable ? { unreadable: true } : {}),
    },
  };
}

/** `{ conflicts }` when a conflict is predicted, else `{}`. Mirrors the
 * conflict blocker: any `conflicted === true` surfaces here. */
function conflictsField(conflicts) {
  return (conflicts && conflicts.conflicted)
    ? { conflicts: { conflicted: true, files: Array.isArray(conflicts.files) ? conflicts.files : [] } }
    : {};
}

/**
 * Assemble the final bounded payload, enforcing every token cap (failures,
 * threads, per-excerpt line count) and flagging truncation so a consumer knows
 * the view was trimmed. Carries the full actionable-only blocker picture:
 * mergeability + WHY (`blockers`), required-check classification, pending checks,
 * behind-base, conflicts, review decision, and draft state. The conditional
 * field construction lives in the small helpers above.
 *
 * @param {object} args
 * @returns {object}
 */
function buildPullPayload({
  pr,
  state,
  summary,
  reason,
  mergeable = 'UNKNOWN',
  mergeStateStatus = 'UNKNOWN',
  draft = false,
  reviewDecision = null,
  blockers = [],
  requiredChecks = null,
  pendingChecks = [],
  behind = 0,
  conflicts = null,
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
    ...prField(pr),
    state,
    summary,
    ...(reason ? { reason } : {}),
    mergeable,
    mergeStateStatus,
    ...(draft ? { draft: true } : {}),
    ...reviewDecisionField(reviewDecision),
    blockers,
    ...requiredChecksField(requiredChecks),
    ...(pendingChecks && pendingChecks.length ? { pendingChecks } : {}),
    ...(behind > 0 ? { behind } : {}),
    ...conflictsField(conflicts),
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
 * One-line human summary of the pull signal — leads with the primary (first,
 * most-actionable) blocker so the WHY is legible at a glance.
 */
function summarize({ state, failureCount, threadCount, blockers = [] }) {
  const parts = [];
  parts.push(`${failureCount} failing check${failureCount === 1 ? '' : 's'}`);
  parts.push(`${threadCount} review thread${threadCount === 1 ? '' : 's'} to address`);
  const primary = (Array.isArray(blockers) && blockers[0]) ? ` Primary blocker: ${blockers[0].detail}` : '';
  return `${state}: ${parts.join(', ')}.${primary}`;
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

  // Decision state — reuses the existing state machine in READ-ONLY mode
  // (`dryRun`). `--pull` is a read verb: it computes the state but NEVER fires a
  // Tier-A rerun or any other mutation. Taking action belongs to plain
  // `forge shepherd <pr>`.
  const pass = await runPass({ ...ctx, adapter, dryRun: true });

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

  // --- Additional actionable blockers, each guarded so one failing read never
  // sinks the payload. All read-only. ---

  // Branch divergence (behind base → needs an update/rebase).
  let behind = 0;
  try {
    if (typeof adapter.readDivergence === 'function') {
      const div = await adapter.readDivergence({ baseRef: ctx.baseRef, cwd });
      behind = div.behind || 0;
    }
  } catch (_err) {
    void _err; // unknown divergence → treat as not-behind, keep diagnosing
  }

  // Predicted merge conflicts (which files) — optional adapter capability.
  let conflicts = null;
  try {
    if (typeof adapter.detectConflicts === 'function') {
      conflicts = await adapter.detectConflicts({ baseRef: ctx.baseRef, cwd });
    }
  } catch (_err) {
    void _err; // conflict prediction unsupported → omit, keep diagnosing
  }

  // Bot STATUS COMMENTS (SonarCloud Quality-Gate / Vercel-Netlify deployment /
  // Codecov coverage) — plain PR issue comments, NOT review threads. The FALLBACK
  // for bots that only comment; guarded so an unreadable comment feed never sinks
  // the payload.
  let issueComments = [];
  try {
    if (typeof adapter.readIssueComments === 'function') {
      issueComments = await adapter.readIssueComments({ owner, repo, pr, cwd });
    }
  } catch (_err) {
    void _err; // unreadable issue comments → skip the scanner, keep diagnosing
  }
  const botStatusBlockers = buildBotStatusBlockers(issueComments, { cap: maxThreads });

  // Required-vs-produced classification (missing / skipped / pending / failing) —
  // the reliable explanation for an all-green-but-BLOCKED PR.
  const requiredChecks = classifyRequiredChecks(state.checks, requiredSet);
  const pendingChecks = pendingCheckNames(state.checks, maxThreads);

  const blockers = computeBlockers({
    mergeable: state.mergeable,
    mergeStateStatus: state.mergeStateStatus,
    draft: state.isDraft || state.draft || false,
    reviewDecision: state.reviewDecision || null,
    requiredClass: requiredChecks,
    botStatusBlockers,
    unresolvedThreadCount: reviewThreads.length,
    behind,
    conflicts,
    failuresCount: failures.length,
  });

  const summary = summarize({
    state: pass.state,
    failureCount: failures.length,
    threadCount: reviewThreads.length,
    blockers,
  });

  return buildPullPayload({
    pr,
    state: pass.state,
    reason: pass.reason,
    summary,
    mergeable: state.mergeable || 'UNKNOWN',
    mergeStateStatus: state.mergeStateStatus || 'UNKNOWN',
    draft: state.isDraft || state.draft || false,
    reviewDecision: state.reviewDecision || null,
    blockers,
    requiredChecks,
    pendingChecks,
    behind,
    conflicts,
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
  classifyRequiredChecks,
  pendingCheckNames,
  computeBlockers,
  renderPullSummary,
  buildPullPayload,
  isSkipped,
  isPending,
  buildBotStatusBlockers,
  botFailureSummary,
  REVIEW_BOT_LOGINS,
  AUTOMATION_BOT_LOGINS,
  STATUS_BOT_LOGINS,
};
