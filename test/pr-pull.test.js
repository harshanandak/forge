'use strict';

const { describe, test, expect } = require('bun:test');

const {
  cleanLogLine,
  extractFailureExcerpt,
  jobIdFromUrl,
  dedupeFailures,
  buildReviewThreads,
  buildPullPayload,
  gatherPullSignal,
} = require('../lib/pr-pull');

// A gh `run view --log-failed` line: `jobName\tstepName\t<ISO-timestamp> content`.
const ghLine = (job, step, ts, content) => `${job}\t${step}\t${ts} ${content}`;

describe('cleanLogLine', () => {
  test('strips the gh job/step/timestamp prefix, leaving the raw content', () => {
    const line = ghLine('test (ubuntu, 20)', 'Run bun test', '2026-07-10T12:00:00.1234567Z', '(fail) parses > handles empty');
    expect(cleanLogLine(line)).toBe('(fail) parses > handles empty');
  });

  test('strips a bare leading ISO timestamp', () => {
    expect(cleanLogLine('2026-07-10T12:00:00.0000000Z error: boom')).toBe('error: boom');
  });

  test('leaves a line without a timestamp untouched (minus trailing CR)', () => {
    expect(cleanLogLine('AssertionError: nope\r')).toBe('AssertionError: nope');
  });
});

describe('extractFailureExcerpt', () => {
  const log = [
    ghLine('t', 's', '2026-07-10T12:00:00.1Z', '✓ passing test one'),
    ghLine('t', 's', '2026-07-10T12:00:01.2Z', '(fail) widget > renders label [1.00ms]'),
    ghLine('t', 's', '2026-07-10T12:00:02.3Z', 'error: expect(received).toBe(expected)'),
    ghLine('t', 's', '2026-07-10T12:00:03.4Z', 'Expected: "hello"'),
    ghLine('t', 's', '2026-07-10T12:00:04.5Z', 'Received: "world"'),
    ghLine('t', 's', '2026-07-10T12:00:05.6Z', '✓ another passing test'),
  ].join('\n');

  test('keeps only the failure-signal lines, dropping passing/noise lines', () => {
    const ex = extractFailureExcerpt(log);
    expect(ex).toContain('(fail) widget > renders label');
    expect(ex).toContain('error: expect(received).toBe(expected)');
    expect(ex).toContain('Expected: "hello"');
    expect(ex).toContain('Received: "world"');
    expect(ex).not.toContain('passing test');
  });

  test('two matrix jobs with different prefixes/timestamps yield an IDENTICAL excerpt (dedupe key)', () => {
    const ubuntu = [
      ghLine('test (ubuntu, 20)', 's', '2026-07-10T12:00:01.2Z', '(fail) widget > renders label'),
      ghLine('test (ubuntu, 20)', 's', '2026-07-10T12:00:02.3Z', 'error: boom'),
    ].join('\n');
    const windows = [
      ghLine('test (windows, 22)', 's', '2026-07-11T09:30:41.9Z', '(fail) widget > renders label'),
      ghLine('test (windows, 22)', 's', '2026-07-11T09:30:42.0Z', 'error: boom'),
    ].join('\n');
    expect(extractFailureExcerpt(ubuntu)).toBe(extractFailureExcerpt(windows));
  });

  test('falls back to the log tail when no failure signal is present', () => {
    const noisy = ['line a', 'line b', 'line c'].join('\n');
    const ex = extractFailureExcerpt(noisy, { maxLines: 2 });
    expect(ex).toBe('line b\nline c');
  });

  test('caps the excerpt at maxLines', () => {
    const many = Array.from({ length: 50 }, (_, i) => `error: failure ${i}`).join('\n');
    const ex = extractFailureExcerpt(many, { maxLines: 30 });
    expect(ex.split('\n').length).toBe(30);
  });

  test('collapses repeated identical failure lines', () => {
    const repeated = Array.from({ length: 5 }, () => 'error: same boom').join('\n');
    expect(extractFailureExcerpt(repeated)).toBe('error: same boom');
  });
});

describe('jobIdFromUrl', () => {
  test('extracts the job id from an Actions details URL', () => {
    expect(jobIdFromUrl('https://github.com/o/r/actions/runs/123/job/456789')).toBe('456789');
  });
  test('returns null when there is no job segment', () => {
    expect(jobIdFromUrl('https://example.com/whatever')).toBeNull();
    expect(jobIdFromUrl(null)).toBeNull();
  });
});

describe('dedupeFailures (matrix collapse)', () => {
  test('collapses identical excerpts across matrix jobs into one, counting the others', () => {
    const raw = [
      { name: 'test (ubuntu, 20)', conclusion: 'FAILURE', jobUrl: 'u1', excerpt: '(fail) a\nerror: boom' },
      { name: 'test (windows, 20)', conclusion: 'FAILURE', jobUrl: 'w1', excerpt: '(fail) a\nerror: boom' },
      { name: 'test (macos, 22)', conclusion: 'FAILURE', jobUrl: 'm1', excerpt: '(fail) a\nerror: boom' },
    ];
    const out = dedupeFailures(raw);
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('test (ubuntu, 20)');
    expect(out[0].alsoFailedOn).toBe(2); // two OTHER jobs shared the identical failure
  });

  test('keeps distinct excerpts as separate entries with alsoFailedOn=0', () => {
    const raw = [
      { name: 'lint', conclusion: 'FAILURE', jobUrl: 'l', excerpt: 'eslint: no-unused-vars' },
      { name: 'unit', conclusion: 'FAILURE', jobUrl: 'u', excerpt: '(fail) thing' },
    ];
    const out = dedupeFailures(raw);
    expect(out.length).toBe(2);
    expect(out.every((f) => f.alsoFailedOn === 0)).toBe(true);
  });

  test('does NOT collapse distinct failures that both have an empty excerpt', () => {
    const raw = [
      { name: 'a', conclusion: 'FAILURE', jobUrl: 'a', excerpt: '' },
      { name: 'b', conclusion: 'FAILURE', jobUrl: 'b', excerpt: '' },
    ];
    expect(dedupeFailures(raw).length).toBe(2);
  });
});

describe('buildReviewThreads', () => {
  const threads = [
    {
      threadId: 'T1', path: 'lib/a.js', line: 10, isResolved: false, isOutdated: false,
      comments: [{ author: 'coderabbitai', body: 'Consider guarding null here', commentId: 'C1' }],
    },
    {
      threadId: 'T2', path: 'lib/b.js', line: 20, isResolved: false, isOutdated: false,
      comments: [{ author: 'alice', body: 'rename this', commentId: 'C2' }],
    },
    {
      threadId: 'T3', path: 'lib/c.js', line: 30, isResolved: true, isOutdated: false,
      comments: [{ author: 'bob', body: 'already fixed', commentId: 'C3' }],
    },
    {
      threadId: 'T4', path: 'lib/d.js', line: 40, isResolved: false, isOutdated: true,
      comments: [{ author: 'carol', body: 'stale', commentId: 'C4' }],
    },
    {
      threadId: 'T5', path: 'lib/e.js', line: 50, isResolved: false, isOutdated: false,
      comments: [{ author: 'github-actions', body: 'noise', commentId: 'C5' }],
    },
  ];

  test('includes CodeRabbit AND human threads, mapped to the action shape', () => {
    const out = buildReviewThreads(threads, 'me');
    const ids = out.map((t) => t.threadId);
    expect(ids).toContain('T1'); // coderabbit — its comments ARE the fixes
    expect(ids).toContain('T2'); // human
    expect(out.find((t) => t.threadId === 'T1')).toEqual({
      file: 'lib/a.js', line: 10, author: 'coderabbitai',
      body: 'Consider guarding null here', threadId: 'T1', commentId: 'C1',
    });
  });

  test('excludes resolved, outdated, and pure-automation (github-actions) threads', () => {
    const ids = buildReviewThreads(threads, 'me').map((t) => t.threadId);
    expect(ids).not.toContain('T3'); // resolved
    expect(ids).not.toContain('T4'); // outdated
    expect(ids).not.toContain('T5'); // github-actions automation, not a review
  });

  test('excludes the shepherd itself (self) to avoid self-wake', () => {
    const selfThread = [{
      threadId: 'T6', path: 'x', line: 1, isResolved: false, isOutdated: false,
      comments: [{ author: 'me', body: 'my own status reply' }],
    }];
    expect(buildReviewThreads(selfThread, 'me').length).toBe(0);
  });

  test('caps the thread list at maxThreads', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      threadId: `M${i}`, path: 'f', line: i, isResolved: false, isOutdated: false,
      comments: [{ author: 'alice', body: `c${i}` }],
    }));
    expect(buildReviewThreads(many, 'me', { maxThreads: 20 }).length).toBe(20);
  });
});

describe('buildPullPayload', () => {
  test('assembles the compact shape and enforces caps + truncation flags', () => {
    const failures = Array.from({ length: 15 }, (_, i) => ({
      name: `f${i}`, conclusion: 'FAILURE', jobUrl: `u${i}`, excerpt: `err ${i}`, alsoFailedOn: 0,
    }));
    const reviewThreads = Array.from({ length: 25 }, (_, i) => ({
      file: 'f', line: i, author: 'a', body: 'b', threadId: `T${i}`, commentId: `C${i}`,
    }));
    const payload = buildPullPayload({
      state: 'ESCALATE', summary: 'x', failures, reviewThreads,
      maxFailures: 10, maxThreads: 20,
    });
    expect(payload.state).toBe('ESCALATE');
    expect(payload.summary).toBe('x');
    expect(payload.failures.length).toBe(10);
    expect(payload.reviewThreads.length).toBe(20);
    expect(payload.truncated.failures).toBe(true);
    expect(payload.truncated.reviewThreads).toBe(true);
  });

  test('caps each excerpt at maxExcerptLines', () => {
    const bigExcerpt = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const payload = buildPullPayload({
      state: 'PENDING', summary: 's',
      failures: [{ name: 'f', conclusion: 'FAILURE', jobUrl: 'u', excerpt: bigExcerpt, alsoFailedOn: 0 }],
      reviewThreads: [], maxExcerptLines: 30,
    });
    expect(payload.failures[0].excerpt.split('\n').length).toBe(30);
  });
});

describe('gatherPullSignal (orchestrator — injected gh runner, no live GitHub)', () => {
  function makeCtx(overrides = {}) {
    const checks = overrides.checks || [
      { name: 'test (ubuntu, 20)', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/111' },
      { name: 'test (windows, 20)', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/222' },
      { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/333' },
    ];
    const logs = overrides.logs || {
      111: '2026-07-10T12:00:01.2Z (fail) widget > renders\n2026-07-10T12:00:02.3Z error: boom',
      222: '2026-07-11T09:30:41.9Z (fail) widget > renders\n2026-07-11T09:30:42.0Z error: boom',
    };
    const adapter = {
      id: 'fake', kind: 'pr-state',
      async readState() { return { headSha: 's', state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', checks, threads: [] }; },
      async readRequiredChecks() { return overrides.required || ['test (ubuntu, 20)', 'test (windows, 20)']; },
      async readDivergence() { return { behind: 0, ahead: 1 }; },
      async readComments() {
        return overrides.threads || [{
          threadId: 'T1', path: 'lib/a.js', line: 10, isResolved: false, isOutdated: false,
          comments: [{ author: 'coderabbitai', body: 'guard null', commentId: 'C1' }],
        }];
      },
    };
    const ghCalls = [];
    const runGh = (args) => {
      ghCalls.push(args.join(' '));
      const jobFlagIdx = args.indexOf('--job');
      const jobId = jobFlagIdx >= 0 ? args[jobFlagIdx + 1] : null;
      return logs[jobId] || '';
    };
    const runPass = overrides.runPass || (async () => ({ state: 'ESCALATE', reason: 'persistent failure' }));
    return { adapter, runGh, runPass, ghCalls };
  }

  test('returns state, summary, deduped matrix failures with excerpts, and review threads', async () => {
    const { adapter, runGh, runPass } = makeCtx();
    const payload = await gatherPullSignal({
      pr: '5', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter, runGh, runPass, self: 'me',
    });

    expect(payload.state).toBe('ESCALATE');
    expect(typeof payload.summary).toBe('string');
    // matrix collapse: two failing jobs, identical excerpt → ONE failure entry
    expect(payload.failures.length).toBe(1);
    expect(payload.failures[0].excerpt).toContain('(fail) widget > renders');
    expect(payload.failures[0].excerpt).toContain('error: boom');
    expect(payload.failures[0].alsoFailedOn).toBe(1);
    // green checks never appear as failures
    expect(payload.failures.some((f) => f.name === 'lint')).toBe(false);
    // review threads include CodeRabbit
    expect(payload.reviewThreads.length).toBe(1);
    expect(payload.reviewThreads[0].threadId).toBe('T1');
    expect(payload.reviewThreads[0].author).toBe('coderabbitai');
  });

  test('only fetches logs for FAILED checks (never for green ones)', async () => {
    const { adapter, runGh, runPass, ghCalls } = makeCtx();
    await gatherPullSignal({
      pr: '5', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter, runGh, runPass, self: 'me',
    });
    expect(ghCalls.some((c) => c.includes('333'))).toBe(false); // lint (green) job never fetched
    expect(ghCalls.some((c) => c.includes('111'))).toBe(true);
  });

  test('a failing log fetch degrades to an empty excerpt without sinking the payload', async () => {
    const { adapter, runPass } = makeCtx({
      checks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/999' }],
      required: ['unit'],
    });
    const runGh = () => { throw new Error('gh exploded'); };
    const payload = await gatherPullSignal({
      pr: '5', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter, runGh, runPass, self: 'me',
    });
    expect(payload.failures.length).toBe(1);
    expect(payload.failures[0].excerpt).toBe('');
  });
});
