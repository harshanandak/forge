'use strict';

/**
 * PR-monitor sticky-comment renderer — turn ONE read-only `gatherPrBundle`
 * result (lib/pr-bundle.js) into the Markdown body of the single sticky PR
 * comment the pr-monitor GitHub workflow keeps up to date.
 *
 * This is the SURFACE half of the monitor: it leads with the one-line actionable
 * verdict (mirroring the `pr-verdict:*` label the workflow lands), then lists the
 * unresolved review threads (grouped by author, ANY author) plus the failing and
 * pending checks so async review-bot / human feedback in a window nobody is
 * watching cannot rot. The verdict LABELS state (check-failed / threads-open /
 * mergeable / …); it is NOT a merge action — it never merges, never resolves
 * threads, never blocks, and is fail-closed (`unknown` on unreadable signals).
 *
 * Pure and deterministic: same bundle + same injected clock → same body, which
 * is what lets the workflow rewrite the sticky comment in place without churn.
 *
 * @module pr-monitor/render-sticky
 */

/**
 * Presentation-only headline for each canonical merge verdict (lib/pr-pull.js).
 * The verdict VALUE is computed once by pr-pull (`forge shepherd --pull --json`)
 * and passed in — this map only decides how to DISPLAY it, so there is no second
 * verdict ladder to drift.
 */
const VERDICT_HEADLINE = {
  UNKNOWN: '⚪ **Verdict: `unknown`** — a signal was unreadable; state unconfirmed (fail-closed).',
  'BLOCKED-CONFLICT': '🔀 **Verdict: `blocked-conflict`** — branch conflicts with base; rebase/merge and resolve.',
  BEHIND: '⬇️ **Verdict: `behind`** — branch is behind base; update/rebase (protection requires up-to-date).',
  'BLOCKED-CHECKS': '🔴 **Verdict: `blocked-checks`** — a required check is failing/missing; fix it.',
  'BLOCKED-THREADS': '🟠 **Verdict: `blocked-threads`** — unresolved review threads need addressing.',
  'REVIEW-PENDING': '🟡 **Verdict: `review-pending`** — awaiting review / settle window; not ready yet.',
  'CLEAN-MERGEABLE': '🟢 **Verdict: `clean-mergeable`** — green + zero unresolved threads; ready for a human to merge.',
};

/**
 * Render the one-line verdict headline for a canonical verdict string. Unknown or
 * missing input falls closed to the `unknown` headline.
 *
 * @param {string} verdict
 * @returns {string}
 */
function verdictHeadline(verdict) {
  return VERDICT_HEADLINE[String(verdict || '').toUpperCase()] || VERDICT_HEADLINE.UNKNOWN;
}

/** Hidden HTML marker: the workflow finds its prior comment by this string and
 * UPDATES it in place, so the monitor never spams a PR with new comments. */
const STICKY_MARKER = '<!-- forge-pr-monitor -->';

/** Cap threads listed per author so a noisy PR can't produce an enormous body. */
const MAX_THREADS_PER_AUTHOR = 8;

/** Group unresolved review-thread comments by author → ordered [author, threads]. */
function groupByAuthor(comments) {
  const byAuthor = new Map();
  for (const c of (Array.isArray(comments) ? comments : [])) {
    const author = String(c.author || 'unknown');
    if (!byAuthor.has(author)) byAuthor.set(author, []);
    byAuthor.get(author).push(c);
  }
  // Sort authors by descending thread count, then name — stable + deterministic.
  return [...byAuthor.entries()].sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]));
}

/** One-line locator for a thread: `path:line` when known, else the threadId. */
function threadLocator(t) {
  if (t.path) return t.line != null ? `${t.path}:${t.line}` : t.path;
  return t.threadId || '(thread)';
}

/** Render the unresolved-review-threads section (author-agnostic + fail-closed). */
function renderThreads(bundle, lines) {
  // Fail-closed: if the thread read was not available for ANY reason — it threw
  // (error set) OR the adapter cannot read comments at all (capability absent,
  // error null) — NEVER render "zero / clean". Only a genuine available:true read
  // may report "no unresolved threads". Guard on `!== true` (not `=== false`) so a
  // producer that omits the flag is also treated as unread, never as clean.
  if (bundle.unresolvedCommentsAvailable !== true) {
    const why = bundle.unresolvedCommentsError || 'thread read unavailable (capability absent)';
    lines.push('### Review threads');
    lines.push(`⚠️ Review threads were **unreadable** this pass (\`${why}\`) — not treated as zero. Re-run once the read recovers.`);
    lines.push('');
    return;
  }

  const comments = Array.isArray(bundle.unresolvedComments) ? bundle.unresolvedComments : [];
  if (comments.length === 0) {
    lines.push('### Review threads');
    lines.push('✅ No unresolved review threads.');
    lines.push('');
    return;
  }

  const groups = groupByAuthor(comments);
  lines.push(`### Unresolved review threads (${comments.length})`);
  lines.push('');
  for (const [author, threads] of groups) {
    lines.push(`- **${author}** — ${threads.length}`);
    for (const t of threads.slice(0, MAX_THREADS_PER_AUTHOR)) {
      lines.push(`  - \`${threadLocator(t)}\``);
    }
    if (threads.length > MAX_THREADS_PER_AUTHOR) {
      lines.push(`  - …and ${threads.length - MAX_THREADS_PER_AUTHOR} more`);
    }
  }
  lines.push('');
}

/** Render the failing / pending check sections (author-agnostic + fail-closed). */
function renderChecks(bundle, lines) {
  // Fail-closed, mirroring renderThreads: empty ci arrays are AMBIGUOUS — they
  // mean either "read, genuinely all-clear" or "never read (gather outage)". Only
  // an explicit ciAvailable === true lets us render the summary; anything else
  // ("!== true": false or missing) surfaces as unreadable, so the monitor never
  // prints a false "no failing checks" for CI it did not actually read.
  if (bundle.ciAvailable !== true) {
    lines.push('### Checks');
    lines.push('⚠️ Checks were **unreadable** this pass — not treated as green. Re-run once the read recovers.');
    lines.push('');
    return;
  }

  const ci = bundle.ci || {};
  const failing = Array.isArray(ci.failing) ? ci.failing : [];
  const pending = Array.isArray(ci.pending) ? ci.pending : [];

  lines.push('### Checks');
  if (failing.length === 0 && pending.length === 0) {
    lines.push('✅ No failing or pending checks.');
  } else {
    if (failing.length > 0) {
      lines.push(`- ❌ **Failing (${failing.length}):** ${failing.map((c) => `\`${c.name || '?'}\``).join(', ')}`);
    }
    if (pending.length > 0) {
      lines.push(`- ⏳ **Pending (${pending.length}):** ${pending.map((c) => `\`${c.name || '?'}\``).join(', ')}`);
    }
  }
  lines.push('');
}

/**
 * Render the sticky monitor comment for a PR-state bundle.
 *
 * @param {object} bundle - a `gatherPrBundle` result (lib/pr-bundle.js).
 * @param {object} [opts]
 * @param {Date}   [opts.now] - injected clock for deterministic output.
 * @returns {{ marker: string, body: string }}
 */
function renderStickyComment(bundle = {}, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const lines = [];

  // The marker MUST be the very first bytes so the workflow's substring match
  // finds the prior comment regardless of any rendering below it.
  lines.push(STICKY_MARKER);
  lines.push('## 🔭 Forge PR Monitor');
  lines.push('');
  // Lead with the actionable verdict — the SAME value as the pr-verdict:* label
  // and `forge shepherd --pull --json` (passed in via opts.verdict, computed once
  // by pr-pull). Surface only: it labels state; this monitor **does not merge**
  // and never resolves review threads.
  lines.push(verdictHeadline(opts.verdict));
  lines.push('');
  lines.push('_Surfaces open review + check state so async feedback never rots. This monitor **does not merge** and never resolves review threads — a human merges in the GitHub UI._');
  lines.push('');

  renderThreads(bundle, lines);
  renderChecks(bundle, lines);

  const branch = bundle.branch || {};
  if ((branch.behind || 0) > 0) {
    lines.push(`> Branch is **${branch.behind}** commit(s) behind base.`);
    lines.push('');
  }

  lines.push('---');
  lines.push(`<sub>Updated ${now.toISOString()} · surface-only monitor · labels state, never merges, never resolves threads.</sub>`);

  return { marker: STICKY_MARKER, body: lines.join('\n') };
}

module.exports = {
  renderStickyComment,
  verdictHeadline,
  groupByAuthor,
  threadLocator,
  STICKY_MARKER,
  MAX_THREADS_PER_AUTHOR,
};
