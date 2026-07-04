'use strict';

/**
 * @module merge-rules
 *
 * PURE, network-free evaluator for the opt-in conditional auto-merge RULES
 * ENGINE (the vision-roadmap "Candidate feature" that promotes the proven
 * `settle-merge.sh` baseline to a native, config-driven forge capability).
 *
 * `evaluateMergeRules(prContext, rules)` decides whether a merge is ALLOWED by
 * ANDing a list of composable rules over an already-fetched PR context. It does
 * NO I/O: the caller fetches the PR context (checks, threads, approvals,
 * comments, timestamps) and passes it in, which keeps this the single
 * unit-testable decision surface. The command layer (`lib/commands/merge.js`)
 * owns the gh-fetch and the merge action, and only ever runs this when the user
 * has explicitly opted in — so the never-auto-merge-by-default invariant holds.
 *
 * Fail-closed is the guiding principle: an unknown rule type, a malformed rule,
 * or a piece of context we cannot read is surfaced as UNMET, never silently
 * satisfied. A merge only proceeds when every rule is affirmatively met.
 *
 * PR context shape (all fields optional; absence is treated fail-closed by the
 * rules that need them):
 *   - checks:             Array<{ name, conclusion }>  CI check rollup
 *   - requiredChecksKnown: boolean                     is the required set readable?
 *   - unresolvedThreads:  number | Array               open review threads
 *   - behindBase:         number | boolean             commits behind base
 *   - approvals:          Array<string | { author }>   approving reviewers
 *   - comments:           Array<{ author, at }>         PR/review comments
 *   - lastActivityAt:     number | string (epoch ms or ISO)
 *   - now:                number | string (epoch ms or ISO)
 *
 * Built-in rule types (compose as a list, ANDed by default):
 *   checks_green | threads_resolved | not_behind | min_approvals:N |
 *   settle_min:N | idle_min:N | last_comment_by:X | approved_by:[..] |
 *   not_commented_by:[..]
 * Composition wrappers:
 *   { any_of: [rule, ...] }  passes if ANY member passes
 *   { not: rule }            passes if the inner rule FAILS
 *
 * A custom-predicate seam (bring-your-own script via `forge add`) is a
 * documented follow-up and intentionally NOT implemented here.
 */

const SUCCESS_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'PASS', 'PASSED']);
const MS_PER_MIN = 60_000;

/** Coerce an epoch-ms number, a Date, or an ISO string to epoch ms (NaN if unparseable). */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? NaN : parsed;
  }
  return NaN;
}

/** Normalize an actor reference (string or `{ author | login | user | actor }`) to a lowercased login. */
function normLogin(entry) {
  if (typeof entry === 'string') return entry.trim().toLowerCase();
  if (entry && typeof entry === 'object') {
    const login = entry.author ?? entry.login ?? entry.user ?? entry.actor ?? '';
    return String(login).trim().toLowerCase();
  }
  return '';
}

/** Coerce a rule argument to a lowercased list of accounts. */
function toAccountList(arg) {
  if (Array.isArray(arg)) return arg.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (arg === undefined || arg === null || arg === '') return [];
  return [String(arg).trim().toLowerCase()];
}

/** A CI check is green if its conclusion is a success-class conclusion. */
function isCheckGreen(check) {
  if (!check || typeof check !== 'object') return false;
  const conclusion = String(check.conclusion ?? check.state ?? check.status ?? '').toUpperCase();
  return SUCCESS_CONCLUSIONS.has(conclusion);
}

/** The most recent comment by timestamp; ties and unparseable stamps fall back to array order. */
function lastComment(prContext) {
  const comments = Array.isArray(prContext.comments) ? prContext.comments : [];
  let latest = null;
  let latestRank = -Infinity;
  for (const comment of comments) {
    const ms = toMs(comment && comment.at);
    const rank = Number.isNaN(ms) ? -Infinity : ms;
    if (rank >= latestRank) {
      latestRank = rank;
      latest = comment;
    }
  }
  return latest;
}

/** Lowercased logins of every approving reviewer. */
function approverLogins(prContext) {
  const approvals = Array.isArray(prContext.approvals) ? prContext.approvals : [];
  return approvals.map(normLogin).filter(Boolean);
}

const pass = () => ({ ok: true });
const fail = (reason) => ({ ok: false, reason });

// --- Built-in rule predicates. Each returns { ok } or { ok:false, reason }. ---

function checksGreen(ctx) {
  if (ctx.requiredChecksKnown !== true) {
    return fail('required-check set is not known to be readable — cannot confirm green (fail-closed).');
  }
  if (!Array.isArray(ctx.checks)) {
    return fail('check results are missing from the PR context (fail-closed).');
  }
  const notGreen = ctx.checks.filter((c) => !isCheckGreen(c));
  if (notGreen.length > 0) {
    const names = notGreen.map((c) => (c && c.name) || '?').join(', ');
    return fail(`${notGreen.length} check(s) not green: ${names}.`);
  }
  return pass();
}

function threadsResolved(ctx) {
  const unresolved = ctx.unresolvedThreads;
  if (typeof unresolved === 'number') {
    return unresolved > 0 ? fail(`${unresolved} unresolved review thread(s).`) : pass();
  }
  if (Array.isArray(unresolved)) {
    return unresolved.length > 0 ? fail(`${unresolved.length} unresolved review thread(s).`) : pass();
  }
  return fail('unresolved-thread count is unknown (fail-closed).');
}

function notBehind(ctx) {
  const behind = ctx.behindBase;
  if (typeof behind === 'boolean') return behind ? fail('branch is behind its base.') : pass();
  if (typeof behind === 'number') {
    return behind > 0 ? fail(`branch is ${behind} commit(s) behind base.`) : pass();
  }
  return fail('behind-base status is unknown (fail-closed).');
}

function minApprovals(ctx, arg) {
  const need = Number.parseInt(arg, 10);
  if (!Number.isFinite(need)) return fail('min_approvals requires a numeric argument, e.g. "min_approvals:2".');
  const count = approverLogins(ctx).length;
  return count >= need ? pass() : fail(`only ${count} approval(s); need ${need}.`);
}

function settleMin(ctx, arg) {
  const need = Number(arg);
  if (!Number.isFinite(need)) return fail('settle_min requires a numeric minute argument.');
  const nowMs = toMs(ctx.now);
  if (Number.isNaN(nowMs)) return fail('current time (now) is missing/unparseable (fail-closed).');
  const lc = lastComment(ctx);
  if (!lc) return pass(); // nothing has been said → nothing to settle
  const atMs = toMs(lc.at);
  if (Number.isNaN(atMs)) return fail('last comment timestamp is unparseable (fail-closed).');
  const ageMin = (nowMs - atMs) / MS_PER_MIN;
  return ageMin >= need ? pass() : fail(`last comment was ${ageMin.toFixed(1)}m ago; need >= ${need}m of quiet.`);
}

function idleMin(ctx, arg) {
  const need = Number(arg);
  if (!Number.isFinite(need)) return fail('idle_min requires a numeric minute argument.');
  const nowMs = toMs(ctx.now);
  if (Number.isNaN(nowMs)) return fail('current time (now) is missing/unparseable (fail-closed).');
  const activityMs = toMs(ctx.lastActivityAt);
  if (Number.isNaN(activityMs)) return fail('lastActivityAt is missing/unparseable (fail-closed).');
  const ageMin = (nowMs - activityMs) / MS_PER_MIN;
  return ageMin >= need ? pass() : fail(`last activity was ${ageMin.toFixed(1)}m ago; need >= ${need}m idle.`);
}

function lastCommentBy(ctx, arg) {
  const allowed = toAccountList(arg);
  if (allowed.length === 0) return fail('last_comment_by requires at least one account.');
  const lc = lastComment(ctx);
  if (!lc) return fail(`no comments yet; last comment is not by ${allowed.join('/')}.`);
  const author = normLogin(lc);
  return allowed.includes(author) ? pass() : fail(`last comment is by "${author}", not ${allowed.join('/')}.`);
}

function approvedBy(ctx, arg) {
  const required = toAccountList(arg);
  if (required.length === 0) return fail('approved_by requires at least one account.');
  const approvers = new Set(approverLogins(ctx));
  const missing = required.filter((account) => !approvers.has(account));
  return missing.length === 0 ? pass() : fail(`missing approval from: ${missing.join(', ')}.`);
}

function notCommentedBy(ctx, arg) {
  const blocked = toAccountList(arg);
  if (blocked.length === 0) return fail('not_commented_by requires at least one account.');
  const lc = lastComment(ctx);
  if (!lc) return pass(); // no comments → no blocked account had the last word
  const author = normLogin(lc);
  return blocked.includes(author)
    ? fail(`the most recent comment is by "${author}", which is blocked from having the last word.`)
    : pass();
}

function anyOf(ctx, arg) {
  if (!Array.isArray(arg) || arg.length === 0) {
    return fail('any_of requires a non-empty list of member rules (fail-closed).');
  }
  const memberReasons = [];
  for (const member of arg) {
    const res = evalRule(ctx, member);
    if (res.ok) return pass();
    memberReasons.push(`${res.label}: ${res.reason}`);
  }
  return fail(`none of the any_of members passed — ${memberReasons.join(' | ')}`);
}

function notWrapper(ctx, arg) {
  if (arg === undefined || arg === null) return fail('not requires an inner rule (fail-closed).');
  const res = evalRule(ctx, arg);
  return res.ok
    ? fail(`inner rule "${res.label}" passed, but "not" requires it to fail.`)
    : pass();
}

const PREDICATES = {
  checks_green: (ctx) => checksGreen(ctx),
  threads_resolved: (ctx) => threadsResolved(ctx),
  not_behind: (ctx) => notBehind(ctx),
  min_approvals: (ctx, arg) => minApprovals(ctx, arg),
  settle_min: (ctx, arg) => settleMin(ctx, arg),
  idle_min: (ctx, arg) => idleMin(ctx, arg),
  last_comment_by: (ctx, arg) => lastCommentBy(ctx, arg),
  approved_by: (ctx, arg) => approvedBy(ctx, arg),
  not_commented_by: (ctx, arg) => notCommentedBy(ctx, arg),
  any_of: (ctx, arg) => anyOf(ctx, arg),
  not: (ctx, arg) => notWrapper(ctx, arg),
};

/** Produce a stable label for an unmet-list entry from a rule's type + scalar arg. */
function scalarLabel(type, arg) {
  if (arg === undefined || arg === null || Array.isArray(arg) || typeof arg === 'object') return type;
  return `${type}:${arg}`;
}

/**
 * Normalize a rule (string `"type"` / `"type:arg"` or single-key object
 * `{ type: arg }`) to `{ type, arg, label, malformed }`.
 */
function normalizeRule(rule) {
  if (typeof rule === 'string') {
    const idx = rule.indexOf(':');
    if (idx === -1) return { type: rule.trim(), arg: undefined, label: rule.trim() };
    const type = rule.slice(0, idx).trim();
    const arg = rule.slice(idx + 1).trim();
    return { type, arg, label: rule.trim() };
  }
  if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
    const keys = Object.keys(rule);
    if (keys.length !== 1) {
      return { type: null, arg: undefined, label: `object(${keys.join(',') || 'empty'})`, malformed: true };
    }
    const type = keys[0];
    return { type, arg: rule[type], label: scalarLabel(type, rule[type]) };
  }
  return { type: null, arg: undefined, label: String(rule), malformed: true };
}

/** Evaluate a single rule against the context. Returns `{ ok, reason, label }`. */
function evalRule(prContext, rule) {
  const { type, arg, label, malformed } = normalizeRule(rule);
  let res;
  if (malformed || !type) {
    res = fail('malformed rule: expected a string or a single-key object (exactly one key).');
  } else if (Object.prototype.hasOwnProperty.call(PREDICATES, type)) {
    res = PREDICATES[type](prContext, arg);
  } else {
    res = fail(`unknown rule type "${type}" (fail-closed).`);
  }
  return { ok: res.ok, reason: res.reason, label };
}

/**
 * Evaluate a list of merge rules over a PR context.
 *
 * Rules are ANDed: a merge is ALLOWED only when every rule is met. An empty (or
 * non-array) rule list is vacuously allowed — the command layer separately
 * requires `merge.auto.enabled === true` before ever calling this, which is
 * what preserves the opt-in / never-auto-merge-by-default invariant.
 *
 * @param {object} prContext - Already-fetched PR context (no I/O performed here).
 * @param {Array} rules - Composable rule list.
 * @returns {{ allowed: boolean, unmet: Array<{ rule: string, reason: string }> }}
 */
function evaluateMergeRules(prContext, rules) {
  const context = prContext && typeof prContext === 'object' ? prContext : {};
  const list = Array.isArray(rules) ? rules : [];
  const unmet = [];
  for (const rule of list) {
    const res = evalRule(context, rule);
    if (!res.ok) unmet.push({ rule: res.label, reason: res.reason });
  }
  return { allowed: unmet.length === 0, unmet };
}

module.exports = {
  evaluateMergeRules,
  // Exported for focused testing / reuse; not part of the stable public surface.
  isCheckGreen,
  normalizeRule,
};
