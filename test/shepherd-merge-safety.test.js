'use strict';

// Tier-1 shepherd merge-safety: the VERDICT must never be false-clean.
// Layered on master's pull-signal blockers model; adds review-at-head (#365),
// settle window, torn-read + fail-closed UNKNOWN, and the F1/F2/F3/F5/F6 fixes.
// Issues: c01936be, 35ee8d78. See docs/work/2026-07-12-shepherd-merge-safety.

const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const { computeVerdict, gatherPullSignal } = require('../lib/pr-pull');
const { runShepherdPass } = require('../lib/pr-shepherd');
const shepherdCmd = require('../lib/commands/shepherd');
const { loadCommands, executeCommand } = require('../lib/commands/_registry');

const HEAD = 'head-sha';
const NOW = Date.now();
const SETTLED = NOW - 3600 * 1000; // 1h ago → outside the 600s settle window
const GREEN_CLASS = { missing: [], skipped: [], pending: [], failing: [], unreadable: false };

// A clean, explicitly-good baseline verdict input. Individual tests override.
const cleanBase = {
  headOidStart: HEAD, headOidEnd: HEAD,
  mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', reviewDecision: null,
  requiredClass: GREEN_CLASS, behind: 0, conflicts: null,
  unresolvedThreadCount: 0, botStatusBlockerCount: 0,
  botDirectComments: [], reviews: [],
  headPushTimeMs: SETTLED, headPushKnown: true,
  issueComments: [], now: NOW, settleWindowMs: 600000, unreadable: [],
};

// ---------------------------------------------------------------------------
// computeVerdict — pure precedence + fail-closed unit tests
// ---------------------------------------------------------------------------
describe('computeVerdict precedence (fail-closed, never false-clean)', () => {
  test('explicitly-good CLEAN state, settled, all green → CLEAN-MERGEABLE', () => {
    expect(computeVerdict(cleanBase).verdict).toBe('CLEAN-MERGEABLE');
  });

  // F1 — non-explicitly-good merge state must NOT reach CLEAN.
  test('(F1) mergeStateStatus UNKNOWN → UNKNOWN, never CLEAN', () => {
    expect(computeVerdict({ ...cleanBase, mergeStateStatus: 'UNKNOWN' }).verdict).toBe('UNKNOWN');
  });
  test('(F1) empty/BLOCKED merge state with nothing else derivable → UNKNOWN', () => {
    expect(computeVerdict({ ...cleanBase, mergeStateStatus: '' }).verdict).toBe('UNKNOWN');
    expect(computeVerdict({ ...cleanBase, mergeStateStatus: 'BLOCKED' }).verdict).toBe('UNKNOWN');
  });

  test('unreadable input → UNKNOWN', () => {
    expect(computeVerdict({ ...cleanBase, unreadable: ['reviews'] }).verdict).toBe('UNKNOWN');
  });
  test('unreadable required set → UNKNOWN', () => {
    expect(computeVerdict({ ...cleanBase, requiredClass: { ...GREEN_CLASS, unreadable: true } }).verdict).toBe('UNKNOWN');
  });
  test('torn read (head moved) → UNKNOWN', () => {
    expect(computeVerdict({ ...cleanBase, headOidEnd: 'moved' }).verdict).toBe('UNKNOWN');
  });
  test('unknown head-push time → not CLEAN (fail-closed)', () => {
    expect(computeVerdict({ ...cleanBase, headPushKnown: false, headPushTimeMs: null }).verdict).not.toBe('CLEAN-MERGEABLE');
  });

  test('BLOCKED-CONFLICT for DIRTY / CONFLICTING / predicted conflict', () => {
    expect(computeVerdict({ ...cleanBase, mergeStateStatus: 'DIRTY' }).verdict).toBe('BLOCKED-CONFLICT');
    expect(computeVerdict({ ...cleanBase, mergeable: 'CONFLICTING' }).verdict).toBe('BLOCKED-CONFLICT');
    expect(computeVerdict({ ...cleanBase, conflicts: { conflicted: true, files: ['a'] } }).verdict).toBe('BLOCKED-CONFLICT');
  });

  test('BEHIND for mergeStateStatus BEHIND or behind>0', () => {
    expect(computeVerdict({ ...cleanBase, mergeStateStatus: 'BEHIND' }).verdict).toBe('BEHIND');
    expect(computeVerdict({ ...cleanBase, behind: 2 }).verdict).toBe('BEHIND');
  });

  test('BLOCKED-CHECKS for failing/missing/skipped/pending required or UNSTABLE', () => {
    expect(computeVerdict({ ...cleanBase, requiredClass: { ...GREEN_CLASS, failing: ['ci'] } }).verdict).toBe('BLOCKED-CHECKS');
    expect(computeVerdict({ ...cleanBase, requiredClass: { ...GREEN_CLASS, skipped: ['ci'] } }).verdict).toBe('BLOCKED-CHECKS');
    expect(computeVerdict({ ...cleanBase, requiredClass: { ...GREEN_CLASS, missing: ['ci'] } }).verdict).toBe('BLOCKED-CHECKS');
    expect(computeVerdict({ ...cleanBase, requiredClass: { ...GREEN_CLASS, pending: ['ci'] } }).verdict).toBe('BLOCKED-CHECKS');
    expect(computeVerdict({ ...cleanBase, mergeStateStatus: 'UNSTABLE' }).verdict).toBe('BLOCKED-CHECKS');
  });

  // F6 — SonarCloud/Vercel/Netlify/Codecov block via CHECKS (required check OR a
  // failing bot-status COMMENT), never via the resolvable-thread path.
  test('(F6) failing Sonar gate as a REQUIRED check → BLOCKED-CHECKS', () => {
    const rc = { ...GREEN_CLASS, failing: ['SonarCloud Code Analysis'] };
    expect(computeVerdict({ ...cleanBase, mergeStateStatus: 'BLOCKED', requiredClass: rc }).verdict).toBe('BLOCKED-CHECKS');
  });
  test('(F6) failing Sonar/Vercel gate as a bot-status COMMENT → BLOCKED-CHECKS', () => {
    expect(computeVerdict({ ...cleanBase, mergeStateStatus: 'BLOCKED', botStatusBlockerCount: 1 }).verdict).toBe('BLOCKED-CHECKS');
  });
  test('(F6) a PASSING Sonar quality-gate comment does NOT create BLOCKED-THREADS (no perpetual block)', () => {
    // A suppressed status bot yields no actionable direct comment; passing gate → no bot-status blocker.
    const out = computeVerdict({ ...cleanBase, botDirectComments: [], botStatusBlockerCount: 0 });
    expect(out.verdict).toBe('CLEAN-MERGEABLE');
    expect(out.verdict).not.toBe('BLOCKED-THREADS');
  });

  test('BLOCKED-CHECKS beats an open thread (checks precede threads)', () => {
    const out = computeVerdict({ ...cleanBase, mergeStateStatus: 'UNSTABLE', unresolvedThreadCount: 3 });
    expect(out.verdict).toBe('BLOCKED-CHECKS');
  });

  test('BLOCKED-THREADS for an unresolved inline thread', () => {
    expect(computeVerdict({ ...cleanBase, mergeStateStatus: 'BLOCKED', unresolvedThreadCount: 1 }).verdict).toBe('BLOCKED-THREADS');
  });
  test('BLOCKED-THREADS for CHANGES_REQUESTED', () => {
    expect(computeVerdict({ ...cleanBase, reviewDecision: 'CHANGES_REQUESTED' }).verdict).toBe('BLOCKED-THREADS');
  });

  // F5 — a fresh code-review-bot issue comment blocks even when an agent posted a
  // LATER unrelated comment; the anchor is the head push, not agent chatter.
  test('(F5) bot comment newer than head push → BLOCKED-THREADS even after a later agent comment', () => {
    const out = computeVerdict({
      ...cleanBase,
      mergeStateStatus: 'BLOCKED',
      headPushTimeMs: NOW - 300 * 1000, headPushKnown: true,
      botDirectComments: [{ author: 'coderabbitai', createdAt: new Date(NOW - 200 * 1000).toISOString(), commentId: 'IC1' }],
      issueComments: [{ author: 'me-bot', createdAt: new Date(NOW - 50 * 1000).toISOString() }],
    });
    expect(out.verdict).toBe('BLOCKED-THREADS');
    expect(out.evidence.botComments).toContain('IC1');
  });
  test('(F5) a bot comment OLDER than the last head push is stale, not a live block', () => {
    const out = computeVerdict({
      ...cleanBase,
      headPushTimeMs: NOW - 100 * 1000, headPushKnown: true,
      botDirectComments: [{ author: 'coderabbitai', createdAt: new Date(NOW - 500 * 1000).toISOString(), commentId: 'OLD' }],
    });
    expect(out.verdict).not.toBe('BLOCKED-THREADS');
  });

  // #365 — a code-review-bot review against an older commit is stale.
  test('(#365) latest coderabbit review commitOid != head → REVIEW-PENDING', () => {
    const out = computeVerdict({
      ...cleanBase,
      reviews: [{ author: 'coderabbitai', authorTypename: 'Bot', state: 'COMMENTED', submittedAt: new Date(SETTLED).toISOString(), commitOid: 'stale-old' }],
    });
    expect(out.verdict).toBe('REVIEW-PENDING');
    expect(out.evidence.staleReviews).toContain('coderabbitai');
  });

  // F3 — settle window anchored to head push: a fresh green PR is REVIEW-PENDING.
  test('(F3) reviews=[], green CI, head pushed <600s ago → REVIEW-PENDING, never CLEAN', () => {
    const out = computeVerdict({ ...cleanBase, reviews: [], headPushTimeMs: NOW - 120 * 1000, headPushKnown: true });
    expect(out.verdict).toBe('REVIEW-PENDING');
    expect(out.verdict).not.toBe('CLEAN-MERGEABLE');
    expect(out.evidence.settleRemainingMs).toBeGreaterThan(0);
  });
  test('REVIEW_REQUIRED decision → REVIEW-PENDING', () => {
    expect(computeVerdict({ ...cleanBase, reviewDecision: 'REVIEW_REQUIRED' }).verdict).toBe('REVIEW-PENDING');
  });
});

// ---------------------------------------------------------------------------
// gatherPullSignal integration (injected adapter/gh — no live GitHub)
// ---------------------------------------------------------------------------
function makeAdapter(spec = {}) {
  let readCount = 0;
  return {
    id: 'fake', kind: 'pr-state',
    async readState() {
      readCount += 1;
      const headSha = typeof spec.headSha === 'function' ? spec.headSha(readCount) : (spec.headSha || HEAD);
      return {
        headSha, state: spec.state || 'OPEN', mergeable: spec.mergeable || 'MERGEABLE',
        mergeStateStatus: spec.mergeStateStatus || 'CLEAN',
        reviewDecision: spec.reviewDecision === undefined ? null : spec.reviewDecision,
        isDraft: !!spec.isDraft, checks: spec.checks || [], threads: [],
      };
    },
    async readRequiredChecks() { if (spec.requiredThrows) throw new Error('protection'); return spec.required === undefined ? [] : spec.required; },
    async readDivergence() { return { behind: spec.behind || 0, ahead: 1 }; },
    async rerunFailedChecks() {},
    async replyToThread() {},
    async readComments() { if (spec.commentsThrow) throw new Error('threads'); return spec.threads || []; },
    async readIssueComments() { if (spec.issueCommentsThrow) throw new Error('issue comments'); return spec.issueComments || []; },
    async readReviews() { if (spec.reviewsThrow) throw new Error('reviews'); return spec.reviews || []; },
    async readHeadCommitTime() { if (spec.headTimeThrows) throw new Error('head time'); return spec.headPushTimeMs === undefined ? SETTLED : spec.headPushTimeMs; },
    async detectConflicts() { return spec.conflicts || { supported: true, conflicted: false, files: [] }; },
  };
}

const buildContext = async () => ({ pr: '123', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master', cwd: '/wt' });
const greenCi = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }];

function coderabbitThreads(n, resolved = false) {
  return Array.from({ length: n }, (_, i) => ({
    threadId: `T${i}`, path: 'lib/a.js', line: i, isResolved: resolved, isOutdated: false,
    comments: [{ author: 'coderabbitai', body: `finding ${i}`, commentId: `C${i}` }],
  }));
}

async function gather(spec) {
  const adapter = makeAdapter(spec);
  return gatherPullSignal({
    pr: '5', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
    adapter, runGh: () => '', self: 'shepherd-bot', now: NOW,
  });
}

describe('gatherPullSignal verdict integration', () => {
  // (c) core regression — 13 unresolved coderabbit threads + green checks.
  test('(c) 13 unresolved coderabbit threads: pass NOT merge-ready AND verdict BLOCKED-THREADS', async () => {
    const spec = { mergeStateStatus: 'BLOCKED', required: ['ci'], checks: greenCi, threads: coderabbitThreads(13) };
    const pass = await runShepherdPass({
      pr: '5', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter: makeAdapter(spec), self: 'shepherd-bot', dryRun: true,
    });
    expect(pass.state).not.toBe('MERGE_READY');
    expect(pass.state).toBe('NEEDS_REVIEW');

    const payload = await gather(spec);
    expect(payload.verdict).toBe('BLOCKED-THREADS');
    expect(payload.evidence.unresolvedThreadCount).toBe(13);
  });

  // (F2) an unresolved thread with NO id still counts.
  test('(F2) unresolved thread missing threadId still → BLOCKED-THREADS', async () => {
    const payload = await gather({
      mergeStateStatus: 'BLOCKED', required: ['ci'], checks: greenCi,
      threads: [{ isResolved: false, isOutdated: false, comments: [{ author: 'coderabbitai', body: 'no id here' }] }],
    });
    expect(payload.verdict).toBe('BLOCKED-THREADS');
  });

  // (F1) integration — UNKNOWN merge state never reads clean.
  test('(F1) mergeStateStatus UNKNOWN with everything else clean → verdict UNKNOWN', async () => {
    const payload = await gather({ mergeStateStatus: 'UNKNOWN', required: ['ci'], checks: greenCi });
    expect(payload.verdict).toBe('UNKNOWN');
  });

  // (F3) fresh push, green CI, no reviews → REVIEW-PENDING.
  test('(F3) green CI + head pushed <600s ago + no reviews → REVIEW-PENDING', async () => {
    const payload = await gather({ mergeStateStatus: 'CLEAN', required: ['ci'], checks: greenCi, headPushTimeMs: NOW - 120 * 1000 });
    expect(payload.verdict).toBe('REVIEW-PENDING');
  });

  // (F6) integration — a passing Sonar comment (old, settled) does not block.
  test('(F6) settled PR with a PASSING Sonar quality-gate comment → CLEAN-MERGEABLE', async () => {
    const payload = await gather({
      mergeStateStatus: 'CLEAN', required: ['ci'], checks: greenCi,
      issueComments: [{ author: 'sonarqubecloud', body: 'Quality Gate passed', createdAt: new Date(SETTLED).toISOString() }],
    });
    expect(payload.verdict).toBe('CLEAN-MERGEABLE');
  });

  // (a) #365 — stale review-at-head.
  test('(a) #365 threads resolved but coderabbit review against an older commit → REVIEW-PENDING', async () => {
    const payload = await gather({
      mergeStateStatus: 'CLEAN', required: ['ci'], checks: greenCi, threads: coderabbitThreads(2, true),
      reviews: [{ author: 'coderabbitai', authorTypename: 'Bot', state: 'COMMENTED', submittedAt: new Date(SETTLED).toISOString(), commitOid: 'stale-old' }],
    });
    expect(payload.verdict).toBe('REVIEW-PENDING');
    expect(payload.evidence.staleReviews).toContain('coderabbitai');
  });

  // (b) #353 — a bot direct issue comment (detected by mechanism: __typename Bot).
  test('(b) #353 coderabbit "Additional Comments" issue comment post-push → BLOCKED-THREADS', async () => {
    const payload = await gather({
      mergeStateStatus: 'BLOCKED', required: ['ci'], checks: greenCi, threads: [],
      headPushTimeMs: NOW - 300 * 1000,
      issueComments: [{ author: 'coderabbitai', authorTypename: 'Bot', body: 'Additional Comments (3)', createdAt: new Date(NOW - 100 * 1000).toISOString() }],
    });
    expect(payload.verdict).toBe('BLOCKED-THREADS');
  });

  // (d) fail-closed — a verdict-relevant read throws.
  test('(d) readReviews throws → verdict UNKNOWN', async () => {
    const payload = await gather({ mergeStateStatus: 'CLEAN', required: ['ci'], checks: greenCi, reviewsThrow: true });
    expect(payload.verdict).toBe('UNKNOWN');
    expect(payload.evidence.unreadable).toContain('reviews');
  });
  test('(d) readComments throws → verdict UNKNOWN', async () => {
    const payload = await gather({ mergeStateStatus: 'CLEAN', required: ['ci'], checks: greenCi, commentsThrow: true });
    expect(payload.verdict).toBe('UNKNOWN');
    expect(payload.evidence.unreadable).toContain('threads');
  });

  // (e) torn read — head oid moves across the gather.
  test('(e) head oid changes across gather → not CLEAN (UNKNOWN)', async () => {
    const payload = await gather({ headSha: (n) => `sha-${n}`, mergeStateStatus: 'CLEAN', required: ['ci'], checks: greenCi });
    expect(payload.verdict).not.toBe('CLEAN-MERGEABLE');
    expect(payload.verdict).toBe('UNKNOWN');
    expect(payload.evidence.tornRead).toBe(true);
  });

  // settled clean end-to-end.
  test('settled, green, no threads/reviews → CLEAN-MERGEABLE', async () => {
    const payload = await gather({ mergeStateStatus: 'CLEAN', required: ['ci'], checks: greenCi });
    expect(payload.verdict).toBe('CLEAN-MERGEABLE');
  });
});

// ---------------------------------------------------------------------------
// Agnostic classification — by MECHANISM, no name list, fail-closed on unknowns
// ---------------------------------------------------------------------------
describe('agnostic classification (no hardcoded bot names, fail-closed)', () => {
  // (a) an UNKNOWN bot's unresolved thread still blocks.
  test('(a) unknown bot "somenewbot[bot]" unresolved thread → BLOCKED-THREADS', async () => {
    const payload = await gather({
      mergeStateStatus: 'BLOCKED', required: ['ci'], checks: greenCi,
      threads: [{ threadId: 'X', isResolved: false, isOutdated: false, comments: [{ author: 'somenewbot[bot]', body: 'unknown-bot finding' }] }],
    });
    expect(payload.verdict).toBe('BLOCKED-THREADS');
  });

  // (b) an UNKNOWN bot's direct comment post-head-push is not CLEAN (detected via
  // __typename Bot, not on the suppression allowlist → actionable).
  test('(b) unknown bot direct comment newer than head push → not CLEAN', async () => {
    const payload = await gather({
      mergeStateStatus: 'BLOCKED', required: ['ci'], checks: greenCi, threads: [],
      headPushTimeMs: NOW - 300 * 1000,
      issueComments: [{ author: 'brandnewbot', authorTypename: 'Bot', body: 'found 2 issues', createdAt: new Date(NOW - 100 * 1000).toISOString() }],
    });
    expect(payload.verdict).not.toBe('CLEAN-MERGEABLE');
    expect(payload.verdict).toBe('BLOCKED-THREADS');
  });

  // (c) a failing check from an UNNAMED app → BLOCKED-CHECKS (required-check path,
  // zero name knowledge).
  test('(c) failing required check from an unnamed app → BLOCKED-CHECKS', async () => {
    const payload = await gather({
      mergeStateStatus: 'BLOCKED', required: ['Some Vendor Gate'],
      checks: [{ name: 'Some Vendor Gate', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    expect(payload.verdict).toBe('BLOCKED-CHECKS');
  });

  // (d) an acknowledged/suppressed informational bot comment does NOT falsely
  // block: a suppressed status bot (vercel) preview comment on an otherwise-clean,
  // settled PR stays CLEAN.
  test('(d) suppressed status-bot informational comment on a settled clean PR → CLEAN-MERGEABLE', async () => {
    const payload = await gather({
      mergeStateStatus: 'CLEAN', required: ['ci'], checks: greenCi,
      issueComments: [{ author: 'vercel[bot]', authorTypename: 'Bot', body: 'Preview ready ✅', createdAt: new Date(SETTLED).toISOString() }],
    });
    expect(payload.verdict).toBe('CLEAN-MERGEABLE');
  });

  // A failing quality-gate COMMENT from a status bot (via buildBotStatusBlockers)
  // blocks under CHECKS, not threads.
  test('failing bot-status quality-gate comment → BLOCKED-CHECKS (not THREADS)', async () => {
    const payload = await gather({
      mergeStateStatus: 'BLOCKED', required: ['ci'], checks: greenCi,
      issueComments: [{ author: 'sonarqubecloud', authorTypename: 'Bot', body: 'Quality Gate failed', createdAt: new Date(NOW - 100 * 1000).toISOString() }],
    });
    expect(payload.verdict).toBe('BLOCKED-CHECKS');
  });
});

// ---------------------------------------------------------------------------
// (g) output contract — handler prints JSON on stdout via the registry
// ---------------------------------------------------------------------------
describe('(g) output contract: --pull --json serializes the verdict to result.output', () => {
  test('--pull --json through the registry → result.output parses as JSON carrying the verdict', async () => {
    const commands = loadCommands(path.join(__dirname, '..', 'lib', 'commands')).commands;
    const adapter = makeAdapter({ mergeStateStatus: 'BLOCKED', required: ['ci'], checks: greenCi, threads: coderabbitThreads(2) });
    const result = await executeCommand(
      commands, 'shepherd', ['123', '--pull', '--json'], {}, '/wt',
      { commandOpts: { adapter, buildContext, gh: () => '', self: 'shepherd-bot' } },
    );
    expect(typeof result.output).toBe('string');
    const parsed = JSON.parse(result.output);
    expect(parsed).toHaveProperty('state');
    expect(parsed).toHaveProperty('verdict');
    expect(parsed).toHaveProperty('evidence');
    expect(parsed.verdict).toBe('BLOCKED-THREADS');
  });

  test('--bundle --json handler returns output that JSON-parses to the bundle', async () => {
    const bundle = { threads: [], mergeState: 'BLOCKED', checks: [] };
    const result = await shepherdCmd.handler(
      ['123', '--bundle', '--json'], {}, '/wt',
      { adapter: makeAdapter(), buildContext, gatherBundle: async () => bundle },
    );
    expect(result.bundle).toBe(bundle);
    expect(JSON.parse(result.output)).toEqual(bundle);
  });
});
