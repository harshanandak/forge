'use strict';

const { describe, expect, test } = require('bun:test');

const { runLocalReviewPreflight } = require('../../lib/pr-monitor/review-preflight');

const EXACT_HEAD_CONTEXT = {
  projectRoot: '/repo', base: 'master', expectedHead: 'a'.repeat(40), localHead: 'a'.repeat(40),
};

describe('bounded local review preflight', () => {
  test('does not review an unrelated local checkout as if it were the PR head', async () => {
    let calls = 0;
    const result = await runLocalReviewPreflight({
      projectRoot: '/repo', base: 'master', expectedHead: 'a'.repeat(40), localHead: 'b'.repeat(40),
    }, {
      probeCodeRabbit: async () => { calls += 1; },
      runDeterministic: async () => { calls += 1; },
    });

    expect(result).toMatchObject({ status: 'INCOMPLETE', blocking: false });
    expect(result.providers.coderabbit.status).toBe('NOT_APPLICABLE');
    expect(calls).toBe(0);
  });

  test('does not review a checkout when the authoritative PR head is unavailable', async () => {
    let calls = 0;
    const result = await runLocalReviewPreflight({
      projectRoot: '/repo', base: 'master', expectedHead: null, localHead: 'a'.repeat(40),
    }, {
      probeCodeRabbit: async () => { calls += 1; },
      runDeterministic: async () => { calls += 1; },
    });

    expect(result).toMatchObject({ status: 'INCOMPLETE', blocking: false });
    expect(result.providers.coderabbit).toMatchObject({
      status: 'NOT_APPLICABLE', summary: 'PR head is unavailable',
    });
    expect(calls).toBe(0);
  });

  test('classifies unavailable CodeRabbit without manufacturing a pass', async () => {
    const result = await runLocalReviewPreflight(EXACT_HEAD_CONTEXT, {
      probeCodeRabbit: async () => ({ available: false, reason: 'not installed' }),
      runDeterministic: async () => ({ success: true, results: [
        { name: 'lint', ok: true, skipped: false, summary: 'clean' },
        { name: 'sonar', ok: true, skipped: false, summary: 'clean' },
        { name: 'affected-tests', ok: true, skipped: false, summary: 'passed' },
      ] }),
    });

    expect(result.status).toBe('INCOMPLETE');
    expect(result.blocking).toBe(false);
    expect(result.providers.coderabbit).toMatchObject({ status: 'UNAVAILABLE', ok: false });
  });

  test('consolidates provider findings and blocks remote mutation on failure', async () => {
    const result = await runLocalReviewPreflight(EXACT_HEAD_CONTEXT, {
      probeCodeRabbit: async () => ({ available: true }),
      runCodeRabbit: async () => ({ ok: false, summary: '2 findings', findings: ['one', 'two'] }),
      runDeterministic: async () => ({ success: false, results: [
        { name: 'lint', ok: false, skipped: false, summary: 'one error' },
        { name: 'sonar', ok: null, skipped: true, summary: 'skipped' },
      ] }),
    });

    expect(result).toMatchObject({ status: 'FAIL', blocking: true });
    expect(result.findings).toEqual([
      { provider: 'coderabbit', detail: 'one' },
      { provider: 'coderabbit', detail: 'two' },
      { provider: 'lint', detail: 'one error' },
    ]);
  });

  test('classifies a probed but unauthenticated CLI as unavailable, not green', async () => {
    const result = await runLocalReviewPreflight(EXACT_HEAD_CONTEXT, {
      probeCodeRabbit: async () => ({ available: true }),
      runCodeRabbit: async () => ({ ok: false, unavailable: true, summary: 'login required' }),
      runDeterministic: async () => ({ success: true, results: [] }),
    });

    expect(result.status).toBe('INCOMPLETE');
    expect(result.blocking).toBe(false);
    expect(result.providers.coderabbit).toMatchObject({ status: 'UNAVAILABLE', ok: false });
  });
});
