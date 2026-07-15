'use strict';

/**
 * PR-monitor sticky-comment renderer — turn ONE read-only `gatherPrBundle`
 * result (lib/pr-bundle.js) into the Markdown body of the single sticky PR
 * comment the pr-monitor GitHub workflow keeps up to date.
 *
 * This is the SURFACE half of the monitor: it lists the unresolved review
 * threads (grouped by author, ANY author) plus the failing and pending checks
 * so async review-bot / human feedback in a window nobody is watching cannot
 * rot. It is deliberately NOT a merge decision — it never emits a pass/fail
 * verdict and never claims a PR is ready to merge. That belongs to the
 * trustworthy-shepherd redesign, not here.
 *
 * Pure and deterministic: same bundle + same injected clock → same body, which
 * is what lets the workflow rewrite the sticky comment in place without churn.
 *
 * @module pr-monitor/render-sticky
 */

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
  // Fail-closed: unreadable threads are NEVER rendered as "zero / clean".
  if (bundle.unresolvedCommentsAvailable === false && bundle.unresolvedCommentsError) {
    lines.push('### Review threads');
    lines.push(`⚠️ Review threads were **unreadable** this pass (\`${bundle.unresolvedCommentsError}\`) — not treated as zero. Re-run once the read recovers.`);
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

/** Render the failing / pending check sections. */
function renderChecks(bundle, lines) {
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
  lines.push('_Surfaces open review + check state so async feedback never rots. This monitor **does not merge** and does not post a pass/fail verdict._');
  lines.push('');

  renderThreads(bundle, lines);
  renderChecks(bundle, lines);

  const branch = bundle.branch || {};
  if ((branch.behind || 0) > 0) {
    lines.push(`> Branch is **${branch.behind}** commit(s) behind base.`);
    lines.push('');
  }

  lines.push('---');
  lines.push(`<sub>Updated ${now.toISOString()} · surface-only monitor · never merges, never verdicts.</sub>`);

  return { marker: STICKY_MARKER, body: lines.join('\n') };
}

module.exports = {
  renderStickyComment,
  groupByAuthor,
  threadLocator,
  STICKY_MARKER,
  MAX_THREADS_PER_AUTHOR,
};
