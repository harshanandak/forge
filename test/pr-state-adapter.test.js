'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { PrStateAdapter } = require('../lib/adapters/pr-state-adapter');
const { validatePrStateAdapter } = require('../lib/pr-state-validator');

/**
 * Build a fake command runner whose behaviour is keyed off the first token of
 * the argv. Records every invocation in `calls` for assertions.
 */
function makeRunner(responses) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push({ cmd, args });
    const argv = [cmd, ...args];
    const joined = argv.join(' ');
    for (const [match, value] of responses) {
      if (joined.includes(match)) {
        if (typeof value === 'function') return value(argv);
        return value;
      }
    }
    return '';
  };
  return { run, calls };
}

const PR_VIEW_JSON = JSON.stringify({
  headRefOid: 'abc123',
  mergeStateStatus: 'BLOCKED',
  statusCheckRollup: [
    { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'optional-bench', status: 'COMPLETED', conclusion: 'FAILURE' },
  ],
  reviewThreads: [],
});

const REQUIRED_CHECKS_JSON = JSON.stringify({ contexts: ['unit', 'lint'] });

describe('PrStateAdapter', () => {
  test('satisfies the pr-state adapter contract', () => {
    const { run } = makeRunner([]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    expect(adapter.kind).toBe('pr-state');
    expect(validatePrStateAdapter(adapter)).toEqual({ valid: true, errors: [] });
  });

  test('readState normalizes the rollup, head SHA and merge state', async () => {
    const { run } = makeRunner([
      ['pr view', PR_VIEW_JSON],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const state = await adapter.readState('123');

    expect(state.headSha).toBe('abc123');
    expect(state.mergeStateStatus).toBe('BLOCKED');
    expect(state.checks).toHaveLength(3);
    expect(state.checks.find((c) => c.name === 'lint').conclusion).toBe('FAILURE');
  });

  test('readRequiredChecks calls the branch protection API and returns required contexts', async () => {
    const { run, calls } = makeRunner([
      ['protection/required_status_checks', REQUIRED_CHECKS_JSON],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const required = await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master' });

    expect(required).toEqual(['unit', 'lint']);
    const apiCall = calls.find((c) => c.args.join(' ').includes('protection/required_status_checks'));
    expect(apiCall).toBeTruthy();
    expect(apiCall.args.join(' ')).toContain('repos/o/r/branches/master/protection/required_status_checks');
  });

  test('readRequiredChecks returns null for an unexpected payload shape (not [])', async () => {
    // A malformed/changed protection payload must NOT look like "no required
    // checks" — that would let the shepherd compute merge readiness from bad data.
    const { run } = makeRunner([
      ['protection/required_status_checks', JSON.stringify({ unexpected: true })],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const result = await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master' });

    expect(result).toBeNull();
  });

  test('readRequiredChecks returns [] for a valid empty contexts payload', async () => {
    const { run } = makeRunner([
      ['protection/required_status_checks', JSON.stringify({ contexts: [] })],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const result = await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master' });

    expect(result).toEqual([]);
  });

  test('readRequiredChecks surfaces unreadable protection (403) instead of guessing', async () => {
    const err = new Error('403');
    err.stderr = 'HTTP 403: Resource not accessible by integration';
    const { run } = makeRunner([
      ['protection/required_status_checks', () => { throw err; }],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const result = await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master' });

    expect(result).toBeNull(); // null = "cannot determine required set"
  });

  test('readDivergence parses git rev-list --left-right --count as { behind, ahead }', async () => {
    const { run, calls } = makeRunner([
      ['rev-list --left-right --count', '2\t5\n'],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const d = await adapter.readDivergence({ baseRef: 'origin/master' });

    expect(d).toEqual({ behind: 2, ahead: 5 });
    const call = calls.find((c) => c.args.join(' ').includes('rev-list'));
    expect(call.args.join(' ')).toContain('--left-right');
    expect(call.args.join(' ')).toContain('--count');
  });

  test('readDivergence threads cwd through to the git runner', async () => {
    const calls = [];
    const run = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return '0\t0\n';
    };
    const adapter = new PrStateAdapter({ gh: run, git: run });
    await adapter.readDivergence({ baseRef: 'origin/master', cwd: '/work/tree' });

    const call = calls.find((c) => c.args.join(' ').includes('rev-list'));
    expect(call.opts && call.opts.cwd).toBe('/work/tree');
  });

  test('readDivergence omits cwd when none is supplied (runs in process dir)', async () => {
    const calls = [];
    const run = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return '0\t0\n';
    };
    const adapter = new PrStateAdapter({ gh: run, git: run });
    await adapter.readDivergence({ baseRef: 'origin/master' });

    const call = calls.find((c) => c.args.join(' ').includes('rev-list'));
    expect(call.opts === undefined || call.opts.cwd === undefined).toBe(true);
  });

  test('rerunFailedChecks shells out to gh run rerun --failed', async () => {
    const { run, calls } = makeRunner([['run rerun', '']]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    await adapter.rerunFailedChecks({ runId: '999' });

    const call = calls.find((c) => c.args.join(' ').includes('rerun'));
    expect(call.args).toContain('--failed');
  });

  test('the adapter source imports no merge or rebase machinery and is token-clean', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'lib', 'adapters', 'pr-state-adapter.js'),
      'utf8',
    );
    expect(/gh pr merge/.test(src)).toBe(false);
    expect(/git rebase/.test(src)).toBe(false);
    expect(/push --force/.test(src)).toBe(false);
    expect(/\bbd\b/i.test(src)).toBe(false);
    expect(/\.beads\b/i.test(src)).toBe(false);
    expect(/\bdolt\b/i.test(src)).toBe(false);
  });
});
