'use strict';

const { normalizeEvidenceText } = require('../review-adapter');

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
  INCOMPLETE: '⚪ **Verdict: `INCOMPLETE`** — bounded review/check evidence is incomplete; merge readiness blocked (fail-closed).',
  UNKNOWN: '⚪ **Verdict: `unknown`** — a signal was unreadable; state unconfirmed (fail-closed).',
  'BLOCKED-CONFLICT': '🔀 **Verdict: `blocked-conflict`** — branch conflicts with base; rebase/merge and resolve.',
  BEHIND: '⬇️ **Verdict: `behind`** — branch is behind base; update/rebase (protection requires up-to-date).',
  'BLOCKED-CHECKS': '🔴 **Verdict: `blocked-checks`** — a required check is failing/missing; fix it.',
  'BLOCKED-THREADS': '🟠 **Verdict: `blocked-threads`** — unresolved review threads need addressing.',
  'REVIEW-PENDING': '🟡 **Verdict: `review-pending`** — awaiting review / settle window; not ready yet.',
  'CLEAN-MERGEABLE': '🟢 **Verdict: `clean-mergeable`** — green + zero unresolved threads; ready for a human to merge.',
};

const MAX_SUMMARY_THREADS = 64;
const MAX_SUMMARY_CHECKS = 20;
const MAX_SUMMARY_AUTHORS = 12;
const MAX_SUMMARY_TEXT_CHARS = 256;
const MAX_SUMMARY_SIGNALS = 16;
const MAX_SUMMARY_CHARS = 32768;

/** Render the one-line headline for a canonical verdict, failing closed. */
function verdictHeadline(verdict) {
  return VERDICT_HEADLINE[String(verdict || '').toUpperCase()] || VERDICT_HEADLINE.UNKNOWN;
}

/**
 * Render untrusted text as a Markdown code span without allowing its backticks
 * or line breaks to change the surrounding summary structure.
 *
 * CommonMark permits a code span to use more than one backtick. Pick a fence
 * longer than every run in the value, and flatten CR/LF so the summary stays
 * one line per diagnostic.
 */
function mdCode(value) {
  const text = normalizeEvidenceText(value, { maxChars: MAX_SUMMARY_TEXT_CHARS });
  let longestRun = 0;
  let currentRun = 0;
  for (const character of text) {
    if (character === '`') {
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 0;
    }
  }
  const fence = '`'.repeat(longestRun + 1);
  const content = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${fence}${content}${fence}`;
}

/** Cap threads listed per author so a noisy PR cannot produce an enormous summary. */
const MAX_THREADS_PER_AUTHOR = 8;

/** Group unresolved review-thread comments by author in deterministic order. */
function groupByAuthor(comments) {
  const byAuthor = new Map();
  for (const comment of (Array.isArray(comments) ? comments : [])) {
    const author = normalizeEvidenceText(comment.author || 'unknown', { maxChars: MAX_SUMMARY_TEXT_CHARS });
    if (!byAuthor.has(author)) byAuthor.set(author, []);
    byAuthor.get(author).push(comment);
  }
  return [...byAuthor.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    return 0;
  });
}

/** One-line locator for a thread: `path:line` when known, else its id. */
function threadLocator(thread) {
  if (thread.path) {
    const path = normalizeEvidenceText(thread.path, { maxChars: MAX_SUMMARY_TEXT_CHARS });
    return thread.line != null ? `${path}:${thread.line}` : path;
  }
  return normalizeEvidenceText(thread.threadId || '(thread)', { maxChars: MAX_SUMMARY_TEXT_CHARS });
}

function validThread(thread) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)
    || typeof thread.author !== 'string' || !thread.author.trim()) return false;
  const hasPath = typeof thread.path === 'string' && thread.path.trim();
  const hasId = typeof thread.threadId === 'string' && thread.threadId.trim();
  return Boolean(hasPath || hasId);
}

function validCheck(check) {
  return Boolean(check && typeof check === 'object' && !Array.isArray(check)
    && typeof check.name === 'string' && check.name.trim());
}

/** Render unresolved review threads, preserving fail-closed availability. */
function renderThreads(bundle, lines) {
  // Empty arrays are ambiguous when the adapter could not read comments. Only
  // an explicit available:true read may report zero unresolved threads.
  if (bundle.unresolvedCommentsAvailable !== true) {
    const why = bundle.unresolvedCommentsError || 'thread read unavailable (capability absent)';
    lines.push('### Review threads');
    lines.push(`⚠️ Review threads were **unreadable** this pass (${mdCode(why)}) — not treated as zero. Re-run once the read recovers.`);
    lines.push('');
    return 'INCOMPLETE';
  }

  if (!Array.isArray(bundle.unresolvedComments)
    || bundle.unresolvedComments.slice(0, MAX_SUMMARY_THREADS + 1).some((thread) => !validThread(thread))) {
    lines.push(
      '### Review threads',
      '⚠️ Review thread evidence was **malformed** this pass — not treated as zero.',
      ''
    );
    return 'INCOMPLETE';
  }

  const comments = bundle.unresolvedComments;
  const incomplete = comments.length > MAX_SUMMARY_THREADS;
  if (comments.length === 0) {
    lines.push('### Review threads');
    lines.push('✅ No unresolved review threads.');
    lines.push('');
    return 'ZERO';
  }

  const boundedComments = comments.slice(0, MAX_SUMMARY_THREADS);
  const groups = groupByAuthor(boundedComments).slice(0, MAX_SUMMARY_AUTHORS);
  lines.push(`### Unresolved review threads (${comments.length})`);
  lines.push('');
  for (const [author, threads] of groups) {
    lines.push(`- **${mdCode(author)}** — ${threads.length}`);
    for (const thread of threads.slice(0, MAX_THREADS_PER_AUTHOR)) {
      lines.push(`  - ${mdCode(threadLocator(thread))}`);
    }
    if (threads.length > MAX_THREADS_PER_AUTHOR) {
      lines.push(`  - …and ${threads.length - MAX_THREADS_PER_AUTHOR} more`);
    }
  }
  if (comments.length > boundedComments.length) {
    lines.push(`- …and ${comments.length - boundedComments.length} more thread(s) omitted by the bounded summary`);
  }
  const representedThreads = groups.reduce((total, [, threads]) => total + threads.length, 0);
  if (representedThreads < boundedComments.length) {
    lines.push(`- …and ${boundedComments.length - representedThreads} thread(s) from additional authors`);
  }
  lines.push('');
  return incomplete ? 'INCOMPLETE' : 'OPEN';
}

/** Render failing and pending checks, preserving fail-closed availability. */
function renderChecks(bundle, lines) {
  // Only ciAvailable:true permits a clean-check claim. Missing or false means
  // the read did not complete, so empty arrays must not look green.
  if (bundle.ciAvailable !== true) {
    lines.push('### Checks');
    lines.push('⚠️ Checks were **unreadable** this pass — not treated as green. Re-run once the read recovers.');
    lines.push('');
    return false;
  }

  const ci = bundle.ci || {};
  const checkArrays = [ci.checks, ci.failing, ci.pending];
  if (checkArrays.some((checks) => !Array.isArray(checks))
    || checkArrays.some((checks) => checks.slice(0, MAX_SUMMARY_CHECKS + 1)
      .some((check) => !validCheck(check)))) {
    lines.push(
      '### Checks',
      '⚠️ Check evidence was **malformed** this pass — not treated as green.',
      ''
    );
    return false;
  }
  const failing = ci.failing;
  const pending = ci.pending;
  const incomplete = checkArrays.some((checks) => checks.length > MAX_SUMMARY_CHECKS);
  lines.push('### Checks');
  if (failing.length === 0 && pending.length === 0) {
    lines.push('✅ No failing or pending checks.');
  } else {
    if (failing.length > 0) {
      lines.push(`- ❌ **Failing (${failing.length}):** ${failing.slice(0, MAX_SUMMARY_CHECKS).map((check) => mdCode(check.name || '?')).join(', ')}`);
      if (failing.length > MAX_SUMMARY_CHECKS) {
        lines.push(`  - …and ${failing.length - MAX_SUMMARY_CHECKS} more failing check(s)`);
      }
    }
    if (pending.length > 0) {
      lines.push(`- ⏳ **Pending (${pending.length}):** ${pending.slice(0, MAX_SUMMARY_CHECKS).map((check) => mdCode(check.name || '?')).join(', ')}`);
      if (pending.length > MAX_SUMMARY_CHECKS) {
        lines.push(`  - …and ${pending.length - MAX_SUMMARY_CHECKS} more pending check(s)`);
      }
    }
  }
  lines.push('');
  return !incomplete;
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
  const unreadable = Array.isArray(opts.unreadable)
    ? opts.unreadable.filter(Boolean).slice(0, MAX_SUMMARY_SIGNALS)
    : [];

  const headlineIndex = lines.length;
  lines.push(verdictHeadline(opts.verdict));
  if (isUnknown && unreadable.length > 0) {
    lines.push('');
    lines.push(`> Unreadable signal(s): ${unreadable.map((signal) => mdCode(signal)).join(', ')}.`);
  }
  lines.push('');
  lines.push('_Surfaces open review + check state so async feedback never rots. This monitor **does not merge** and never resolves review threads — a human merges in the GitHub UI._');
  lines.push('');

  let threadState = renderThreads(bundle, lines);
  const checksComplete = renderChecks(bundle, lines);

  const branch = bundle.branch || {};
  if ((branch.behind || 0) > 0) {
    lines.push(`> Branch is **${branch.behind}** commit(s) behind base.`);
    lines.push('');
  }

  const pr = opts.pr || bundle.pr || '<pr>';
  const detailCommand = mdCode(`forge shepherd ${pr} --pull --json`);
  lines.push(
    '---',
    `Detailed JSON: ${detailCommand}`,
    `_Updated ${now.toISOString()} · summary-only monitor · labels state, never merges, never resolves threads._`
  );

  let evidenceStatus = threadState === 'INCOMPLETE' || !checksComplete ? 'INCOMPLETE' : 'COMPLETE';
  if (evidenceStatus === 'INCOMPLETE') lines[headlineIndex] = verdictHeadline('INCOMPLETE');
  let body = lines.join('\n');
  if (body.length > MAX_SUMMARY_CHARS) {
    threadState = 'INCOMPLETE';
    evidenceStatus = 'INCOMPLETE';
    body = [
      '## 🔭 Forge PR Monitor',
      '',
      verdictHeadline('INCOMPLETE'),
      '',
      '⚠️ Summary evidence exceeded the bounded rendering limit; inspect the detailed JSON.',
      '',
      '_This monitor does not merge and never resolves review threads._',
      '',
      `Detailed JSON: ${detailCommand}`,
      `_Updated ${now.toISOString()} · summary-only monitor · labels state, never merges, never resolves threads._`,
    ].join('\n');
  }

  return { body, evidenceStatus, threadState };
}

module.exports = {
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_CHECKS,
  MAX_SUMMARY_THREADS,
  renderSummary,
  verdictHeadline,
  groupByAuthor,
  threadLocator,
  MAX_THREADS_PER_AUTHOR,
};
