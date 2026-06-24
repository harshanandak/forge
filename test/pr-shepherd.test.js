'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { runShepherdPass, TERMINAL_STATES } = require('../lib/pr-shepherd');

/**
 * Build a fake pr-state adapter from a declarative spec. Every mutating action
 * is recorded so tests can assert the exact side-effect log. `headSha` may be a
 * function of the read-count to simulate HEAD moving mid-pass.
 */
function makeAdapter(spec = {}) {
  let readCount = 0;
  const actions = [];
  return {
    actions,
    adapter: {
      id: 'fake-pr-state',
      kind: 'pr-state',
      async readState() {
        readCount += 1;
        const headSha = typeof spec.headSha === 'function' ? spec.headSha(readCount) : (spec.headSha || 'sha-1');
        return {
          headSha,
          mergeStateStatus: spec.mergeStateStatus || 'CLEAN',
          checks: spec.checks || [],
          threads: spec.threads || [],
        };
      },
      async readRequiredChecks() {
        if (spec.requiredAuthError) throw spec.requiredAuthError;
        return spec.required === undefined ? [] : spec.required;
      },
      async readDivergence() {
        return { behind: spec.behind || 0, ahead: spec.ahead || 0 };
      },
      async rerunFailedChecks(args) {
        actions.push({ type: 'rerun', ...args });
      },
      async replyToThread(args) {
        actions.push({ type: 'reply', ...args });
      },
      async rebaseOntoBase(args) {
        if (spec.leaseReject) {
          const err = new Error('lease reject');
          err.leaseRejected = true;
          throw err;
        }
        actions.push({ type: 'rebase', ...args });
      },
    },
  };
}

const BASE_CTX = { pr: '123', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master' };

describe('runShepherdPass — bounded pass state machine', () => {
  // 1
  test('all required green + behind=0 → MERGE_READY, NO merge emitted', async () => {
    const { adapter, actions } = makeAdapter({
      required: ['unit'],
      checks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      behind: 0,
      mergeStateStatus: 'CLEAN',
    });
    const result = await runShepherdPass({ ...BASE_CTX, adapter });
    expect(result.state).toBe('MERGE_READY');
    expect(actions.some((a) => a.type === 'merge')).toBe(false);
  });

  // 2
  test('failed flaky required check with budget left → ONE rerun, PENDING', async () => {
    const { adapter, actions } = makeAdapter({
      required: ['unit'],
      checks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', databaseId: '777' }],
      behind: 0,
    });
    const result = await runShepherdPass({ ...BASE_CTX, adapter, rerunBudget: 3, rerunsUsed: 0 });
    expect(result.state).toBe('PENDING');
    expect(actions.filter((a) => a.type === 'rerun')).toHaveLength(1);
  });

  // 3
  test('behind>0 with autoRebase:false → ESCALATE, no rebase/push', async () => {
    const { adapter, actions } = makeAdapter({
      required: ['unit'],
      checks: [{ name: 'unit', conclusion: 'SUCCESS' }],
      behind: 2,
    });
    const result = await runShepherdPass({ ...BASE_CTX, adapter, autoRebase: false });
    expect(result.state).toBe('ESCALATE');
    expect(actions.some((a) => a.type === 'rebase')).toBe(false);
  });

  // 4
  test('behind>0 autoRebase:true clean tree HEAD unchanged → rebase emitted; lease reject → ESCALATE no retry', async () => {
    const ok = makeAdapter({
      required: ['unit'],
      checks: [{ name: 'unit', conclusion: 'SUCCESS' }],
      behind: 2,
    });
    await runShepherdPass({
      ...BASE_CTX, adapter: ok.adapter, autoRebase: true, cleanTree: true,
    });
    expect(ok.actions.filter((a) => a.type === 'rebase')).toHaveLength(1);

    const lease = makeAdapter({
      required: ['unit'],
      checks: [{ name: 'unit', conclusion: 'SUCCESS' }],
      behind: 2,
      leaseReject: true,
    });
    const leaseResult = await runShepherdPass({
      ...BASE_CTX, adapter: lease.adapter, autoRebase: true, cleanTree: true,
    });
    expect(leaseResult.state).toBe('ESCALATE');
    // lease reject is a hard-stop: never auto-fetch-then-retry
    expect(lease.actions.filter((a) => a.type === 'rebase')).toHaveLength(0);
  });

  // 5
  test('required set unreadable (protection 403) → ESCALATE, never MERGE_READY', async () => {
    const { adapter } = makeAdapter({
      required: null, // adapter returns null = cannot determine
      checks: [{ name: 'unit', conclusion: 'SUCCESS' }],
      behind: 0,
    });
    const result = await runShepherdPass({ ...BASE_CTX, adapter });
    expect(result.state).toBe('ESCALATE');
    expect(result.state).not.toBe('MERGE_READY');
  });

  // 6
  test('HEAD moved mid-pass → mutating action aborted', async () => {
    const { adapter, actions } = makeAdapter({
      required: ['unit'],
      checks: [{ name: 'unit', conclusion: 'FAILURE', databaseId: '777' }],
      behind: 0,
      headSha: (n) => (n === 1 ? 'sha-1' : 'sha-2'), // changes on the pre-action re-read
    });
    const result = await runShepherdPass({ ...BASE_CTX, adapter, rerunBudget: 3, rerunsUsed: 0 });
    expect(actions.some((a) => a.type === 'rerun')).toBe(false);
    expect(result.aborted).toBe(true);
  });

  // 7
  test('auth taxonomy: 403 insufficient-scope → HARD_STOP; 403+Retry-After → honored; 401 → pause', async () => {
    const scopeErr = new Error('forbidden');
    scopeErr.httpStatus = 403;
    scopeErr.stderr = 'HTTP 403: Resource not accessible by integration';
    const scope = makeAdapter({ requiredAuthError: scopeErr });
    const scopeResult = await runShepherdPass({ ...BASE_CTX, adapter: scope.adapter });
    expect(scopeResult.state).toBe('HARD_STOP');
    expect(scopeResult.authClass).toBe('insufficient-scope');

    const rateErr = new Error('rate limited');
    rateErr.httpStatus = 403;
    rateErr.retryAfter = 30;
    const rate = makeAdapter({ requiredAuthError: rateErr });
    const rateResult = await runShepherdPass({ ...BASE_CTX, adapter: rate.adapter });
    expect(rateResult.authClass).toBe('rate-limit');
    expect(rateResult.retryAfter).toBe(30);

    const expiredErr = new Error('unauthorized');
    expiredErr.httpStatus = 401;
    const expired = makeAdapter({ requiredAuthError: expiredErr });
    const expiredResult = await runShepherdPass({ ...BASE_CTX, adapter: expired.adapter });
    expect(expiredResult.authClass).toBe('expired');
    expect(expiredResult.state).toBe('PENDING'); // pause + surface, transient
  });

  // 8
  test('rerun budget exhausted / oscillation → ESCALATE', async () => {
    const { adapter, actions } = makeAdapter({
      required: ['unit'],
      checks: [{ name: 'unit', conclusion: 'FAILURE', databaseId: '777' }],
      behind: 0,
    });
    const result = await runShepherdPass({ ...BASE_CTX, adapter, rerunBudget: 2, rerunsUsed: 2 });
    expect(result.state).toBe('ESCALATE');
    expect(actions.some((a) => a.type === 'rerun')).toBe(false);
  });

  // 9
  test('NEVER emits gh pr merge or gh pr merge --auto in any branch', async () => {
    const scenarios = [
      { required: ['u'], checks: [{ name: 'u', conclusion: 'SUCCESS' }], behind: 0 },
      { required: ['u'], checks: [{ name: 'u', conclusion: 'FAILURE', databaseId: '1' }], behind: 0 },
      { required: ['u'], checks: [{ name: 'u', conclusion: 'SUCCESS' }], behind: 3 },
      { required: null, checks: [], behind: 0 },
    ];
    for (const spec of scenarios) {
      const { adapter, actions } = makeAdapter(spec);
      await runShepherdPass({ ...BASE_CTX, adapter, rerunBudget: 5, rerunsUsed: 0, autoRebase: true, cleanTree: true });
      expect(actions.some((a) => a.type === 'merge')).toBe(false);
    }
  });

  // 10
  test('NEVER emits a greptile thread resolve (reply allowed)', async () => {
    const { adapter, actions } = makeAdapter({
      required: ['unit'],
      checks: [{ name: 'unit', conclusion: 'SUCCESS' }],
      behind: 2, // escalation path, where a status reply may be posted
      threads: [{ id: 't1', commentId: 'c1', resolved: false }],
    });
    await runShepherdPass({ ...BASE_CTX, adapter, autoRebase: false });
    expect(actions.some((a) => a.type === 'resolve')).toBe(false);
  });

  test('TERMINAL_STATES exposes the documented terminal set', () => {
    expect(TERMINAL_STATES).toContain('MERGE_READY');
    expect(TERMINAL_STATES).toContain('ESCALATE');
    expect(TERMINAL_STATES).toContain('PENDING');
  });

  test('source contains zero bd/.beads/dolt tokens and no gh pr merge', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pr-shepherd.js'), 'utf8');
    expect(/\bbd\b/i.test(src)).toBe(false);
    expect(/\.beads\b/i.test(src)).toBe(false);
    expect(/\bdolt\b/i.test(src)).toBe(false);
    expect(/gh pr merge/.test(src)).toBe(false);
  });
});
