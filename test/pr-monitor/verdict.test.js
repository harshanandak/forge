'use strict';

const { describe, test, expect } = require('bun:test');
const { VERDICT_STATES, evaluateCurrentHeadVerdict } = require('../../lib/pr-monitor/verdict');

const HEAD = '1'.repeat(40);
const OTHER_HEAD = '2'.repeat(40);
const BASE = 'a'.repeat(40);
const REPOSITORY = 'owner/repo';
const PR_NUMBER = 42;

function completeEvidence(overrides = {}) {
  return {
    expectedHeadSha: HEAD,
    expectedBaseSha: BASE,
    expectedRepository: REPOSITORY,
    expectedPrNumber: PR_NUMBER,
    prNumber: PR_NUMBER,
    head: { sha: HEAD, repository: REPOSITORY, source: 'same-repository', acquired: true },
    base: { sha: BASE, repository: REPOSITORY },
    ancestry: {
      complete: true, headSha: HEAD, baseSha: BASE,
      containsBase: true, behindBy: 0, conflicting: false,
    },
    checks: {
      complete: true,
      headSha: HEAD,
      required: [{ name: 'tests', appId: 1 }, { name: 'lint', appId: null }],
      observations: [
        { name: 'tests', appId: 1, status: 'COMPLETED', conclusion: 'SUCCESS', headSha: HEAD },
        { name: 'lint', appId: null, status: 'COMPLETED', conclusion: 'SUCCESS', headSha: HEAD },
      ],
    },
    review: {
      complete: true, headSha: HEAD, required: false, decision: 'NONE', conflicting: false,
    },
    threads: { complete: true, headSha: HEAD, items: [] },
    ...overrides,
  };
}

function expectState(input, state, reason) {
  const result = evaluateCurrentHeadVerdict(input);
  expect(result.state).toBe(state);
  if (reason) expect(result.reasons.map((item) => item.code)).toContain(reason);
  return result;
}

describe('evaluateCurrentHeadVerdict', () => {
  test('authorizes only complete evidence bound to the exact expected head and base', () => {
    expect(evaluateCurrentHeadVerdict(completeEvidence())).toEqual({
      state: VERDICT_STATES.MERGE_READY,
      repository: REPOSITORY,
      prNumber: PR_NUMBER,
      headSha: HEAD,
      baseSha: BASE,
      reasons: [],
    });
  });

  test('binds repository and PR identity and rejects cross-authority replay', () => {
    expectState(completeEvidence({ expectedRepository: 'other/repo' }), VERDICT_STATES.STALE, 'repository_mismatch');
    expectState(completeEvidence({ expectedPrNumber: 43 }), VERDICT_STATES.STALE, 'pr_number_mismatch');
    expectState(completeEvidence({ expectedRepository: undefined }), VERDICT_STATES.INCOMPLETE, 'invalid_expected_repository');
    expectState(completeEvidence({ prNumber: '42' }), VERDICT_STATES.INCOMPLETE, 'invalid_pr_number');
  });

  test('fails closed when the expected, observed, or base SHA is absent or malformed', () => {
    expectState(completeEvidence({ expectedHeadSha: 'short' }), VERDICT_STATES.INCOMPLETE, 'invalid_expected_head');
    expectState(completeEvidence({ expectedBaseSha: 'short' }), VERDICT_STATES.INCOMPLETE, 'invalid_expected_base');
    expectState(completeEvidence({ head: { ...completeEvidence().head, sha: null } }), VERDICT_STATES.INCOMPLETE, 'invalid_observed_head');
    expectState(completeEvidence({ base: { sha: '', repository: 'owner/repo' } }), VERDICT_STATES.INCOMPLETE, 'invalid_base');
  });

  test('leases the exact base SHA and classifies observed base drift as stale', () => {
    expectState(completeEvidence({ expectedBaseSha: OTHER_HEAD }), VERDICT_STATES.STALE, 'base_mismatch');
    expectState(completeEvidence({ expectedBaseSha: undefined }), VERDICT_STATES.INCOMPLETE, 'invalid_expected_base');
  });

  test('classifies a moved head or stale surface as STALE, never merge-ready', () => {
    expectState(completeEvidence({ head: { ...completeEvidence().head, sha: OTHER_HEAD } }), VERDICT_STATES.STALE, 'head_mismatch');
    expectState(completeEvidence({ checks: { ...completeEvidence().checks, headSha: OTHER_HEAD } }), VERDICT_STATES.STALE, 'checks_stale');
  });

  test('requires complete current ancestry and blocks behind, divergent, or conflicting heads', () => {
    expectState(completeEvidence({ ancestry: { ...completeEvidence().ancestry, complete: false } }), VERDICT_STATES.INCOMPLETE, 'ancestry_incomplete');
    expectState(completeEvidence({ ancestry: { ...completeEvidence().ancestry, behindBy: 1 } }), VERDICT_STATES.BLOCKED, 'head_behind_base');
    expectState(completeEvidence({ ancestry: { ...completeEvidence().ancestry, containsBase: false } }), VERDICT_STATES.BLOCKED, 'base_not_ancestor');
    expectState(completeEvidence({ ancestry: { ...completeEvidence().ancestry, conflicting: true } }), VERDICT_STATES.BLOCKED, 'merge_conflict');
  });

  test('requires an external or fork head to be explicitly acquired before ancestry is trusted', () => {
    for (const source of ['fork', 'external']) {
      const externalHead = { ...completeEvidence().head, repository: 'contributor/fork', source };
      expectState(completeEvidence({ head: { ...externalHead, acquired: false } }), VERDICT_STATES.INCOMPLETE, 'external_head_not_acquired');
      expectState(completeEvidence({ head: { ...externalHead, acquired: true } }), VERDICT_STATES.MERGE_READY);
    }
  });

  test('derives head source from normalized repository identity and rejects contradictory claims', () => {
    expectState(completeEvidence({
      head: { ...completeEvidence().head, repository: ' OWNER/REPO ', source: 'same-repository' },
    }), VERDICT_STATES.MERGE_READY);
    expectState(completeEvidence({
      head: { ...completeEvidence().head, source: 'fork' },
    }), VERDICT_STATES.INCOMPLETE, 'head_source_conflict');
    expectState(completeEvidence({
      head: {
        ...completeEvidence().head, repository: 'contributor/fork', source: 'same-repository', acquired: true,
      },
    }), VERDICT_STATES.INCOMPLETE, 'head_source_conflict');
    expectState(completeEvidence({
      head: { ...completeEvidence().head, repository: 'contributor/fork', source: 'fork', acquired: true },
    }), VERDICT_STATES.MERGE_READY);
  });

  test('requires every protected check exactly once and literally COMPLETED/SUCCESS', () => {
    const checks = completeEvidence().checks;
    expectState(completeEvidence({ checks: { ...checks, observations: checks.observations.slice(0, 1) } }), VERDICT_STATES.BLOCKED, 'required_check_missing');
    for (const observation of [
      { status: 'IN_PROGRESS', conclusion: null },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
      { status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { status: 'COMPLETED', conclusion: 'SKIPPED' },
    ]) {
      expectState(completeEvidence({ checks: {
        ...checks,
        observations: [{ ...checks.observations[0], ...observation }, checks.observations[1]],
      } }), VERDICT_STATES.BLOCKED, 'required_check_not_successful');
    }
  });

  test('ignores neutral and skipped optional checks', () => {
    const checks = completeEvidence().checks;
    const result = evaluateCurrentHeadVerdict(completeEvidence({ checks: {
      ...checks,
      observations: [
        ...checks.observations,
        { name: 'coverage', appId: 9, status: 'COMPLETED', conclusion: 'NEUTRAL', headSha: HEAD },
        { name: 'preview', appId: 10, status: 'COMPLETED', conclusion: 'SKIPPED', headSha: HEAD },
      ],
    } }));
    expect(result.state).toBe(VERDICT_STATES.MERGE_READY);
  });

  test('fails closed on incomplete, malformed, stale, or conflicting check evidence', () => {
    const checks = completeEvidence().checks;
    expectState(completeEvidence({ checks: { ...checks, complete: false } }), VERDICT_STATES.INCOMPLETE, 'checks_incomplete');
    expectState(completeEvidence({ checks: {
      ...checks, required: [{ name: 'tests', appId: 1 }, { name: 'tests', appId: 2 }],
    } }), VERDICT_STATES.INCOMPLETE, 'required_policy_conflict');
    expectState(completeEvidence({ checks: {
      ...checks, observations: [...checks.observations, { ...checks.observations[0], conclusion: 'FAILURE' }],
    } }), VERDICT_STATES.INCOMPLETE, 'check_observation_conflict');
    expectState(completeEvidence({ checks: {
      ...checks, observations: [{ ...checks.observations[0], headSha: OTHER_HEAD }, checks.observations[1]],
    } }), VERDICT_STATES.STALE, 'check_observation_stale');
  });

  test('requires complete current review and thread evidence', () => {
    expectState(completeEvidence({ review: { ...completeEvidence().review, complete: false } }), VERDICT_STATES.INCOMPLETE, 'review_incomplete');
    expectState(completeEvidence({ threads: { ...completeEvidence().threads, complete: false } }), VERDICT_STATES.INCOMPLETE, 'threads_incomplete');
    expectState(completeEvidence({ threads: { ...completeEvidence().threads, headSha: OTHER_HEAD } }), VERDICT_STATES.STALE, 'threads_stale');
  });

  test('blocks unresolved current threads, changes requested, and absent required approval', () => {
    expectState(completeEvidence({ threads: {
      ...completeEvidence().threads, items: [{ id: 't1', resolved: false, outdated: false }],
    } }), VERDICT_STATES.BLOCKED, 'unresolved_threads');
    expectState(completeEvidence({ review: {
      ...completeEvidence().review, decision: 'CHANGES_REQUESTED',
    } }), VERDICT_STATES.BLOCKED, 'changes_requested');
    expectState(completeEvidence({ review: {
      ...completeEvidence().review, required: true, decision: 'REVIEW_REQUIRED',
    } }), VERDICT_STATES.BLOCKED, 'approval_missing');
    expectState(completeEvidence({ review: {
      ...completeEvidence().review, required: true, decision: 'APPROVED',
    } }), VERDICT_STATES.MERGE_READY);
  });

  test('fails closed when evidence claims mutually incompatible review or thread states', () => {
    expectState(completeEvidence({ review: {
      ...completeEvidence().review, conflicting: true,
    } }), VERDICT_STATES.INCOMPLETE, 'review_state_conflict');
    expectState(completeEvidence({ threads: {
      ...completeEvidence().threads,
      items: [
        { id: 't1', resolved: true, outdated: false },
        { id: 't1', resolved: false, outdated: false },
      ],
    } }), VERDICT_STATES.INCOMPLETE, 'thread_state_conflict');
  });

  test('requires an explicit boolean review conflict signal and rejects policy contradictions', () => {
    const review = completeEvidence().review;
    expectState(completeEvidence({
      review: { ...review, conflicting: undefined },
    }), VERDICT_STATES.INCOMPLETE, 'review_malformed');
    expectState(completeEvidence({
      review: { ...review, conflicting: 'false' },
    }), VERDICT_STATES.INCOMPLETE, 'review_malformed');
    expectState(completeEvidence({
      review: { ...review, required: false, decision: 'REVIEW_REQUIRED' },
    }), VERDICT_STATES.INCOMPLETE, 'review_state_conflict');
    expectState(completeEvidence({
      review: { ...review, required: false, decision: 'NONE', conflicting: false },
    }), VERDICT_STATES.MERGE_READY);
  });

  test('accepts an optional approval because it does not conflict with a non-required policy', () => {
    expectState(completeEvidence({ review: {
      ...completeEvidence().review, required: false, decision: 'APPROVED',
    } }), VERDICT_STATES.MERGE_READY);
  });

  test('is descriptor-safe for root/nested accessors and hostile or revoked proxies', () => {
    let getterCalls = 0;
    const accessorRoot = { ...completeEvidence() };
    Object.defineProperty(accessorRoot, 'expectedHeadSha', {
      enumerable: true,
      get() { getterCalls += 1; throw new Error('getter must not run'); },
    });
    expect(evaluateCurrentHeadVerdict(accessorRoot).state).toBe(VERDICT_STATES.INCOMPLETE);

    const hostileHead = new Proxy(completeEvidence().head, {
      get() { getterCalls += 1; throw new Error('get trap must not run'); },
      ownKeys() { getterCalls += 1; throw new Error('ownKeys trap must not run'); },
    });
    expect(evaluateCurrentHeadVerdict(completeEvidence({ head: hostileHead })).state)
      .toBe(VERDICT_STATES.INCOMPLETE);

    const hostileRoot = new Proxy(completeEvidence(), {
      get() { getterCalls += 1; throw new Error('root get trap must not run'); },
      ownKeys() { getterCalls += 1; throw new Error('root ownKeys trap must not run'); },
    });
    expect(evaluateCurrentHeadVerdict(hostileRoot).state).toBe(VERDICT_STATES.INCOMPLETE);

    const nestedAccessor = { ...completeEvidence().review };
    Object.defineProperty(nestedAccessor, 'decision', {
      enumerable: true,
      get() { getterCalls += 1; throw new Error('nested getter must not run'); },
    });
    expect(evaluateCurrentHeadVerdict(completeEvidence({ review: nestedAccessor })).state)
      .toBe(VERDICT_STATES.INCOMPLETE);

    const revoked = Proxy.revocable(completeEvidence(), {});
    revoked.revoke();
    expect(evaluateCurrentHeadVerdict(revoked.proxy).state).toBe(VERDICT_STATES.INCOMPLETE);
    expect(getterCalls).toBe(0);
  });

  test('canonicalizes conflicting duplicate checks independent of input order', () => {
    const checks = completeEvidence().checks;
    const success = checks.observations[0];
    const failure = { ...success, conclusion: 'FAILURE' };
    const evaluate = (duplicates) => evaluateCurrentHeadVerdict(completeEvidence({
      checks: { ...checks, observations: [...duplicates, checks.observations[1]] },
    }));
    const forward = evaluate([success, failure]);
    const reverse = evaluate([failure, success]);
    expect(forward).toEqual(reverse);
    expect(forward.state).toBe(VERDICT_STATES.INCOMPLETE);
    expect(forward.reasons.map((item) => item.code)).toContain('check_observation_conflict');
    expect(forward.reasons.map((item) => item.code)).not.toContain('required_check_not_successful');
    expect(forward.reasons.map((item) => item.code)).not.toContain('required_check_missing');
  });

  test('canonicalizes conflicting duplicate threads independent of input order', () => {
    const resolved = { id: 't1', resolved: true, outdated: false };
    const unresolved = { id: 't1', resolved: false, outdated: false };
    const evaluate = (items) => evaluateCurrentHeadVerdict(completeEvidence({
      threads: { ...completeEvidence().threads, items },
    }));
    const forward = evaluate([resolved, unresolved]);
    const reverse = evaluate([unresolved, resolved]);
    expect(forward).toEqual(reverse);
    expect(forward.state).toBe(VERDICT_STATES.INCOMPLETE);
    expect(forward.reasons.map((item) => item.code)).toContain('thread_state_conflict');
    expect(forward.reasons.map((item) => item.code)).not.toContain('unresolved_threads');
  });
});
