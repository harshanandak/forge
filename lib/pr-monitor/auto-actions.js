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

/**
 * Decide whether to re-run flaky REQUIRED checks. Fires ONLY when EVERY failing
 * required check is infrastructural (cancelled/timed-out/stale/startup-failure)
 * with a derivable run id, and NONE is a real FAILURE/ERROR/ACTION_REQUIRED. A
 * single real failure, an unclassifiable conclusion, a required-failing check
 * with no matching `failures[]` entry, or a missing run id fails the WHOLE
 * decision closed (never rerun a genuinely-broken PR, never loop on a real bug).
 *
 * @param {object} payload - the `--pull --json` payload.
 * @returns {{ should: boolean, checks: Array<{name:string,conclusion:string,runId:string|null}>, runIds: string[], reason: string }}
 */
function decideRerun(payload) {
  const empty = (reason) => ({ should: false, checks: [], runIds: [], reason });
  if (!payload || typeof payload !== 'object') return empty('no payload — fail closed');
  if (isDegraded(payload)) return empty('degraded/torn read — fail closed');

  const rc = payload.requiredChecks || {};
  const failingNames = Array.isArray(rc.failing) ? rc.failing : [];
  if (failingNames.length === 0) return empty('no failing required checks');

  const failures = Array.isArray(payload.failures) ? payload.failures : [];
  const conclByName = new Map();
  const urlByName = new Map();
  for (const f of failures) {
    if (!f || !f.name) continue;
    if (!conclByName.has(f.name)) {
      conclByName.set(f.name, String(f.conclusion || '').toUpperCase());
      urlByName.set(f.name, f.jobUrl || f.detailsUrl || null);
    }
  }

  const picked = [];
  for (const name of failingNames) {
    const concl = conclByName.get(name);
    if (!concl) return empty(`required check "${name}" has no known conclusion — cannot confirm flaky, fail closed`);
    if (REAL_FAILURE_CONCLUSIONS.has(concl)) return empty(`required check "${name}" is a real failure (${concl}) — never rerun`);
    if (!INFRA_CONCLUSIONS.has(concl)) return empty(`required check "${name}" conclusion ${concl} is not classified infrastructural — fail closed`);
    picked.push({ name, conclusion: concl, runId: runIdFromUrl(urlByName.get(name)) });
  }

  const runIds = [...new Set(picked.map((p) => p.runId).filter(Boolean))];
  if (runIds.length === 0) return empty('no run id derivable from failure jobUrl — fail closed');
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

module.exports = {
  decideAutoActions,
  decideUpdateBranch,
  decideRerun,
  runIdFromUrl,
  isDegraded,
  INFRA_CONCLUSIONS,
  REAL_FAILURE_CONCLUSIONS,
};
