'use strict';

const { describe, expect, test } = require('bun:test');

const preflightCommand = require('../../lib/commands/preflight');
const {
  defaultRunCodeRabbit,
  defaultRunDeterministic,
  runLocalReviewPreflight,
} = require('../../lib/pr-monitor/review-preflight');

const EXACT_HEAD_CONTEXT = {
  projectRoot: '/repo', base: 'master', expectedHead: 'a'.repeat(40), localHead: 'a'.repeat(40), cleanTree: true,
};

describe('bounded local review preflight', () => {
  test('accepts only a structured terminal CodeRabbit result with zero findings', async () => {
    const result = await defaultRunCodeRabbit({ projectRoot: '/repo', base: 'master' }, () => [
      JSON.stringify({ type: 'status', phase: 'reviewing' }),
      JSON.stringify({ type: 'complete', status: 'review_completed', findings: 0 }),
    ].join('\n'));
    expect(result).toMatchObject({ ok: true, findings: [] });
  });

  test('does not mistake finding text that says no issues for a clean review', async () => {
    const result = await defaultRunCodeRabbit({ projectRoot: '/repo', base: 'master' }, () => [
      JSON.stringify({ type: 'finding', severity: 'minor', codegenInstructions: 'No issues found in the fallback text' }),
      JSON.stringify({ type: 'complete', status: 'review_completed', findings: 1 }),
    ].join('\n'));
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
  });

  test('fails closed for malformed or unterminated CodeRabbit agent output', async () => {
    for (const output of ['', 'No issues found', JSON.stringify({ type: 'status', phase: 'reviewing' })]) {
      const result = await defaultRunCodeRabbit({ projectRoot: '/repo', base: 'master' }, () => output);
      expect(result.ok).toBe(false);
    }
  });

  test('deterministic preflight resolves changes against the PR target branch', async () => {
    const originalHandler = preflightCommand.handler;
    let changeSet;
    preflightCommand.handler = async (_args, _flags, _root, deps) => {
      changeSet = deps.resolveChangeSet({ runAll: false });
      return { success: true, results: [] };
    };
    const exec = (_command, args) => {
      const joined = args.join(' ');
      if (joined === 'rev-parse --verify --quiet origin/release/2.0') return 'release-sha\n';
      if (joined === 'merge-base HEAD origin/release/2.0') return 'release-base\n';
      if (joined === 'diff --name-only release-base...HEAD') return 'lib/release.js\n';
      throw new Error(`unexpected git: ${joined}`);
    };
    try {
      await defaultRunDeterministic({ projectRoot: '/repo', base: 'release/2.0' }, exec);
    } finally {
      preflightCommand.handler = originalHandler;
    }

    expect(changeSet).toMatchObject({ baseRef: 'origin/release/2.0', changedFiles: ['lib/release.js'] });
  });

  test('deterministic preflight preserves a non-origin resolved base ref', async () => {
    const originalHandler = preflightCommand.handler;
    let changeSet;
    preflightCommand.handler = async (_args, _flags, _root, deps) => {
      changeSet = deps.resolveChangeSet({ runAll: false });
      return { success: true, results: [] };
    };
    const exec = (_command, args) => {
      const joined = args.join(' ');
      if (joined === 'rev-parse --verify --quiet upstream/master') return 'base\n';
      if (joined === 'merge-base HEAD upstream/master') return 'merge-base\n';
      if (joined === 'diff --name-only merge-base...HEAD') return 'lib/change.js\n';
      throw new Error(`unexpected git: ${joined}`);
    };
    try {
      await defaultRunDeterministic({ projectRoot: '/repo', base: 'master', baseRef: 'upstream/master' }, exec);
    } finally {
      preflightCommand.handler = originalHandler;
    }
    expect(changeSet.baseRef).toBe('upstream/master');
  });

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

  test('blocks exact-head preflight when the local checkout has uncommitted changes', async () => {
    let calls = 0;
    const result = await runLocalReviewPreflight({ ...EXACT_HEAD_CONTEXT, cleanTree: false }, {
      probeCodeRabbit: async () => { calls += 1; },
      runDeterministic: async () => { calls += 1; },
    });

    expect(result).toMatchObject({ status: 'INCOMPLETE', blocking: true });
    expect(result.findings).toEqual([{
      provider: 'local-preflight', detail: 'local checkout has uncommitted changes',
    }]);
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
