'use strict';

const { describe, test, expect } = require('bun:test');

const { evaluateMergeRules } = require('../lib/merge-rules');

const NOW = Date.parse('2026-07-04T12:00:00Z');
const minAgo = (m) => new Date(NOW - m * 60_000).toISOString();

/**
 * A PR context in which every built-in rule is satisfied. Individual tests
 * override single fields to drive one rule to fail at a time.
 */
function greenContext(overrides = {}) {
  return {
    checks: [
      { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    requiredChecksKnown: true,
    unresolvedThreads: 0,
    behindBase: 0,
    approvals: [{ author: 'alice' }, { author: 'bob' }],
    comments: [
      { author: 'alice', at: minAgo(60) },
      { author: 'bob', at: minAgo(15) },
    ],
    lastActivityAt: minAgo(15),
    conflicting: false,
    isDraft: false,
    state: 'OPEN',
    now: NOW,
    ...overrides,
  };
}

describe('evaluateMergeRules — pure conditional auto-merge evaluator', () => {
  // ---- The five RED-first cases from the feature brief ----

  test('(a) settle_min:10 is UNMET when the last comment is only 3 minutes old', () => {
    const ctx = greenContext({ comments: [{ author: 'bob', at: minAgo(3) }] });
    const { allowed, unmet } = evaluateMergeRules(ctx, ['settle_min:10']);
    expect(allowed).toBe(false);
    expect(unmet).toHaveLength(1);
    expect(unmet[0].rule).toContain('settle_min');
    expect(typeof unmet[0].reason).toBe('string');
  });

  test('(b) checks_green + threads_resolved + settle_min:10 all satisfied → allowed', () => {
    const { allowed, unmet } = evaluateMergeRules(
      greenContext(),
      ['checks_green', 'threads_resolved', 'settle_min:10'],
    );
    expect(unmet).toEqual([]);
    expect(allowed).toBe(true);
  });

  test('(c) not_commented_by:[bot] FAILS when bot is the last commenter', () => {
    const ctx = greenContext({
      comments: [
        { author: 'alice', at: minAgo(30) },
        { author: 'bot', at: minAgo(2) },
      ],
    });
    const { allowed, unmet } = evaluateMergeRules(ctx, [{ not_commented_by: ['bot'] }]);
    expect(allowed).toBe(false);
    expect(unmet[0].rule).toContain('not_commented_by');
  });

  test('(d) any_of passes if ONE member passes (even though another member fails)', () => {
    const ctx = greenContext({ behindBase: 5 }); // not_behind would fail
    const { allowed, unmet } = evaluateMergeRules(ctx, [{ any_of: ['not_behind', 'checks_green'] }]);
    expect(unmet).toEqual([]);
    expect(allowed).toBe(true);
  });

  test('(e) unknown rule type → NOT allowed (fail-closed)', () => {
    const { allowed, unmet } = evaluateMergeRules(greenContext(), ['definitely_not_a_rule']);
    expect(allowed).toBe(false);
    expect(unmet[0].reason).toMatch(/unknown/i);
  });

  // ---- Complementary coverage of the built-in rule set ----

  test('not_commented_by:[bot] PASSES when a human commented last', () => {
    const ctx = greenContext({
      comments: [
        { author: 'bot', at: minAgo(30) },
        { author: 'alice', at: minAgo(2) },
      ],
    });
    expect(evaluateMergeRules(ctx, [{ not_commented_by: ['bot'] }]).allowed).toBe(true);
  });

  test('any_of fails (fail-closed) when NO member passes', () => {
    const ctx = greenContext({ behindBase: 5, requiredChecksKnown: false });
    const { allowed, unmet } = evaluateMergeRules(ctx, [{ any_of: ['not_behind', 'checks_green'] }]);
    expect(allowed).toBe(false);
    expect(unmet[0].rule).toContain('any_of');
  });

  test('an empty ruleset is vacuously allowed (the command layer gates on `enabled`)', () => {
    expect(evaluateMergeRules(greenContext(), [])).toEqual({ allowed: true, unmet: [] });
  });

  test('checks_green is fail-closed when the required-check set is unknown', () => {
    const { allowed, unmet } = evaluateMergeRules(greenContext({ requiredChecksKnown: false }), ['checks_green']);
    expect(allowed).toBe(false);
    expect(unmet[0].rule).toContain('checks_green');
  });

  test('checks_green fails when any check is not green', () => {
    const ctx = greenContext({ checks: [{ name: 'ci', conclusion: 'FAILURE' }] });
    expect(evaluateMergeRules(ctx, ['checks_green']).allowed).toBe(false);
  });

  test('checks_green requires COMPLETED plus SUCCESS and rejects success-like conclusions', () => {
    for (const check of [
      { name: 'ci', conclusion: 'SUCCESS' },
      { name: 'ci', status: 'IN_PROGRESS', conclusion: 'SUCCESS' },
      { name: 'ci', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { name: 'ci', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { name: 'ci', status: 'COMPLETED', conclusion: 'PASS' },
    ]) {
      expect(evaluateMergeRules(greenContext({ checks: [check] }), ['checks_green']).allowed).toBe(false);
    }
  });

  test('checks_green { ignore } exempts a named failing check but still blocks on OTHER failures', () => {
    const oneBadIgnored = greenContext({
      checks: [
        { name: 'coverage', conclusion: 'FAILURE' },
        { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    });
    // coverage is exempt; every other check (ci) is green → allowed.
    expect(evaluateMergeRules(oneBadIgnored, [{ checks_green: { ignore: ['coverage'] } }]).allowed).toBe(true);

    const anotherAlsoBad = greenContext({
      checks: [
        { name: 'coverage', conclusion: 'FAILURE' },
        { name: 'ci', conclusion: 'FAILURE' },
      ],
    });
    // coverage exempt, but ci (not exempt) still fails → unmet.
    expect(evaluateMergeRules(anotherAlsoBad, [{ checks_green: { ignore: ['coverage'] } }]).allowed).toBe(false);
  });

  test('checks_green { ignore: [] } behaves like bare checks_green (strict)', () => {
    expect(evaluateMergeRules(greenContext(), [{ checks_green: { ignore: [] } }]).allowed).toBe(true);
    const bad = greenContext({ checks: [{ name: 'ci', conclusion: 'FAILURE' }] });
    expect(evaluateMergeRules(bad, [{ checks_green: { ignore: [] } }]).allowed).toBe(false);
  });

  test('checks_green { only } requires ONLY the listed checks to be SUCCESS', () => {
    const ctx = greenContext({
      checks: [
        { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'coverage', conclusion: 'FAILURE' },
      ],
    });
    // only ci matters; coverage failure is ignored → allowed.
    expect(evaluateMergeRules(ctx, [{ checks_green: { only: ['ci'] } }]).allowed).toBe(true);
    // only coverage matters; it fails → unmet.
    expect(evaluateMergeRules(ctx, [{ checks_green: { only: ['coverage'] } }]).allowed).toBe(false);
    // a named check that is missing → unmet (must be present AND green).
    expect(evaluateMergeRules(ctx, [{ checks_green: { only: ['nonexistent'] } }]).allowed).toBe(false);
  });

  test('checks_green with BOTH ignore and only is malformed → fail-closed', () => {
    const { allowed, unmet } = evaluateMergeRules(greenContext(), [{ checks_green: { ignore: ['a'], only: ['b'] } }]);
    expect(allowed).toBe(false);
    expect(unmet[0].rule).toContain('checks_green');
    expect(unmet[0].reason).toMatch(/ignore.*only|only.*ignore|combine|malformed|both/i);
  });

  test('threads_resolved fails with open threads (number OR array form)', () => {
    expect(evaluateMergeRules(greenContext({ unresolvedThreads: 2 }), ['threads_resolved']).allowed).toBe(false);
    expect(evaluateMergeRules(greenContext({ unresolvedThreads: [{}, {}] }), ['threads_resolved']).allowed).toBe(false);
    expect(evaluateMergeRules(greenContext({ unresolvedThreads: undefined }), ['threads_resolved']).allowed).toBe(false);
  });

  test('min_approvals:2 requires two approvals', () => {
    expect(evaluateMergeRules(greenContext({ approvals: [{ author: 'alice' }] }), ['min_approvals:2']).allowed).toBe(false);
    expect(evaluateMergeRules(greenContext(), ['min_approvals:2']).allowed).toBe(true);
  });

  test('approved_by requires the named reviewer to have approved', () => {
    expect(evaluateMergeRules(greenContext(), [{ approved_by: ['carol'] }]).allowed).toBe(false);
    expect(evaluateMergeRules(greenContext(), [{ approved_by: ['alice'] }]).allowed).toBe(true);
  });

  test('not_behind fails when the branch is behind base', () => {
    expect(evaluateMergeRules(greenContext({ behindBase: 3 }), ['not_behind']).allowed).toBe(false);
    expect(evaluateMergeRules(greenContext({ behindBase: true }), ['not_behind']).allowed).toBe(false);
    expect(evaluateMergeRules(greenContext({ behindBase: undefined }), ['not_behind']).allowed).toBe(false);
  });

  test('no_conflicts fails on a conflicting (DIRTY) branch and is fail-closed when unknown', () => {
    expect(evaluateMergeRules(greenContext({ conflicting: true }), ['no_conflicts']).allowed).toBe(false);
    expect(evaluateMergeRules(greenContext({ conflicting: undefined }), ['no_conflicts']).allowed).toBe(false);
    expect(evaluateMergeRules(greenContext({ conflicting: false }), ['no_conflicts']).allowed).toBe(true);
  });

  test('not_draft fails on a draft PR and is fail-closed when unknown', () => {
    expect(evaluateMergeRules(greenContext({ isDraft: true }), ['not_draft']).allowed).toBe(false);
    expect(evaluateMergeRules(greenContext({ isDraft: undefined }), ['not_draft']).allowed).toBe(false);
    expect(evaluateMergeRules(greenContext({ isDraft: false }), ['not_draft']).allowed).toBe(true);
  });

  test('idle_min:30 requires 30 minutes since the last activity', () => {
    expect(evaluateMergeRules(greenContext({ lastActivityAt: minAgo(5) }), ['idle_min:30']).allowed).toBe(false);
    expect(evaluateMergeRules(greenContext({ lastActivityAt: minAgo(45) }), ['idle_min:30']).allowed).toBe(true);
  });

  test('the `not:` wrapper inverts an inner rule', () => {
    // not_behind passes (behind 0) → not{not_behind} must fail
    expect(evaluateMergeRules(greenContext(), [{ not: 'not_behind' }]).allowed).toBe(false);
    // not_behind fails (behind 5) → not{not_behind} must pass
    expect(evaluateMergeRules(greenContext({ behindBase: 5 }), [{ not: 'not_behind' }]).allowed).toBe(true);
  });

  test('last_comment_by names the required last commenter', () => {
    expect(evaluateMergeRules(greenContext(), [{ last_comment_by: 'bob' }]).allowed).toBe(true);
    expect(evaluateMergeRules(greenContext(), [{ last_comment_by: 'alice' }]).allowed).toBe(false);
  });

  test('a malformed multi-key rule object is fail-closed', () => {
    const { allowed, unmet } = evaluateMergeRules(greenContext(), [{ checks_green: true, not_behind: true }]);
    expect(allowed).toBe(false);
    expect(unmet[0].reason).toMatch(/one key|malformed|exactly/i);
  });

  test('login matching is case-insensitive', () => {
    const ctx = greenContext({ comments: [{ author: 'BoT', at: minAgo(2) }] });
    expect(evaluateMergeRules(ctx, [{ not_commented_by: ['bot'] }]).allowed).toBe(false);
  });

  test('verdict_clean requires a complete MERGE_READY verdict bound to the exact current head', () => {
    const head = '1'.repeat(40);
    const ctx = greenContext({
      headSha: head,
      expectedHeadSha: head,
      baseSha: 'a'.repeat(40),
      expectedBaseSha: 'a'.repeat(40),
      repository: 'owner/repo',
      expectedRepository: 'owner/repo',
      prNumber: 42,
      expectedPrNumber: 42,
      verdict: {
        state: 'MERGE_READY', repository: 'owner/repo', prNumber: 42,
        headSha: head, baseSha: 'a'.repeat(40), reasons: [],
      },
    });
    expect(evaluateMergeRules(ctx, ['verdict_clean']).allowed).toBe(true);

    for (const verdict of [
      { state: 'BLOCKED', headSha: head, baseSha: 'a'.repeat(40), reasons: [{ code: 'checks' }] },
      { state: 'MERGE_READY', headSha: '2'.repeat(40), baseSha: 'a'.repeat(40), reasons: [] },
      { state: 'MERGE_READY', headSha: head, baseSha: 'a'.repeat(40), reasons: [{ code: 'contradiction' }] },
      null,
    ]) {
      expect(evaluateMergeRules({ ...ctx, verdict }, ['verdict_clean']).allowed).toBe(false);
    }
  });

  test('verdict_clean fails closed when the caller head lease is absent or malformed', () => {
    const head = '1'.repeat(40);
    const verdict = {
      state: 'MERGE_READY', repository: 'owner/repo', prNumber: 42,
      headSha: head, baseSha: 'a'.repeat(40), reasons: [],
    };
    expect(evaluateMergeRules(greenContext({ verdict, headSha: head }), ['verdict_clean']).allowed).toBe(false);
    expect(evaluateMergeRules(greenContext({ verdict, expectedHeadSha: head }), ['verdict_clean']).allowed).toBe(false);
    expect(evaluateMergeRules(greenContext({ verdict, headSha: 'short', expectedHeadSha: 'short' }), ['verdict_clean']).allowed).toBe(false);
    expect(evaluateMergeRules({
      ...greenContext(),
      headSha: head,
      expectedHeadSha: head,
      baseSha: 'a'.repeat(40),
      expectedBaseSha: 'a'.repeat(40),
      verdict: { ...verdict, baseSha: 'short' },
    }, ['verdict_clean']).allowed).toBe(false);
  });

  test('verdict_clean requires the observed, expected, and verdict base SHAs to match exactly', () => {
    const head = '1'.repeat(40);
    const base = 'a'.repeat(40);
    const ctx = greenContext({
      headSha: head,
      expectedHeadSha: head,
      baseSha: base,
      expectedBaseSha: base,
      repository: 'owner/repo',
      expectedRepository: 'owner/repo',
      prNumber: 42,
      expectedPrNumber: 42,
      verdict: {
        state: 'MERGE_READY', repository: 'owner/repo', prNumber: 42,
        headSha: head, baseSha: base, reasons: [],
      },
    });
    expect(evaluateMergeRules(ctx, ['verdict_clean']).allowed).toBe(true);
    for (const mutation of [
      { expectedBaseSha: undefined },
      { baseSha: undefined },
      { expectedBaseSha: 'b'.repeat(40) },
      { verdict: { ...ctx.verdict, baseSha: 'b'.repeat(40) } },
    ]) {
      expect(evaluateMergeRules({ ...ctx, ...mutation }, ['verdict_clean']).allowed).toBe(false);
    }
  });

  test('verdict_clean rejects cross-repository and cross-PR replay', () => {
    const head = '1'.repeat(40);
    const base = 'a'.repeat(40);
    const ctx = greenContext({
      repository: 'owner/repo',
      expectedRepository: 'owner/repo',
      prNumber: 42,
      expectedPrNumber: 42,
      headSha: head,
      expectedHeadSha: head,
      baseSha: base,
      expectedBaseSha: base,
      verdict: {
        state: 'MERGE_READY', repository: 'owner/repo', prNumber: 42,
        headSha: head, baseSha: base, reasons: [],
      },
    });
    expect(evaluateMergeRules(ctx, ['verdict_clean']).allowed).toBe(true);
    for (const mutation of [
      { expectedRepository: 'other/repo' },
      { expectedPrNumber: 43 },
      { verdict: { ...ctx.verdict, repository: 'other/repo' } },
      { verdict: { ...ctx.verdict, prNumber: 43 } },
    ]) {
      expect(evaluateMergeRules({ ...ctx, ...mutation }, ['verdict_clean']).allowed).toBe(false);
    }
  });

  test('verdict_clean is descriptor-safe for accessors and hostile or revoked proxies', () => {
    let getterCalls = 0;
    const head = '1'.repeat(40);
    const base = 'a'.repeat(40);
    const verdict = {
      state: 'MERGE_READY', repository: 'owner/repo', prNumber: 42,
      headSha: head, baseSha: base, reasons: [],
    };
    const context = greenContext({
      repository: 'owner/repo', expectedRepository: 'owner/repo',
      prNumber: 42, expectedPrNumber: 42,
      headSha: head, expectedHeadSha: head, baseSha: base, expectedBaseSha: base,
      verdict,
    });

    const accessor = { ...context };
    Object.defineProperty(accessor, 'verdict', {
      enumerable: true,
      get() { getterCalls += 1; throw new Error('getter must not run'); },
    });
    expect(evaluateMergeRules(accessor, ['verdict_clean']).allowed).toBe(false);

    const hostileContext = new Proxy(context, {
      get() { getterCalls += 1; throw new Error('get trap must not run'); },
      ownKeys() { getterCalls += 1; throw new Error('ownKeys trap must not run'); },
    });
    expect(evaluateMergeRules(hostileContext, ['verdict_clean']).allowed).toBe(false);

    const hostileVerdict = new Proxy(verdict, {
      get() { getterCalls += 1; throw new Error('nested get trap must not run'); },
      ownKeys() { getterCalls += 1; throw new Error('nested ownKeys trap must not run'); },
    });
    expect(evaluateMergeRules({ ...context, verdict: hostileVerdict }, ['verdict_clean']).allowed).toBe(false);

    const revoked = Proxy.revocable(context, {});
    revoked.revoke();
    expect(evaluateMergeRules(revoked.proxy, ['verdict_clean']).allowed).toBe(false);
    expect(getterCalls).toBe(0);
  });
});
