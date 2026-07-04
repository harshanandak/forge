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
      { name: 'ci', conclusion: 'SUCCESS' },
      { name: 'lint', conclusion: 'SUCCESS' },
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
});
