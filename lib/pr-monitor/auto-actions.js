'use strict';

/**
 * PR-monitor Tier-2 auto-actions — the SAFE, fail-closed *action* half of the
 * shepherd (issue addf5297, epic c2d398e5). Tier-1 (lib/pr-pull.js computeVerdict
 * + the pr-monitor workflow) LABELS a PR's state but takes no action, so PRs that
 * only need "master merged in" sit untended until a human/agent nudges them.
 *
 * This module decides — PURELY, from the SAME `forge shepherd <pr> --pull --json`
 * payload the monitor already computes — whether the monitor may take one of two
 * surface-safe actions:
 *   1. `updateBranch` — merge base into an OTHERWISE-CLEAN-but-BEHIND PR (the
 *      "last mile" case). This is the highest-value, safest action: it clears the
 *      BEHIND churn without ever touching a PR that has a real blocker.
 *   2. `rerunFlaky`   — re-run a required check whose failure is INFRASTRUCTURAL
 *      (cancelled / timed-out / stale / startup-failure), never a real test
 *      FAILURE/ERROR.
 *
 * It NEVER merges, NEVER resolves review threads, NEVER force-pushes, NEVER edits
 * code. It only decides; the workflow executes the `gh` calls (and owns
 * per-head-SHA idempotency markers). Every gate below is fail-CLOSED: any missing
 * field, degraded read, real failure, fork, draft, or unclassifiable signal
 * yields `should:false`.
 *
 * @module pr-monitor/auto-actions
 */

/**
 * Check conclusions that are INFRASTRUCTURAL flakes — a re-run may legitimately
 * turn them green. Mirrors lib/pr-shepherd.js `isFailed`'s not-green terminal
 * conclusions MINUS the genuinely-broken ones (FAILURE/ERROR/ACTION_REQUIRED).
 */
const INFRA_CONCLUSIONS = new Set(['CANCELLED', 'TIMED_OUT', 'STALE', 'STARTUP_FAILURE']);

/** Conclusions that mean the code is genuinely broken — NEVER auto-rerun these. */
const REAL_FAILURE_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'ACTION_REQUIRED']);

const AUTO_ACTION_STATUS = Object.freeze({
  PASS: 'PASS',
  UNCHANGED: 'UNCHANGED',
  STALE: 'STALE',
  INCOMPLETE: 'INCOMPLETE',
  CONFLICT: 'CONFLICT',
});

const MAX_AUTO_ACTIONS = 8;
const MAX_AUTO_ATTEMPTS = 5;

/**
 * Pull the numeric Actions run id from a job/run "details" URL
 * (`.../actions/runs/<run>/job/<job>` or `.../actions/runs/<run>`). Returns null
 * when absent — a null run id fails the rerun decision closed.
 *
 * @param {string} url
 * @returns {string | null}
 */
function runIdFromUrl(url) {
  const m = String(url || '').match(/\/runs\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * A payload is DEGRADED (some verdict-relevant read failed or the head moved
 * mid-gather) when its evidence lists unreadable sources or a torn read. Acting
 * on a degraded gather could act on stale/false state, so both actions fail
 * closed on it — even though `verdict==='BEHIND'` already implies a clean read,
 * this stays an explicit, independent guard.
 *
 * @param {object} payload
 * @returns {boolean}
 */
function isDegraded(payload) {
  const ev = (payload && payload.evidence) || {};
  const unreadable = Array.isArray(ev.unreadable) ? ev.unreadable : [];
  return unreadable.length > 0 || ev.tornRead === true;
}

/**
 * Decide whether to auto-update (merge base into) an otherwise-clean-but-BEHIND
 * PR. Fires ONLY for the "last mile" case:
 *   - verdict is exactly `BEHIND` (which itself guarantees rank-1 UNKNOWN and
 *     rank-2 BLOCKED-CONFLICT did NOT fire — i.e. the read was clean and there is
 *     no conflict);
 *   - the PR is NOT a draft and NOT a fork (a base-repo token cannot push a fork
 *     branch, and forks are out of scope);
 *   - the read is not degraded;
 *   - and the ONLY blocker is the behind-base one — every other blocker type
 *     (failing/missing/skipped/pending required checks, bot-status gates,
 *     unresolved threads, changes-requested / review-required, conflict) is
 *     absent. `blockers[]` is computed independently of the verdict precedence,
 *     so it still lists lower-precedence blockers that `BEHIND` masks — which is
 *     exactly why we key on it rather than on the single verdict string.
 *
 * @param {object} payload - the `--pull --json` payload.
 * @param {{ isFork?: boolean }} [opts]
 * @returns {{ should: boolean, reason: string }}
 */
function decideUpdateBranch(payload, opts = {}) {
  const skip = (reason) => ({ should: false, reason });
  if (!payload || typeof payload !== 'object') return skip('no payload — fail closed');
  if (opts.isFork) return skip('fork PR — a base-repo token cannot update a fork branch');
  if (isDegraded(payload)) return skip('degraded/torn read — fail closed');
  if (payload.verdict !== 'BEHIND') return skip(`verdict ${payload.verdict || 'UNKNOWN'} is not BEHIND`);
  if (payload.draft === true) return skip('draft PR — not ready to advance');
  if (!Array.isArray(payload.blockers)) return skip('blockers[] unavailable — fail closed');
  const others = payload.blockers.filter((b) => b && b.type !== 'behind');
  if (others.length > 0) {
    return skip(`other blocker(s) present: ${others.map((b) => b.type).join(', ')}`);
  }
  return { should: true, reason: 'otherwise-clean-behind — only blocker is behind-base; merge base in' };
}

function indexFailures(failures) {
  const byName = new Map();
  for (const failure of failures) {
    if (!failure?.name || byName.has(failure.name)) continue;
    byName.set(failure.name, {
      conclusion: String(failure.conclusion || '').toUpperCase(),
      url: failure.jobUrl || failure.detailsUrl || null,
    });
  }
  return byName;
}

function selectRerunChecks(failingNames, failuresByName) {
  const checks = [];
  for (const name of failingNames) {
    const failure = failuresByName.get(name);
    if (!failure?.conclusion) {
      return { reason: `required check "${name}" has no known conclusion — cannot confirm flaky, fail closed` };
    }
    if (REAL_FAILURE_CONCLUSIONS.has(failure.conclusion)) {
      return { reason: `required check "${name}" is a real failure (${failure.conclusion}) — never rerun` };
    }
    if (!INFRA_CONCLUSIONS.has(failure.conclusion)) {
      return { reason: `required check "${name}" conclusion ${failure.conclusion} is not classified infrastructural — fail closed` };
    }
    checks.push({ name, conclusion: failure.conclusion, runId: runIdFromUrl(failure.url) });
  }
  return { checks };
}

/**
 * Decide whether to re-run flaky REQUIRED checks. Fires ONLY when EVERY failing
 * required check is infrastructural with a derivable run id, and NONE is a real
 * failure or an unclassifiable signal.
 */
function decideRerun(payload) {
  const empty = (reason) => ({ should: false, checks: [], runIds: [], reason });
  if (!payload || typeof payload !== 'object') return empty('no payload — fail closed');
  if (isDegraded(payload)) return empty('degraded/torn read — fail closed');

  const rc = payload.requiredChecks || {};
  const failingNames = Array.isArray(rc.failing) ? rc.failing : [];
  if (failingNames.length === 0) return empty('no failing required checks');

  const selection = selectRerunChecks(
    failingNames,
    indexFailures(Array.isArray(payload.failures) ? payload.failures : []),
  );
  if (selection.reason) return empty(selection.reason);

  const picked = selection.checks;
  const runIds = [...new Set(picked.map((p) => p.runId).filter(Boolean))];
  if (picked.some((item) => !item.runId)) return empty('no run id derivable from failure jobUrl — fail closed');
  return {
    should: true,
    checks: picked,
    runIds,
    reason: `all ${picked.length} failing required check(s) are infrastructural (${picked.map((p) => p.conclusion).join(', ')})`,
  };
}

/**
 * Compute the full auto-action decision from a `--pull --json` payload. Pure and
 * independently testable — no I/O, no `gh`, no side effects.
 *
 * @param {object} payload
 * @param {{ isFork?: boolean }} [opts]
 * @returns {{ updateBranch: object, rerunFlaky: object }}
 */
function decideAutoActions(payload, opts = {}) {
  return {
    updateBranch: decideUpdateBranch(payload, opts),
    rerunFlaky: decideRerun(payload),
  };
}

function boundedPolicyValue(value, fallback, maximum) {
  const selected = value ?? fallback;
  return Number.isSafeInteger(selected) && selected > 0 && selected <= maximum ? selected : null;
}

function normalizeActionHistory(history) {
  if (!Array.isArray(history)) return { ok: false, reason: 'action history is incomplete' };
  const byKey = new Map();
  for (const item of history) {
    if (!item || typeof item.key !== 'string' || !item.key
      || !['pending', 'applied', 'failed'].includes(item.state)
      || !Number.isSafeInteger(item.attempts) || item.attempts < 0) {
      return { ok: false, reason: 'action history is incomplete' };
    }
    const prior = byKey.get(item.key);
    if (prior && (prior.state !== item.state || prior.attempts !== item.attempts)) {
      return { ok: false, conflict: true, reason: `action history conflicts for ${item.key}` };
    }
    if (!prior) byKey.set(item.key, item);
  }
  return { ok: true, byKey };
}

function validateAutoActionAuthority(payload) {
  if (!payload?.evidence || !Array.isArray(payload.evidence.unreadable)
    || typeof payload.evidence.tornRead !== 'boolean') {
    return { ok: false, reason: 'verdict evidence is incomplete' };
  }
  if (payload.draft !== false) {
    return { ok: false, reason: 'non-draft authority is incomplete' };
  }

  const failuresByName = new Map();
  for (const failure of Array.isArray(payload.failures) ? payload.failures : []) {
    if (!failure || typeof failure.name !== 'string' || !failure.name) continue;
    const evidence = {
      conclusion: String(failure.conclusion || '').toUpperCase(),
      url: failure.jobUrl || failure.detailsUrl || null,
    };
    const prior = failuresByName.get(failure.name);
    if (prior && (prior.conclusion !== evidence.conclusion || prior.url !== evidence.url)) {
      return { ok: false, conflict: true, reason: `required check evidence conflicts for ${failure.name}` };
    }
    if (!prior) failuresByName.set(failure.name, evidence);
  }
  return { ok: true };
}

function buildAutoActionCandidates(decision, subjectRevision) {
  const candidates = [];
  if (decision.updateBranch.should) {
    candidates.push({ type: 'updateBranch', key: `updateBranch:${subjectRevision}`, subjectRevision });
  }
  if (decision.rerunFlaky.should) {
    const runIds = [...decision.rerunFlaky.runIds].sort((left, right) => left.localeCompare(right));
    for (const runId of runIds) {
      candidates.push({
        type: 'rerunFlaky',
        key: `rerunFlaky:${subjectRevision}:${runId}`,
        subjectRevision,
        runId,
      });
    }
  }
  return candidates;
}

function selectBoundedActions(candidates, history, maxActions, maxAttempts) {
  const actions = [];
  for (const candidate of candidates) {
    const prior = history.get(candidate.key);
    if (prior && (prior.state === 'pending' || prior.state === 'applied' || prior.attempts >= maxAttempts)) continue;
    actions.push({ ...candidate, attempt: prior ? prior.attempts + 1 : 1 });
    if (actions.length === maxActions) break;
  }
  return actions;
}

/** Select a deterministic, per-head, bounded action/retry batch. */
function decideBoundedAutoActions(payload, opts = {}) {
  const closed = (status, reason) => ({ status, reason, actions: [] });
  const subjectRevision = payload?.headSha;
  if (typeof subjectRevision !== 'string' || !/^[0-9a-f]{40}$/i.test(subjectRevision)) {
    return closed(AUTO_ACTION_STATUS.INCOMPLETE, 'exact head authority is incomplete');
  }
  if (opts.expectedRevision != null && opts.expectedRevision !== subjectRevision) {
    return closed(AUTO_ACTION_STATUS.STALE, 'payload head does not match expected revision');
  }
  const authority = validateAutoActionAuthority(payload);
  if (!authority.ok) {
    return closed(authority.conflict ? AUTO_ACTION_STATUS.CONFLICT : AUTO_ACTION_STATUS.INCOMPLETE, authority.reason);
  }
  const maxActions = boundedPolicyValue(opts.maxActions, 1, MAX_AUTO_ACTIONS);
  const maxAttempts = boundedPolicyValue(opts.maxAttempts, 2, MAX_AUTO_ATTEMPTS);
  if (maxActions == null || maxAttempts == null) {
    return closed(AUTO_ACTION_STATUS.INCOMPLETE, 'auto-action policy exceeds bounded limits');
  }
  const history = normalizeActionHistory(opts.history || []);
  if (!history.ok) {
    return closed(history.conflict ? AUTO_ACTION_STATUS.CONFLICT : AUTO_ACTION_STATUS.INCOMPLETE, history.reason);
  }

  const decision = decideAutoActions(payload, opts);
  if (decision.updateBranch.should && decision.rerunFlaky.should) {
    return closed(AUTO_ACTION_STATUS.CONFLICT, 'payload authorizes conflicting update and rerun actions');
  }

  const candidates = buildAutoActionCandidates(decision, subjectRevision);
  const actions = selectBoundedActions(candidates, history.byKey, maxActions, maxAttempts);
  if (actions.length === 0) {
    return closed(AUTO_ACTION_STATUS.UNCHANGED, candidates.length === 0
      ? 'no safe auto-action transition'
      : 'identical actions are pending, applied, or retry-exhausted');
  }
  return { status: AUTO_ACTION_STATUS.PASS, reason: 'bounded auto-actions selected', actions };
}

module.exports = {
  decideAutoActions,
  decideUpdateBranch,
  decideRerun,
  runIdFromUrl,
  isDegraded,
  INFRA_CONCLUSIONS,
  REAL_FAILURE_CONCLUSIONS,
  AUTO_ACTION_STATUS,
  decideBoundedAutoActions,
};
