'use strict';

const { describe, test, expect } = require('bun:test');

const {
  decideAutoActions,
  decideUpdateBranch,
  decideRerun,
  runIdFromUrl,
  decideBoundedAutoActions,
  AUTO_ACTION_STATUS,
} = require('../../lib/pr-monitor/auto-actions');

/** An otherwise-clean-behind payload; override any field per test. */
function behindPayload(over = {}) {
  return {
    pr: '1',
    verdict: 'BEHIND',
    evidence: { unreadable: [], tornRead: false, behind: 2 },
    draft: false,
    behind: 2,
    blockers: [{ type: 'behind', detail: 'Branch is 2 commit(s) behind base — update/rebase.' }],
    requiredChecks: {},
    failures: [],
    ...over,
  };
}

describe('decideUpdateBranch — the otherwise-clean-behind gate', () => {
  test('BEHIND + clean → update', () => {
    const d = decideUpdateBranch(behindPayload());
    expect(d.should).toBe(true);
  });

  test('BEHIND + failing required check → NO update', () => {
    const d = decideUpdateBranch(behindPayload({
      blockers: [
        { type: 'behind', detail: 'behind' },
        { type: 'check-failing', detail: 'Required check(s) failing: test' },
      ],
      requiredChecks: { failing: ['test'] },
    }));
    expect(d.should).toBe(false);
    expect(d.reason).toContain('check-failing');
  });

  test('BEHIND + unresolved threads → NO update', () => {
    const d = decideUpdateBranch(behindPayload({
      blockers: [
        { type: 'behind', detail: 'behind' },
        { type: 'unresolved-threads', detail: '1 unresolved review thread(s)' },
      ],
    }));
    expect(d.should).toBe(false);
    expect(d.reason).toContain('unresolved-threads');
  });

  test('BEHIND + changes-requested → NO update', () => {
    const d = decideUpdateBranch(behindPayload({
      blockers: [
        { type: 'behind', detail: 'behind' },
        { type: 'changes-requested', detail: 'A reviewer requested changes' },
      ],
    }));
    expect(d.should).toBe(false);
  });

  test('conflict verdict → NO update', () => {
    const d = decideUpdateBranch(behindPayload({
      verdict: 'BLOCKED-CONFLICT',
      blockers: [{ type: 'conflict', detail: 'Merge conflict' }],
    }));
    expect(d.should).toBe(false);
    expect(d.reason).toContain('not BEHIND');
  });

  test('draft → NO update', () => {
    const d = decideUpdateBranch(behindPayload({
      draft: true,
      blockers: [
        { type: 'draft', detail: 'PR is a draft' },
        { type: 'behind', detail: 'behind' },
      ],
    }));
    expect(d.should).toBe(false);
    expect(d.reason).toContain('draft');
  });

  test('fork → NO update', () => {
    const d = decideUpdateBranch(behindPayload(), { isFork: true });
    expect(d.should).toBe(false);
    expect(d.reason).toContain('fork');
  });

  test('degraded read (unreadable) → NO update even if verdict says BEHIND', () => {
    const d = decideUpdateBranch(behindPayload({
      evidence: { unreadable: ['threads'], tornRead: false },
    }));
    expect(d.should).toBe(false);
    expect(d.reason).toContain('degraded');
  });

  test('torn read → NO update', () => {
    const d = decideUpdateBranch(behindPayload({
      evidence: { unreadable: [], tornRead: true },
    }));
    expect(d.should).toBe(false);
  });

  test('non-BEHIND verdict (CLEAN) → NO update', () => {
    const d = decideUpdateBranch(behindPayload({ verdict: 'CLEAN-MERGEABLE', blockers: [] }));
    expect(d.should).toBe(false);
  });

  test('missing blockers[] → NO update (fail closed)', () => {
    const d = decideUpdateBranch(behindPayload({ blockers: undefined }));
    expect(d.should).toBe(false);
    expect(d.reason).toContain('blockers');
  });

  test('null payload → NO update (fail closed)', () => {
    expect(decideUpdateBranch(null).should).toBe(false);
  });

  test('mergeStateStatus=BEHIND with behind count 0 (no behind blocker listed) → still update', () => {
    // GitHub reports BEHIND but the commit count was unavailable, so computeBlockers
    // omitted the behind entry — the blockers list is empty, which is still clean.
    const d = decideUpdateBranch(behindPayload({ behind: 0, blockers: [] }));
    expect(d.should).toBe(true);
  });
});

describe('decideRerun — flaky required-check rerun gate', () => {
  test('single cancelled required check → rerun once', () => {
    const d = decideRerun(behindPayload({
      verdict: 'BLOCKED-CHECKS',
      requiredChecks: { failing: ['test'] },
      failures: [{ name: 'test', conclusion: 'CANCELLED', jobUrl: 'https://github.com/o/r/actions/runs/555/job/9' }],
    }));
    expect(d.should).toBe(true);
    expect(d.runIds).toEqual(['555']);
  });

  test('timed_out / stale / startup_failure are all infrastructural → rerun', () => {
    for (const c of ['TIMED_OUT', 'STALE', 'STARTUP_FAILURE']) {
      const d = decideRerun(behindPayload({
        requiredChecks: { failing: ['x'] },
        failures: [{ name: 'x', conclusion: c, jobUrl: 'https://github.com/o/r/actions/runs/1/job/2' }],
      }));
      expect(d.should).toBe(true);
    }
  });

  test('real FAILURE → NO rerun', () => {
    const d = decideRerun(behindPayload({
      requiredChecks: { failing: ['test'] },
      failures: [{ name: 'test', conclusion: 'FAILURE', jobUrl: 'https://github.com/o/r/actions/runs/1/job/2' }],
    }));
    expect(d.should).toBe(false);
    expect(d.reason).toContain('real failure');
  });

  test('mixed infra + real failure → NO rerun (whole decision fails closed)', () => {
    const d = decideRerun(behindPayload({
      requiredChecks: { failing: ['flaky', 'broken'] },
      failures: [
        { name: 'flaky', conclusion: 'CANCELLED', jobUrl: 'https://github.com/o/r/actions/runs/1/job/2' },
        { name: 'broken', conclusion: 'FAILURE', jobUrl: 'https://github.com/o/r/actions/runs/2/job/3' },
      ],
    }));
    expect(d.should).toBe(false);
  });

  test('required-failing check with no matching failures[] entry → NO rerun', () => {
    const d = decideRerun(behindPayload({
      requiredChecks: { failing: ['ghost'] },
      failures: [],
    }));
    expect(d.should).toBe(false);
    expect(d.reason).toContain('no known conclusion');
  });

  test('infra conclusion but no derivable run id → NO rerun', () => {
    const d = decideRerun(behindPayload({
      requiredChecks: { failing: ['known', 'unknown'] },
      failures: [
        { name: 'known', conclusion: 'CANCELLED', jobUrl: 'https://github.com/o/r/actions/runs/1/job/2' },
        { name: 'unknown', conclusion: 'TIMED_OUT', jobUrl: 'not-a-url' },
      ],
    }));
    expect(d.should).toBe(false);
    expect(d.reason).toContain('run id');
  });

  test('no failing required checks → NO rerun', () => {
    expect(decideRerun(behindPayload()).should).toBe(false);
  });

  test('degraded read → NO rerun', () => {
    const d = decideRerun(behindPayload({
      evidence: { unreadable: ['requiredChecks'], tornRead: false },
      requiredChecks: { failing: ['test'] },
      failures: [{ name: 'test', conclusion: 'CANCELLED', jobUrl: 'https://github.com/o/r/actions/runs/1/job/2' }],
    }));
    expect(d.should).toBe(false);
  });
});

describe('runIdFromUrl', () => {
  test('extracts run id from a job details URL', () => {
    expect(runIdFromUrl('https://github.com/o/r/actions/runs/12345/job/678')).toBe('12345');
  });
  test('extracts run id from a bare run URL', () => {
    expect(runIdFromUrl('https://github.com/o/r/actions/runs/999')).toBe('999');
  });
  test('returns null when absent', () => {
    expect(runIdFromUrl('nope')).toBeNull();
    expect(runIdFromUrl(null)).toBeNull();
  });
});

describe('decideAutoActions — combined', () => {
  test('bundles both decisions', () => {
    const d = decideAutoActions(behindPayload());
    expect(d.updateBranch.should).toBe(true);
    expect(d.rerunFlaky.should).toBe(false);
  });
});

describe('decideBoundedAutoActions - idempotency and retry bounds', () => {
  function flakyPayload(over = {}) {
    return behindPayload({
      headSha: 'a'.repeat(40),
      verdict: 'BLOCKED-CHECKS',
      blockers: [{ type: 'check-failing', detail: 'infra' }],
      requiredChecks: { failing: ['one', 'two'] },
      failures: [
        { name: 'one', conclusion: 'CANCELLED', jobUrl: 'https://github.com/o/r/actions/runs/11/job/1' },
        { name: 'two', conclusion: 'TIMED_OUT', jobUrl: 'https://github.com/o/r/actions/runs/22/job/2' },
      ],
      ...over,
    });
  }

  test('selects at most the configured number of deterministic actions', () => {
    const decision = decideBoundedAutoActions(flakyPayload(), { maxActions: 1, maxAttempts: 2 });
    expect(decision.status).toBe(AUTO_ACTION_STATUS.PASS);
    expect(decision.actions).toHaveLength(1);
    expect(decision.actions[0]).toMatchObject({ type: 'rerunFlaky', runId: '11', attempt: 1 });
  });

  test('failed action retries once, then identical exhausted/applied input consumes no action', () => {
    const oneFailure = flakyPayload({
      requiredChecks: { failing: ['one'] },
      failures: [{ name: 'one', conclusion: 'CANCELLED', jobUrl: 'https://github.com/o/r/actions/runs/11/job/1' }],
    });
    const first = decideBoundedAutoActions(oneFailure, { maxActions: 1, maxAttempts: 2 });
    const key = first.actions[0].key;

    expect(decideBoundedAutoActions(oneFailure, {
      maxActions: 1, maxAttempts: 2, history: [{ key, state: 'failed', attempts: 1 }],
    }).actions[0].attempt).toBe(2);

    for (const prior of [
      { key, state: 'failed', attempts: 2 },
      { key, state: 'applied', attempts: 1 },
      { key, state: 'pending', attempts: 1 },
    ]) {
      expect(decideBoundedAutoActions(oneFailure, {
        maxActions: 1, maxAttempts: 2, history: [prior],
      })).toMatchObject({ status: AUTO_ACTION_STATUS.UNCHANGED, actions: [] });
    }
  });

  test('stale head, incomplete authority, and contradictory decisions fail closed', () => {
    expect(decideBoundedAutoActions(flakyPayload(), { expectedRevision: 'b'.repeat(40) })).toMatchObject({
      status: AUTO_ACTION_STATUS.STALE,
      actions: [],
    });
    expect(decideBoundedAutoActions(flakyPayload({ headSha: undefined }))).toMatchObject({
      status: AUTO_ACTION_STATUS.INCOMPLETE,
      actions: [],
    });
    expect(decideBoundedAutoActions(behindPayload({
      headSha: 'a'.repeat(40),
      requiredChecks: { failing: ['one'] },
      failures: [{ name: 'one', conclusion: 'CANCELLED', jobUrl: 'https://github.com/o/r/actions/runs/11/job/1' }],
    }))).toMatchObject({ status: AUTO_ACTION_STATUS.CONFLICT, actions: [] });
  });

  test('missing evidence or draft authority is incomplete and consumes no action', () => {
    for (const payload of [
      flakyPayload({ evidence: undefined }),
      flakyPayload({ draft: undefined }),
      flakyPayload({ draft: true }),
    ]) {
      expect(decideBoundedAutoActions(payload)).toMatchObject({
        status: AUTO_ACTION_STATUS.INCOMPLETE,
        actions: [],
      });
    }
  });

  test('conflicting duplicate required-check evidence conflicts instead of first-wins rerun', () => {
    const payload = flakyPayload({
      requiredChecks: { failing: ['one'] },
      failures: [
        { name: 'one', conclusion: 'CANCELLED', jobUrl: 'https://github.com/o/r/actions/runs/11/job/1' },
        { name: 'one', conclusion: 'TIMED_OUT', jobUrl: 'https://github.com/o/r/actions/runs/22/job/2' },
      ],
    });

    expect(decideBoundedAutoActions(payload)).toMatchObject({
      status: AUTO_ACTION_STATUS.CONFLICT,
      actions: [],
    });
  });
});
