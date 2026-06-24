'use strict';

/**
 * PR shepherd — one bounded pass of the monitor-driven state machine.
 *
 * Each `runShepherdPass` call is ONE discrete pass: read PR/CI state, decide a
 * single action, take at most the allowed Tier-A action, then return. It never
 * loops in-process and never sits waiting; an external scheduler re-invokes it.
 *
 * Invariants (enforced by tests):
 *   - NEVER merges. There is no merge action and no `--auto` latch — handoff to
 *     the human is the only way a PR merges.
 *   - NEVER resolves Greptile threads. It may post a status REPLY; resolution
 *     stays with the semantic `/review` agent.
 *   - Tier-A (autonomous): `rerun --failed` for flaky required checks (capped).
 *   - Tier-B (opt-in, default OFF): rebase + force-with-lease via `autoRebase`.
 *     Lease rejection is a HARD-STOP + escalate, never auto-retry.
 *   - Tier-C (escalate): conflicts, unknown/unreadable required set, persistent
 *     failures, auth-scope failures, oscillation, budget exhaustion.
 *   - Merge-ready is declared only when the required set is KNOWN and all of it
 *     is green and the branch is not behind.
 *   - Before any mutating action, HEAD SHA is re-read; if it moved since the
 *     pass started, the action is aborted (the real concurrency guard).
 *
 * State persists via GitHub PR comments/labels and git only.
 *
 * @module pr-shepherd
 */

const { classifyAuthError } = require('./adapters/pr-state-adapter');

/** Non-erroring terminal states a pass can settle into. */
const TERMINAL_STATES = ['MERGE_READY', 'ESCALATE', 'PENDING'];

const SUCCESS_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

function isGreen(check) {
  const c = String(check.conclusion || '').toUpperCase();
  return SUCCESS_CONCLUSIONS.has(c);
}

function isFailed(check) {
  const c = String(check.conclusion || '').toUpperCase();
  return c === 'FAILURE' || c === 'TIMED_OUT' || c === 'CANCELLED' || c === 'ACTION_REQUIRED';
}

/**
 * Build a decision result envelope.
 *
 * @param {string} state
 * @param {object} extra
 */
function result(state, extra = {}) {
  return { state, actions: extra.actions || [], reason: extra.reason || '', ...extra };
}

/**
 * Run a single bounded shepherd pass.
 *
 * @param {object} ctx
 * @param {string} ctx.pr - PR number.
 * @param {string} ctx.owner
 * @param {string} ctx.repo
 * @param {string} ctx.base - Base branch name (for protection lookup).
 * @param {string} ctx.baseRef - Base ref for divergence (e.g. `origin/master`).
 * @param {object} ctx.adapter - A validated pr-state adapter.
 * @param {boolean} [ctx.autoRebase=false] - Opt-in Tier-B rebase.
 * @param {boolean} [ctx.cleanTree=false] - Precondition for rebase.
 * @param {number} [ctx.rerunBudget=3] - Max reruns across the shepherd session.
 * @param {number} [ctx.rerunsUsed=0] - Reruns already spent.
 * @returns {Promise<object>} decision envelope.
 */
async function runShepherdPass(ctx) {
  const {
    pr,
    owner,
    repo,
    base,
    baseRef,
    adapter,
    autoRebase = false,
    cleanTree = false,
    rerunBudget = 3,
    rerunsUsed = 0,
  } = ctx;

  const actions = [];

  // --- Read required-checks set first; this is where auth/scope fails fast. ---
  let required;
  try {
    required = await adapter.readRequiredChecks({ owner, repo, base });
  } catch (error) {
    const auth = classifyAuthError(error);
    if (auth && auth.class === 'insufficient-scope') {
      return result('HARD_STOP', {
        actions,
        authClass: 'insufficient-scope',
        reason: 'Token lacks the permission required to read branch protection. Retry will not recover; escalate to a human to widen the token scope.',
      });
    }
    if (auth && auth.class === 'rate-limit') {
      return result('PENDING', {
        actions,
        authClass: 'rate-limit',
        retryAfter: auth.retryAfter,
        reason: 'Secondary rate limit hit; honor Retry-After then resume on the next pass.',
      });
    }
    if (auth && auth.class === 'expired') {
      return result('PENDING', {
        actions,
        authClass: 'expired',
        reason: 'Token appears expired/unauthorized (transient); pause and surface for re-auth.',
      });
    }
    throw error;
  }

  // --- Read current PR/CI state. ---
  const startState = await adapter.readState(pr);
  const startSha = startState.headSha;

  // Unreadable required set → escalate, never declare merge-ready.
  if (required === null) {
    return result('ESCALATE', {
      actions,
      reason: 'Required-check set is unreadable (branch protection not accessible). Cannot determine merge readiness — escalating with the readable rollup.',
      rollup: startState.checks,
    });
  }

  const divergence = await adapter.readDivergence({ baseRef });
  const behind = divergence.behind || 0;

  const requiredChecks = startState.checks.filter((c) => required.includes(c.name));
  const failedRequired = requiredChecks.filter(isFailed);
  const allRequiredGreen = required.length > 0
    ? requiredChecks.length >= required.length && requiredChecks.every(isGreen)
    : startState.checks.length > 0 && startState.checks.every(isGreen);

  // Helper: re-read HEAD immediately before a mutating action. If HEAD moved
  // since the pass started, abort (concurrency guard).
  const headUnchanged = async () => {
    const now = await adapter.readState(pr);
    return now.headSha === startSha;
  };

  // --- Tier-C: hard conflict. ---
  if (String(startState.mergeStateStatus).toUpperCase() === 'DIRTY') {
    return result('ESCALATE', {
      actions,
      reason: 'Merge conflict (mergeStateStatus=DIRTY). A human must resolve the conflict.',
    });
  }

  // --- Tier-A: flaky required check → rerun (capped, idempotent). ---
  if (failedRequired.length > 0) {
    if (rerunsUsed >= rerunBudget) {
      return result('ESCALATE', {
        actions,
        reason: `Rerun budget exhausted (${rerunsUsed}/${rerunBudget}). Required check still failing — escalating.`,
        failed: failedRequired.map((c) => c.name),
      });
    }
    if (!(await headUnchanged())) {
      return result('PENDING', {
        actions,
        aborted: true,
        reason: 'HEAD moved during the pass; aborted the rerun. Next scheduled pass will re-evaluate.',
      });
    }
    const runId = failedRequired[0].databaseId || failedRequired[0].name;
    await adapter.rerunFailedChecks({ runId });
    actions.push({ type: 'rerun', runId });
    return result('PENDING', {
      actions,
      reason: `Re-ran failed required check '${failedRequired[0].name}'. Awaiting next scheduled pass.`,
    });
  }

  // --- Behind base. ---
  if (behind > 0) {
    if (!autoRebase) {
      return result('ESCALATE', {
        actions,
        reason: `Branch is ${behind} commit(s) behind base. Auto-rebase is opt-in (default OFF) — a human should rebase, or re-run with --auto-rebase.`,
        behind,
      });
    }
    if (!cleanTree) {
      return result('ESCALATE', {
        actions,
        reason: 'Auto-rebase requested but the working tree is not clean. Escalating rather than rebasing over local changes.',
      });
    }
    if (typeof adapter.rebaseOntoBase !== 'function') {
      return result('ESCALATE', {
        actions,
        reason: 'Auto-rebase requested but no rebase capability is wired. Escalating.',
      });
    }
    if (!(await headUnchanged())) {
      return result('PENDING', {
        actions,
        aborted: true,
        reason: 'HEAD moved during the pass; aborted the rebase. Next scheduled pass will re-evaluate.',
      });
    }
    try {
      await adapter.rebaseOntoBase({ baseRef });
      actions.push({ type: 'rebase', baseRef });
      return result('PENDING', {
        actions,
        reason: 'Rebased onto base and force-pushed with lease. Awaiting CI on the next scheduled pass.',
      });
    } catch (error) {
      if (error && error.leaseRejected) {
        return result('ESCALATE', {
          actions,
          reason: 'Force-with-lease was rejected — a concurrent push exists. HARD-STOP: never re-arm the lease. A human must reconcile.',
        });
      }
      return result('ESCALATE', {
        actions,
        reason: `Rebase failed: ${error.message}. Escalating to a human.`,
      });
    }
  }

  // --- Terminal: all required green + not behind → merge-ready handoff. ---
  if (allRequiredGreen) {
    return result('MERGE_READY', {
      actions,
      reason: 'All required checks are green and the branch is up to date. Handing off to the human to merge in the GitHub UI — the shepherd never merges.',
    });
  }

  // --- Otherwise: checks still pending/unknown → wait. ---
  return result('PENDING', {
    actions,
    reason: 'Required checks are not all green yet (still pending) and nothing is actionable this pass. Awaiting the next scheduled pass.',
  });
}

module.exports = {
  runShepherdPass,
  TERMINAL_STATES,
  isGreen,
  isFailed,
};
