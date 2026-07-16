'use strict';

/**
 * PR verdict — the ACTIONABLE label layer over the read-only PR-state bundle
 * (lib/pr-bundle.js) that the pr-monitor workflow already gathers.
 *
 * The monitor's sticky comment surfaces open threads + checks as PROSE but posts
 * no verdict. `computeVerdict` distills the SAME bundle into ONE actionable
 * verdict so the workflow can also land a single `pr-verdict:*` LABEL — the cheap,
 * agent-agnostic read (`gh pr view <pr> --json labels`) that replaces polling gh
 * by hand.
 *
 * The vocabulary and PRIORITY deliberately mirror the canonical fail-closed merge
 * ladder in lib/pr-pull.js (`forge shepherd <pr> --pull --json`):
 *
 *   unknown > conflict > behind > check-failed > threads-open > pending > mergeable
 *
 * so this bundle-derived label never disagrees with the authoritative `--pull`
 * verdict. `--pull` remains the source of truth (it also reads reviewDecision,
 * head-oid freshness, and a settle window this bundle does not carry); this label
 * is the always-on, zero-extra-gather surface computed from what the monitor
 * already has in hand.
 *
 * HONEST + FAIL-CLOSED + SURFACE ONLY. It labels state; it NEVER merges, NEVER
 * resolves review threads, NEVER blocks. When CI or threads are UNREADABLE the
 * verdict is `unknown` and `mergeable` is never asserted — an unread signal is
 * never treated as "nothing wrong".
 *
 * @module pr-verdict
 */

/** Label prefix; exactly one `pr-verdict:*` label is kept on a PR at a time. */
const LABEL_PREFIX = 'pr-verdict:';

/** Every verdict, in priority order (first = most urgent), mirroring pr-pull. */
const VERDICTS = ['unknown', 'conflict', 'behind', 'check-failed', 'threads-open', 'pending', 'mergeable'];

/** The full reconcile set the workflow uses to strip stale verdict labels. */
const VERDICT_LABELS = VERDICTS.map((v) => `${LABEL_PREFIX}${v}`);

/**
 * Map a verdict string to its `pr-verdict:*` label.
 *
 * @param {string} verdict
 * @returns {string}
 */
function verdictLabel(verdict) {
  return `${LABEL_PREFIX}${verdict}`;
}

/**
 * Compute the actionable verdict for a PR-state bundle.
 *
 * Readability is fail-closed and mirrors render-sticky.js: a signal counts as
 * readable ONLY when its availability flag is exactly `true`. The pr-monitor
 * workflow stamps `ciAvailable:true` after a successful gather; a missing/false
 * flag is treated as unread, never as "all clear".
 *
 * @param {object} bundle - `forge shepherd <pr> --bundle --json` output (+ ciAvailable).
 * @returns {{
 *   pr: string, verdict: string, mergeable: boolean, check_failed: boolean,
 *   conflict: boolean, behind: number, threads_open: number, pending: boolean,
 *   ci_readable: boolean, threads_readable: boolean, failing_checks: string[],
 *   merge_state_status: string,
 * }}
 */
function computeVerdict(bundle) {
  const b = bundle || {};
  const ci = b.ci || {};
  const failing = Array.isArray(ci.failing) ? ci.failing : [];
  const pendingChecks = Array.isArray(ci.pending) ? ci.pending : [];
  const mergeState = b.mergeState || {};
  const mss = String(mergeState.mergeStateStatus || 'UNKNOWN').toUpperCase();
  const behind = Number(b.branch && b.branch.behind) || 0;

  const ciReadable = b.ciAvailable === true;
  const threadsReadable = b.unresolvedCommentsAvailable === true;
  const unresolved = Array.isArray(b.unresolvedComments) ? b.unresolvedComments : [];
  const threadsOpen = threadsReadable ? unresolved.length : 0;

  const failingChecks = failing.map((c) => String(c.name || '')).filter(Boolean);
  const checkFailed = ciReadable && failing.length > 0;
  const conflict = mss === 'DIRTY';
  const isBehind = mss === 'BEHIND' || behind > 0;
  const pending = ciReadable && pendingChecks.length > 0;

  // Priority mirrors the canonical --pull ladder. Unreadable outranks all: if we
  // could not read CI or threads we cannot trust any clean/blocked claim, so we
  // escalate to `unknown` rather than guess.
  let verdict;
  if (!ciReadable || !threadsReadable) {
    verdict = 'unknown';
  } else if (conflict) {
    verdict = 'conflict';
  } else if (isBehind) {
    verdict = 'behind';
  } else if (checkFailed) {
    verdict = 'check-failed';
  } else if (threadsOpen > 0) {
    verdict = 'threads-open';
  } else if (pending || mss !== 'CLEAN') {
    verdict = 'pending';
  } else {
    verdict = 'mergeable';
  }

  return {
    pr: String(b.pr || ''),
    verdict,
    mergeable: verdict === 'mergeable',
    check_failed: checkFailed,
    conflict,
    behind,
    threads_open: threadsOpen,
    pending,
    ci_readable: ciReadable,
    threads_readable: threadsReadable,
    failing_checks: failingChecks,
    merge_state_status: mss,
  };
}

/** Emoji per verdict for the one-line headline. */
const EMOJI = {
  unknown: '⚪',
  conflict: '🔀',
  behind: '⬇️',
  'check-failed': '🔴',
  'threads-open': '🟠',
  pending: '🟡',
  mergeable: '🟢',
};

/**
 * One-line human headline carrying the verdict — used as the sticky-comment
 * header and the workflow log line. Terse and specific.
 *
 * @param {object} v - a `computeVerdict` payload.
 * @returns {string}
 */
function verdictHeadline(v) {
  const p = v || {};
  const emoji = EMOJI[p.verdict] || EMOJI.unknown;
  let detail;
  switch (p.verdict) {
    case 'unknown': {
      const unread = [];
      if (!p.ci_readable) unread.push('CI');
      if (!p.threads_readable) unread.push('review threads');
      detail = `signal unreadable (${unread.join(' + ') || 'unknown'}) — cannot confirm state (fail-closed)`;
      break;
    }
    case 'conflict':
      detail = 'branch conflicts with base — rebase/merge base and resolve';
      break;
    case 'behind':
      detail = `branch is ${p.behind || 'N'} commit(s) behind base — update/rebase`;
      break;
    case 'check-failed':
      detail = `${p.failing_checks.length} failing check(s): ${p.failing_checks.join(', ')}`;
      break;
    case 'threads-open':
      detail = `${p.threads_open} unresolved review thread(s) to address`;
      break;
    case 'pending':
      detail = 'checks still running — not ready yet';
      break;
    case 'mergeable':
      detail = 'green + zero unresolved threads — ready for a human to merge';
      break;
    default:
      detail = '';
  }
  return `${emoji} **Verdict: \`${p.verdict}\`** — ${detail}`;
}

module.exports = {
  computeVerdict,
  verdictLabel,
  verdictHeadline,
  VERDICT_LABELS,
  VERDICTS,
};
