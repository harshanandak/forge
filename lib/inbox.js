'use strict';

/**
 * @module inbox
 *
 * The SUPPORTED, Anthropic-compliant "comment back to the agent" core.
 *
 * COMPLIANCE BOUNDARY (verified against the Anthropic Usage Policy + Claude Code hooks
 * docs — see the compliance comment on kernel issue 6d10c1a1, 2026-07-13):
 *   The dashboard / CLI EDITS THE KERNEL (writes comments via the broker comment path);
 *   the user's OWN, human-driven Claude Code session READS that data via SUPPORTED hooks
 *   (SessionStart / UserPromptSubmit) on its next natural turn. That is data-management +
 *   official hooks — NOT input-injection. This module therefore contains NO stdin/tty
 *   writing, NO process piping, and NEVER drives the agent programmatically. Kernel data
 *   + supported hooks ONLY. Do not add any code that writes to a running session.
 *
 * Two layers, kept separate for testability (mirrors lib/memory-digest.js):
 *   - collectInbox(projectRoot, opts) — BEST-EFFORT read of pending, unacked, targeted
 *     instruction comments (each source degrades to [] on failure; fetchers injectable).
 *   - buildInboxDigest(pending, opts) / inboxSection(pending) — PURE formatting +
 *     provenance-fencing (fenceUntrusted, source 'dashboard-comment') AFTER budget
 *     truncation, so the close marker always survives.
 */

const path = require('node:path');
const { applyBudget, buildSection, estimateTokens } = require('./orientation');
const { fenceUntrusted } = require('./untrusted-content');
const { detectWorktree } = require('./detect-worktree');

// A dashboard comment is an INSTRUCTION when its body carries this marker. Body-marker
// detection is the reliable signal (actor/origin may not survive a projection round-trip).
const INSTRUCTION_TAG = '[forge:instruction]';
// Ack replies use `ack:<comment_id>` as their body — the read side matches on this prefix.
const ACK_PREFIX = 'ack:';
// The standing chore issue that collects board-level / unscoped dashboard comments.
const DASHBOARD_INBOX_TITLE = 'dashboard-inbox';
const DASHBOARD_INBOX_TYPE = 'chore';

const DEFAULT_INBOX_LIMIT = 5;
const DEFAULT_INBOX_BUDGET_TOKENS = 300;
const INBOX_UNTRUSTED_SOURCE = 'dashboard-comment';
const INBOX_DIGEST_HEADER = 'Forge inbox — pending dashboard instructions (act, then `forge inbox ack <id>`):';
const INBOX_SECTION_TITLE = 'Pending dashboard instructions (ack with `forge inbox ack <id>`)';

/** Run an async producer, returning `fallback` on any throw/rejection (never propagates). */
async function safe(producer, fallback) {
  try {
    const value = await producer();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/** True when a kernel comment carries the instruction marker. */
function isInstruction(comment) {
  return Boolean(comment) && typeof comment.body === 'string' && comment.body.includes(INSTRUCTION_TAG);
}

/** The canonical ack-reply body for a comment id. */
function ackBody(commentId) {
  return `${ACK_PREFIX}${commentId}`;
}

/** If a comment is an ack reply, return the acked comment id; else null. */
function parseAckId(comment) {
  const body = comment && typeof comment.body === 'string' ? comment.body.trim() : '';
  if (!body.startsWith(ACK_PREFIX)) return null;
  const id = body.slice(ACK_PREFIX.length).trim();
  return id || null;
}

/** The comment id as read back from `show` (read shape uses `id`; write payload uses comment_id). */
function commentId(comment) {
  return (comment && (comment.id || comment.comment_id)) || null;
}

/** Human-facing instruction text with the marker stripped. */
function instructionText(comment) {
  return String(comment.body).split(INSTRUCTION_TAG).join('').trim();
}

/**
 * Resolve the current session's identity — the same signals `forge claim` stamps onto a
 * lease (FORGE_ACTOR, FORGE_SESSION_ID, and the worktree basename / FORGE_WORKTREE_ID).
 * Best-effort: worktree detection failure degrades to null (never throws).
 */
function resolveIdentity(projectRoot, opts = {}) {
  const env = opts.env || process.env;
  const actor = typeof env.FORGE_ACTOR === 'string' && env.FORGE_ACTOR.trim() ? env.FORGE_ACTOR.trim() : 'forge';
  const sessionId = typeof env.FORGE_SESSION_ID === 'string' && env.FORGE_SESSION_ID.trim() ? env.FORGE_SESSION_ID.trim() : null;
  const worktreeId = resolveWorktreeId(projectRoot, env, opts);
  return { actor, sessionId, worktreeId };
}

/** Derive the worktree id identically to how a claim stamps it (basename of current worktree). */
function resolveWorktreeId(projectRoot, env, opts) {
  const override = typeof env.FORGE_WORKTREE_ID === 'string' ? env.FORGE_WORKTREE_ID.trim() : '';
  if (override) return override;
  try {
    const detect = opts.detectWorktree || detectWorktree;
    const info = detect(projectRoot);
    if (info && typeof info.currentWorktree === 'string' && info.currentWorktree) {
      return path.basename(info.currentWorktree);
    }
  } catch {
    // best-effort presence signal only — never a hard failure
  }
  return null;
}

/**
 * Decide whether a claim is targeted at this identity, and on what basis. Precedence:
 * session_id (exact, when both present) → worktree_id (honest fallback when session is
 * null) → actor-only (best-effort floor). Returns { match, basis }.
 */
function classifyClaim(claim, identity) {
  if (!claim || claim.actor !== identity.actor) return { match: false };
  if (identity.sessionId && claim.session_id) {
    return { match: claim.session_id === identity.sessionId, basis: 'session' };
  }
  if (identity.worktreeId && claim.worktree_id) {
    return { match: claim.worktree_id === identity.worktreeId, basis: 'worktree' };
  }
  return { match: true, basis: 'actor' };
}

/**
 * The issue ids whose comments this session should drain, each with the targeting basis:
 * claimed issues matched by identity + the standing dashboard-inbox issue (basis 'board').
 */
function resolveTargets(claims, identity, dashboardInboxId) {
  const targets = [];
  const seen = new Set();
  for (const claim of Array.isArray(claims) ? claims : []) {
    const verdict = classifyClaim(claim, identity);
    if (verdict.match && claim.issue_id && !seen.has(claim.issue_id)) {
      seen.add(claim.issue_id);
      targets.push({ issueId: claim.issue_id, basis: verdict.basis });
    }
  }
  if (dashboardInboxId && !seen.has(dashboardInboxId)) {
    seen.add(dashboardInboxId);
    targets.push({ issueId: dashboardInboxId, basis: 'board' });
  }
  return targets;
}

/** From one issue's comments, the unacked instruction comments as inbox items. */
function pendingInstructions(comments, target) {
  const list = Array.isArray(comments) ? comments : [];
  const acked = new Set();
  for (const comment of list) {
    const id = parseAckId(comment);
    if (id) acked.add(id);
  }
  const items = [];
  for (const comment of list) {
    const id = commentId(comment);
    if (!isInstruction(comment) || !id || acked.has(id)) continue;
    items.push({
      comment_id: id,
      issue_id: target.issueId,
      basis: target.basis,
      actor: comment.actor || null,
      created_at: comment.created_at || null,
      body: comment.body,
      text: instructionText(comment),
    });
  }
  return items;
}

/** Extract the comments array from a `show --json` envelope, defensively. */
function extractComments(result) {
  const data = result && result.data;
  if (data && Array.isArray(data.comments)) return data.comments;
  if (result && Array.isArray(result.comments)) return result.comments;
  return [];
}

/** Extract the claims array from a `claims --json` envelope, defensively. */
function extractClaims(result) {
  const data = result && result.data;
  if (data && Array.isArray(data.claims)) return data.claims;
  if (result && Array.isArray(result.claims)) return result.claims;
  return [];
}

/** Default claims reader — `forge claims --json` through the shared issue runner. */
async function defaultFetchClaims(projectRoot, opts = {}) {
  const runIssueOperation = opts.runIssueOperation || require('./forge-issues').runIssueOperation;
  const result = await runIssueOperation('claims', ['--json'], projectRoot);
  return extractClaims(result);
}

/** Default per-issue comment reader — `forge show <id> --json`. */
async function defaultFetchComments(projectRoot, issueId, opts = {}) {
  const runIssueOperation = opts.runIssueOperation || require('./forge-issues').runIssueOperation;
  const result = await runIssueOperation('show', [issueId, '--json'], projectRoot);
  return extractComments(result);
}

/**
 * Default dashboard-inbox resolver — READ ONLY (never creates; the digest/hook paths must
 * be side-effect free). Returns the issue id whose title is `dashboard-inbox`, or null.
 */
async function defaultResolveDashboardInboxId(projectRoot, opts = {}) {
  const runIssueOperation = opts.runIssueOperation || require('./forge-issues').runIssueOperation;
  const result = await runIssueOperation('list', ['--json'], projectRoot);
  const issues = extractIssueList(result);
  const match = issues.find(issue => issue && issue.title === DASHBOARD_INBOX_TITLE);
  return match && match.id ? match.id : null;
}

/** Extract an issues array from a list-style envelope, defensively. */
function extractIssueList(result) {
  const data = result && result.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.issues)) return data.issues;
  if (result && Array.isArray(result.issues)) return result.issues;
  return [];
}

/**
 * Gather pending, unacked, targeted instruction comments. BEST-EFFORT and side-effect
 * free — every source degrades to [] / null independently (fail-open by construction).
 *
 * @param {string} projectRoot
 * @param {object} [opts] - injectable: fetchClaims, fetchComments, resolveDashboardInboxId,
 *   identity, env, inboxLimit, runIssueOperation.
 * @returns {Promise<object[]>} pending inbox items (bounded to inboxLimit).
 */
async function collectInbox(projectRoot, opts = {}) {
  const identity = opts.identity || resolveIdentity(projectRoot, opts);
  const fetchClaims = opts.fetchClaims || defaultFetchClaims;
  const fetchComments = opts.fetchComments || defaultFetchComments;
  const resolveDashboardInboxId = opts.resolveDashboardInboxId || defaultResolveDashboardInboxId;
  const limit = opts.inboxLimit || DEFAULT_INBOX_LIMIT;

  const claims = await safe(() => fetchClaims(projectRoot, opts), []);
  const dashboardInboxId = await safe(() => resolveDashboardInboxId(projectRoot, opts), null);
  const targets = resolveTargets(claims, identity, dashboardInboxId);

  const pending = [];
  for (const target of targets) {
    const comments = await safe(() => fetchComments(projectRoot, target.issueId, opts), []);
    for (const item of pendingInstructions(comments, target)) pending.push(item);
  }
  return pending.slice(0, limit);
}

/** `- [basis] (comment_id) text` for one inbox item. */
function formatInboxLine(item) {
  const basis = item.basis ? `[${item.basis}] ` : '';
  return `- ${basis}(${item.comment_id}) ${item.text}`;
}

/**
 * A digest SECTION for the SessionStart memory digest (fenced by the assembler AFTER
 * budget truncation). Priority 5 — a fresh human directive outranks stale notes (10) and
 * the agent's own issue list (20). Returns null when there is nothing pending.
 */
function inboxSection(pending) {
  const list = Array.isArray(pending) ? pending : [];
  if (!list.length) return null;
  return buildSection({
    id: 'digest_inbox',
    title: INBOX_SECTION_TITLE,
    content: list.map(formatInboxLine).join('\n'),
    priority: 5,
    preserve: false,
    // Untrusted: a dashboard comment is DATA, not instructions. Fenced after truncation.
    untrustedSource: INBOX_UNTRUSTED_SOURCE,
  });
}

/**
 * A STANDALONE fenced digest of pending inbox comments (the UserPromptSubmit tier). PURE.
 * Budget-capped via applyBudget, then fenced AFTER truncation so the ⟦END UNTRUSTED⟧ close
 * marker always survives. Empty input → { text: '', empty: true }.
 */
function buildInboxDigest(pending, options = {}) {
  const section = inboxSection(pending);
  if (!section) return { text: '', empty: true, tokens: 0 };
  const budgetTokens = options.budgetTokens || DEFAULT_INBOX_BUDGET_TOKENS;
  const budgeted = applyBudget([section], budgetTokens);
  const body = budgeted.sections
    .filter(part => part.content)
    .map(part => fenceUntrusted(part.content, { source: part.untrustedSource }))
    .join('\n\n');
  if (!body) return { text: '', empty: true, tokens: 0 };
  const text = `${INBOX_DIGEST_HEADER}\n\n${body}`;
  return { text, empty: false, tokens: estimateTokens(text) };
}

module.exports = {
  INSTRUCTION_TAG,
  ACK_PREFIX,
  DASHBOARD_INBOX_TITLE,
  DASHBOARD_INBOX_TYPE,
  DEFAULT_INBOX_LIMIT,
  INBOX_UNTRUSTED_SOURCE,
  INBOX_DIGEST_HEADER,
  isInstruction,
  ackBody,
  parseAckId,
  instructionText,
  resolveIdentity,
  classifyClaim,
  resolveTargets,
  pendingInstructions,
  extractComments,
  extractClaims,
  collectInbox,
  inboxSection,
  formatInboxLine,
  buildInboxDigest,
  // exported for focused reuse / tests
  defaultFetchClaims,
  defaultFetchComments,
  defaultResolveDashboardInboxId,
};
