'use strict';

/**
 * PR-monitor Actions-summary renderer. It turns one read-only
 * `gatherPrBundle` result (lib/pr-bundle.js) into deterministic Markdown for
 * the workflow's `GITHUB_STEP_SUMMARY` surface.
 *
 * This is presentation only: it displays the canonical verdict supplied by
 * `forge shepherd <pr> --pull --json`, lists unresolved review threads and CI
 * state, and never merges or resolves anything. The `pr-verdict:*` label is a
 * cheap visibility projection of that same verdict, not merge authority.
 *
 * @module pr-monitor/render-summary
 */

/**
 * Presentation-only headline for each canonical merge verdict (lib/pr-pull.js).
 * The verdict is computed once by pr-pull and passed in; this map only decides
 * how it is displayed, so there is no second verdict ladder to drift.
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

/** Render the one-line headline for a canonical verdict, failing closed. */
function verdictHeadline(verdict) {
  return VERDICT_HEADLINE[String(verdict || '').toUpperCase()] || VERDICT_HEADLINE.UNKNOWN;
}

/** Cap threads listed per author so a noisy PR cannot produce an enormous summary. */
const MAX_THREADS_PER_AUTHOR = 8;

/** Group unresolved review-thread comments by author in deterministic order. */
function groupByAuthor(comments) {
  const byAuthor = new Map();
  for (const comment of (Array.isArray(comments) ? comments : [])) {
    const author = String(comment.author || 'unknown');
    if (!byAuthor.has(author)) byAuthor.set(author, []);
    byAuthor.get(author).push(comment);
  }
  return [...byAuthor.entries()].sort(
    (a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]),
  );
}

/** One-line locator for a thread: `path:line` when known, else its id. */
function threadLocator(thread) {
  if (thread.path) return thread.line != null ? `${thread.path}:${thread.line}` : thread.path;
  return thread.threadId || '(thread)';
}

/** Render unresolved review threads, preserving fail-closed availability. */
function renderThreads(bundle, lines) {
  // Empty arrays are ambiguous when the adapter could not read comments. Only
  // an explicit available:true read may report zero unresolved threads.
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
    for (const thread of threads.slice(0, MAX_THREADS_PER_AUTHOR)) {
      lines.push(`  - \`${threadLocator(thread)}\``);
    }
    if (threads.length > MAX_THREADS_PER_AUTHOR) {
      lines.push(`  - …and ${threads.length - MAX_THREADS_PER_AUTHOR} more`);
    }
  }
  lines.push('');
}

/** Render failing and pending checks, preserving fail-closed availability. */
function renderChecks(bundle, lines) {
  // Only ciAvailable:true permits a clean-check claim. Missing or false means
  // the read did not complete, so empty arrays must not look green.
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
      lines.push(`- ❌ **Failing (${failing.length}):** ${failing.map((check) => `\`${check.name || '?'}\``).join(', ')}`);
    }
    if (pending.length > 0) {
      lines.push(`- ⏳ **Pending (${pending.length}):** ${pending.map((check) => `\`${check.name || '?'}\``).join(', ')}`);
    }
  }
  lines.push('');
}

/**
 * Render the PR monitor's Actions job summary.
 *
 * @param {object} bundle - a `gatherPrBundle` result (lib/pr-bundle.js)
 * @param {object} [opts]
 * @param {Date} [opts.now] - injected clock for deterministic output
 * @param {string} [opts.verdict] - canonical `--pull` verdict
 * @param {string[]} [opts.unreadable] - unreadable signal names from `--pull`
 * @param {string|number} [opts.pr] - PR number for the CLI diagnostics hint
 * @returns {{ body: string }}
 */
function renderSummary(bundle = {}, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const lines = ['## 🔭 Forge PR Monitor', ''];
  const verdict = String(opts.verdict || '').toUpperCase();
  const isUnknown = verdict === 'UNKNOWN' || !VERDICT_HEADLINE[verdict];
  const unreadable = Array.isArray(opts.unreadable) ? opts.unreadable.filter(Boolean) : [];

  lines.push(verdictHeadline(opts.verdict));
  if (isUnknown && unreadable.length > 0) {
    lines.push('');
    lines.push(`> Unreadable signal(s): ${unreadable.map((signal) => `\`${signal}\``).join(', ')}.`);
  }
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

  const pr = opts.pr || bundle.pr || '<pr>';
  lines.push('---');
  lines.push(`Detailed JSON: \`forge shepherd ${pr} --pull --json\``);
  lines.push(`_Updated ${now.toISOString()} · summary-only monitor · labels state, never merges, never resolves threads._`);

  return { body: lines.join('\n') };
}

module.exports = {
  renderSummary,
  verdictHeadline,
  groupByAuthor,
  threadLocator,
  MAX_THREADS_PER_AUTHOR,
};
