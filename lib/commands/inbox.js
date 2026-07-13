'use strict';

/**
 * `forge inbox` — the SUPPORTED, Anthropic-compliant "comment back to the agent" surface.
 *
 * COMPLIANCE BOUNDARY (verified Anthropic Usage Policy + Claude Code hooks docs, kernel
 * issue 6d10c1a1, 2026-07-13): this reads/writes KERNEL DATA only. The dashboard EDITS the
 * kernel (comments via the broker); the user's OWN human-driven session reads them via
 * supported hooks (SessionStart / UserPromptSubmit) on its next natural turn. There is NO
 * stdin/tty injection anywhere here and the agent is NEVER driven programmatically.
 *
 *   forge inbox                 List unacked, targeted instruction comments.
 *   forge inbox --json          Machine-readable envelope for the dashboard / scripts.
 *   forge inbox ack <id>        Post an `ack:<id>` reply on the instruction's issue.
 */

const {
  collectInbox,
  ackBody,
  DASHBOARD_INBOX_TITLE,
  DASHBOARD_INBOX_TYPE,
} = require('../inbox');
const { fenceUntrusted, neutralize } = require('../untrusted-content');

function usage() {
  return 'Usage: forge inbox [--json]\n'
    + '       forge inbox ack <comment_id>';
}

/** True when the arg list requested JSON output (flag or FORGE_JSON=1). */
function wantsJson(args, opts) {
  return args.includes('--json') || (opts.env || process.env).FORGE_JSON === '1';
}

/** Resolve the shared issue runner (injectable for tests). */
function issueRunner(opts) {
  return opts.runIssueOperation || require('../forge-issues').runIssueOperation;
}

/**
 * One human-readable inbox line. The comment BODY + author are untrusted external content
 * (MINOR-1), so both are neutralize()'d — a planted fence glyph cannot forge a marker — and
 * the whole block is fenced in handleList for parity with the SessionStart/UserPromptSubmit
 * digests (this list is read by the agent too).
 */
function renderItem(item) {
  const from = item.actor ? ` — from ${neutralize(item.actor)}` : '';
  return `  [${item.basis}] ${item.comment_id}${from}\n    ${neutralize(item.text)}`;
}

/** `forge inbox` (list). */
async function handleList(args, projectRoot, opts) {
  const pending = await collectInbox(projectRoot, opts);
  if (wantsJson(args, opts)) {
    return { success: true, output: JSON.stringify({ ok: true, count: pending.length, inbox: pending }, null, 2) };
  }
  if (!pending.length) {
    return { success: true, output: 'No pending dashboard instructions.' };
  }
  // The item block is untrusted external content (comment bodies), so it is provenance-fenced
  // for parity with the digests — the agent that reads `forge inbox` gets the same DATA-only
  // signal. Bodies are already neutralize()'d in renderItem, so no glyph can forge the fence.
  const body = pending.map(renderItem).join('\n');
  const lines = [
    `${pending.length} pending dashboard instruction(s) — act, then \`forge inbox ack <id>\`:`,
    '',
    fenceUntrusted(body, { source: 'dashboard-comment' }),
  ];
  return { success: true, output: lines.join('\n') };
}

/** `forge inbox ack <comment_id>` — post the ack reply on the instruction's issue. */
async function handleAck(rest, projectRoot, opts) {
  const commentId = (rest || []).find(arg => typeof arg === 'string' && !arg.startsWith('-'));
  if (!commentId) {
    return { success: false, error: `Missing <comment_id>.\n${usage()}`, exitCode: 6 };
  }
  const pending = await collectInbox(projectRoot, opts);
  const target = pending.find(item => item.comment_id === commentId);
  if (!target) {
    return {
      success: false,
      error: `No pending instruction with id ${commentId} is targeted at this session `
        + '(already acked, or not addressed here). Run `forge inbox` to see pending items.',
      exitCode: 1,
    };
  }
  const runIssueOperation = issueRunner(opts);
  const result = await runIssueOperation('comment', [target.issue_id, ackBody(commentId)], projectRoot);
  if (!result || (result.ok !== true && result.success !== true)) {
    return { success: false, error: `Failed to post ack for ${commentId}.`, exitCode: 1 };
  }
  return { success: true, output: `Acked ${commentId} on ${target.issue_id}.` };
}

async function handler(args, _flags = {}, projectRoot, opts = {}) {
  const action = args[0];
  if (action === '--help' || action === '-h') {
    return { success: true, output: usage() };
  }
  if (action === 'ack') {
    return handleAck(args.slice(1), projectRoot, opts);
  }
  return handleList(args, projectRoot, opts);
}

module.exports = {
  name: 'inbox',
  description: 'List and ack targeted dashboard instruction comments (compliant comment-back)',
  usage: usage(),
  flags: {
    '--json': 'Machine-readable envelope for the dashboard / scripts',
  },
  handler,
  // exported for tests / reuse
  DASHBOARD_INBOX_TITLE,
  DASHBOARD_INBOX_TYPE,
};
