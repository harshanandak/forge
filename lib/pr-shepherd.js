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
const TERMINAL_STATES = ['MERGE_READY', 'ESCALATE', 'PENDING', 'MERGED', 'CLOSED', 'NEEDS_REVIEW'];

/** Bot/automation logins whose comments are not human review feedback. */
const BOT_LOGINS = new Set([
  'coderabbitai', 'coderabbitai[bot]', 'sonarqubecloud', 'sonarqubecloud[bot]',
  'github-actions', 'github-actions[bot]', 'qodo-merge-pro', 'qodo-merge-pro[bot]',
  'codecov', 'codecov[bot]', 'greptile-apps', 'greptile-apps[bot]',
  'dependabot', 'dependabot[bot]',
]);

/**
 * Normalize a review thread (or a flat comment object) into its list of
 * `{ author, body }` comments. A thread carries ALL its comments, so a later
 * human reply on a bot-opened thread is visible (not just the first comment).
 */
function threadComments(t) {
  if (Array.isArray(t.comments) && t.comments.length > 0) {
    return t.comments.map((c) => ({
      author: String((c.author && c.author.login) || c.author || '').toLowerCase(),
      body: String(c.body || ''),
    }));
  }
  return [{ author: String(t.author || t.login || '').toLowerCase(), body: String(t.body || '') }];
}

function isHumanAuthor(author, self) {
  const a = String(author || '').toLowerCase();
  return Boolean(a) && a !== String(self || '').toLowerCase() && !BOT_LOGINS.has(a);
}

/**
 * Filter review threads to the ones that need human/semantic attention:
 * unresolved, not outdated, and with at least one comment from a non-bot,
 * non-self participant. Inspecting ALL comments (not just the first) means a
 * bot-opened thread with a later human reply is still treated as actionable.
 *
 * @param {object[]} threads
 * @param {string} [self] - the shepherd's own login (excluded to avoid self-wake).
 * @returns {object[]}
 */
function actionableComments(threads, self) {
  return (Array.isArray(threads) ? threads : []).filter((t) => {
    if (t.resolved || t.isResolved || t.outdated || t.isOutdated) return false;
    return threadComments(t).some((c) => isHumanAuthor(c.author, self));
  });
}

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
 * Map a classified auth error to a decision envelope, or return `null` when the
 * error is not an auth/rate-limit shape (caller should re-throw).
 *
 * @param {Error} error
 * @param {object[]} actions
 * @returns {object | null}
 */
function authOutcome(error, actions) {
  const auth = classifyAuthError(error);
  if (!auth) return null;
  if (auth.class === 'insufficient-scope') {
    return result('HARD_STOP', {
      actions,
      authClass: 'insufficient-scope',
      reason: 'Token lacks the permission required (branch protection / PR state). Retry will not recover; escalate to a human to widen the token scope.',
    });
  }
  if (auth.class === 'rate-limit') {
    return result('PENDING', {
      actions,
      authClass: 'rate-limit',
      retryAfter: auth.retryAfter,
      reason: 'Secondary rate limit hit; honor Retry-After then resume on the next pass.',
    });
  }
  // 'expired' (401) — transient: pause and surface for re-auth.
  return result('PENDING', {
    actions,
    authClass: 'expired',
    reason: 'Token appears expired/unauthorized (transient); pause and surface for re-auth.',
  });
}

/**
 * Run an adapter call, mapping auth/rate-limit failures to a decision envelope
 * via the documented taxonomy instead of letting them escape as generic errors.
 * Non-auth errors are re-thrown.
 *
 * Returns `{ outcome }` when the call should short-circuit the pass, or
 * `{ value }` with the call's resolved value otherwise.
 *
 * @param {() => Promise<*>} call
 * @param {object[]} actions
 * @returns {Promise<{ outcome: object } | { value: * }>}
 */
async function guardAuth(call, actions) {
  try {
    return { value: await call() };
  } catch (error) {
    const outcome = authOutcome(error, actions);
    if (outcome) return { outcome };
    throw error;
  }
}

/**
 * Handle a failed required check: rerun once (capped, idempotent) or escalate.
 *
 * @param {object} args
 * @returns {Promise<object>} decision envelope.
 */
async function handleFailedRequired({
  failedRequired, rerunsUsed, rerunBudget, headUnchanged, adapter, actions, dryRun,
}) {
  // Read-only pass (e.g. `--pull` signal gathering): report the failing state but
  // take NO Tier-A action. Reruns/mutations belong to a plain `forge shepherd`.
  if (dryRun) {
    return result('PENDING', {
      actions,
      dryRun: true,
      reason: `Required check '${failedRequired[0].name}' is failing. Read-only pass — not re-running (a rerun belongs to \`forge shepherd\`, not \`--pull\`).`,
      failed: failedRequired.map((c) => c.name),
    });
  }
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

/**
 * Handle a branch that is behind base: opt-in Tier-B rebase, or escalate.
 *
 * @param {object} args
 * @returns {Promise<object>} decision envelope.
 */
async function handleBehindBase({
  behind, autoRebase, cleanTree, adapter, baseRef, headUnchanged, actions,
}) {
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
    if (error?.leaseRejected) {
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
    cwd,
    adapter,
    autoRebase = false,
    cleanTree = false,
    rerunBudget = 3,
    rerunsUsed = 0,
    // Read-only mode: compute the decision state but take NO mutating action
    // (no rerun, no rebase). Used by `--pull` signal gathering. Additive and
    // default OFF — existing callers are unaffected.
    dryRun = false,
  } = ctx;

  const actions = [];

  // Every read goes through the auth guard so 401/403-scope/rate-limit map to
  // the documented PENDING/HARD_STOP states instead of escaping as a generic
  // failure. Non-auth errors still propagate.

  // --- Read PR/CI state FIRST so a merged/closed PR is detected as terminal
  // even when the branch-protection (required-checks) read would fail with an
  // auth/scope error — the scheduler must always get the terminal signal for a
  // landed/closed PR. ---
  const stateRead = await guardAuth(() => adapter.readState(pr), actions);
  if (stateRead.outcome) return stateRead.outcome;
  const startState = stateRead.value;
  const startSha = startState.headSha;

  // --- Lifecycle: a merged/closed PR is terminal. The external scheduler must
  // stop re-invoking the shepherd once the PR lands or is closed; without this
  // it would keep re-deciding MERGE_READY forever on an already-merged PR. ---
  const prState = String(startState.state || 'OPEN').toUpperCase();
  if (prState === 'MERGED') {
    return result('MERGED', {
      actions,
      reason: 'PR is merged — shepherd work is complete; the scheduler should stop re-invoking this PR.',
    });
  }
  if (prState === 'CLOSED') {
    return result('CLOSED', {
      actions,
      reason: 'PR is closed without merging — shepherd work is complete; the scheduler should stop re-invoking this PR.',
    });
  }

  // --- Required-checks set (only matters for non-terminal PRs); this is where
  // auth/scope fails fast. ---
  const requiredRead = await guardAuth(
    () => adapter.readRequiredChecks({ owner, repo, base }),
    actions,
  );
  if (requiredRead.outcome) return requiredRead.outcome;
  const required = requiredRead.value;

  // Unreadable required set → escalate, never declare merge-ready.
  if (required === null) {
    return result('ESCALATE', {
      actions,
      reason: 'Required-check set is unreadable (branch protection not accessible). Cannot determine merge readiness — escalating with the readable rollup.',
      rollup: startState.checks,
    });
  }

  const divergenceRead = await guardAuth(
    () => adapter.readDivergence({ baseRef, cwd }),
    actions,
  );
  if (divergenceRead.outcome) return divergenceRead.outcome;
  const behind = divergenceRead.value.behind || 0;

  const requiredChecks = startState.checks.filter((c) => required.includes(c.name));
  const failedRequired = requiredChecks.filter(isFailed);
  // Merge-readiness is evaluated against the REQUIRED set only. An empty
  // required set is ready by definition — optional checks (red or pending)
  // never gate merge readiness, and a PR with zero required checks is never
  // stuck PENDING waiting for checks that will never run.
  const allRequiredGreen = required.every((name) => (
    startState.checks.some((check) => check.name === name && isGreen(check))
  ));

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
    return handleFailedRequired({
      failedRequired, rerunsUsed, rerunBudget, headUnchanged, adapter, actions, dryRun,
    });
  }

  // --- Behind base (Tier-B opt-in rebase, else escalate). In read-only mode we
  // never rebase — force autoRebase off so the branch-behind path only escalates. ---
  if (behind > 0) {
    return handleBehindBase({
      behind, autoRebase: dryRun ? false : autoRebase, cleanTree, adapter, baseRef, headUnchanged, actions,
    });
  }

  // --- Review feedback: new actionable comments need the semantic /review
  // agent or a human. The shepherd DETECTS and hands off — it NEVER resolves
  // threads. Flood-capped so "too many comments" can't blow up a single pass. ---
  if (typeof adapter.readComments === 'function') {
    const commentsRead = await guardAuth(
      () => adapter.readComments({ owner, repo, pr }),
      actions,
    );
    if (commentsRead.outcome) return commentsRead.outcome;
    const actionable = actionableComments(commentsRead.value, ctx.self);
    if (actionable.length > 0) {
      const CAP = 20;
      const capped = actionable.length > CAP;
      return result('NEEDS_REVIEW', {
        actions,
        commentCount: actionable.length,
        capped,
        sample: actionable.slice(0, CAP).map((t) => {
          const cs = threadComments(t);
          const human = cs.find((c) => isHumanAuthor(c.author, ctx.self)) || cs[0] || {};
          return { author: human.author || '', body: String(human.body || '').slice(0, 200) };
        }),
        reason: capped
          ? `${actionable.length} unresolved review comments (showing the first ${CAP}). Too many to act on in one pass — handing off to /review. The shepherd never resolves threads.`
          : `${actionable.length} unresolved review comment(s) need attention — handing off to /review. The shepherd never resolves threads.`,
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
