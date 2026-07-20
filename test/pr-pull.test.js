'use strict';

const { describe, test, expect } = require('bun:test');

const {
  cleanLogLine,
  extractFailureExcerpt,
  jobIdFromUrl,
  dedupeFailures,
  buildReviewThreads,
  classifyRequiredChecks,
  pendingCheckNames,
  computeBlockers,
  renderPullSummary,
  buildPullPayload,
  gatherPullSignal,
  buildBotStatusBlockers,
  STATUS_BOT_LOGINS,
  computeVerdict,
  verdictToLegacyState,
  legacyStateFor,
  verdictLabel,
  VERDICT_LABELS,
  MERGE_VERDICTS,
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

describe('classifyRequiredChecks (required-vs-produced)', () => {
  const green = (name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
  const fail = (name) => ({ name, status: 'COMPLETED', conclusion: 'FAILURE' });
  const skip = (name) => ({ name, status: 'COMPLETED', conclusion: 'SKIPPED' });
  const running = (name) => ({ name, status: 'IN_PROGRESS', conclusion: '' });

  test('a required context that never reported is MISSING', () => {
    const out = classifyRequiredChecks([green('Lint')], ['Lint', 'CodeQL']);
    expect(out.missing).toEqual(['CodeQL']);
    expect(out.skipped).toEqual([]);
  });

  test('a required context that only SKIPPED is a policy-block (the all-green-but-BLOCKED cause)', () => {
    const out = classifyRequiredChecks([skip('Cross-OS Gate'), green('Lint')], ['Cross-OS Gate', 'Lint']);
    expect(out.skipped).toEqual(['Cross-OS Gate']);
    expect(out.failing).toEqual([]);
    expect(out.missing).toEqual([]);
  });

  test('failing beats pending beats skipped when a matrix reports the same context multiple times', () => {
    const checks = [skip('Gate'), running('Gate'), fail('Gate')];
    expect(classifyRequiredChecks(checks, ['Gate']).failing).toEqual(['Gate']);
    expect(classifyRequiredChecks([skip('Gate'), running('Gate')], ['Gate']).pending).toEqual(['Gate']);
  });

  test('a genuinely green required check appears in NONE of the actionable buckets', () => {
    const out = classifyRequiredChecks([green('Lint'), skip('Lint')], ['Lint']);
    expect(out.missing).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(out.pending).toEqual([]);
    expect(out.failing).toEqual([]);
  });

  test('a null (unreadable) required set is flagged, not guessed', () => {
    const out = classifyRequiredChecks([green('Lint')], null);
    expect(out.unreadable).toBe(true);
  });

  test('a rollup-sourced required set (isRequired fallback) still flags failing/pending', () => {
    // The fallback returns the SAME string[] shape as branch protection, so the
    // required-vs-produced classification is source-agnostic — a set recovered
    // from statusCheckRollup.isRequired classifies identically to a protection set.
    const requiredFromRollup = ['Cross-OS Gate', 'Run eslint scanning'];
    const out = classifyRequiredChecks(
      [fail('Cross-OS Gate'), running('Run eslint scanning')],
      requiredFromRollup,
    );
    expect(out.failing).toEqual(['Cross-OS Gate']);
    expect(out.pending).toEqual(['Run eslint scanning']);
    expect(out.unreadable).toBe(false);
  });
});

describe('pendingCheckNames', () => {
  test('returns unique names of only the in-flight checks', () => {
    const checks = [
      { name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'b', status: 'IN_PROGRESS', conclusion: '' },
      { name: 'b', status: 'QUEUED', conclusion: '' },
      { name: 'c', status: 'COMPLETED', conclusion: 'FAILURE' },
    ];
    expect(pendingCheckNames(checks)).toEqual(['b']);
  });
});

describe('computeBlockers (the human-readable WHY)', () => {
  test('surfaces unresolved review threads as a blocker (the live #353 cause)', () => {
    const blockers = computeBlockers({
      mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
      unresolvedThreadCount: 2,
    });
    const types = blockers.map((b) => b.type);
    expect(types).toContain('unresolved-threads');
    // no phantom blockers for things that are fine
    expect(types).not.toContain('draft');
    expect(types).not.toContain('behind');
  });

  test('a SKIPPED required check produces an explicit policy-block blocker', () => {
    const blockers = computeBlockers({
      mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
      requiredClass: { missing: [], skipped: ['Cross-OS Gate'], pending: [], failing: [] },
    });
    expect(blockers.some((b) => b.type === 'check-skipped')).toBe(true);
  });

  test('behind-base, conflicts, draft, and changes-requested each surface', () => {
    expect(computeBlockers({ mergeStateStatus: 'BEHIND', behind: 3 }).some((b) => b.type === 'behind')).toBe(true);
    expect(computeBlockers({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING', conflicts: { conflicted: true, files: ['a.js'] } }).some((b) => b.type === 'conflict')).toBe(true);
    expect(computeBlockers({ mergeStateStatus: 'BLOCKED', draft: true }).some((b) => b.type === 'draft')).toBe(true);
    expect(computeBlockers({ mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' }).some((b) => b.type === 'changes-requested')).toBe(true);
  });

  test('APPROVED review decision is NOT a blocker (actionable-only)', () => {
    const blockers = computeBlockers({ mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' });
    expect(blockers.some((b) => b.type === 'changes-requested' || b.type === 'review-required')).toBe(false);
  });

  test('BLOCKED with no derivable cause still emits an explicit "blocked-unknown" so it is never invisible', () => {
    const blockers = computeBlockers({ mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' });
    expect(blockers).toHaveLength(1);
    expect(blockers[0].type).toBe('blocked-unknown');
  });

  test('a clean, mergeable PR has zero blockers', () => {
    expect(computeBlockers({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })).toEqual([]);
  });

  test('a predicted conflict with an empty files list still fires a conflict blocker (payload/blocker consistency)', () => {
    // conflicts.conflicted is true but files is empty AND mergeable/status do not
    // literally say CONFLICTING/DIRTY — the blocker must still fire so the
    // payload's conflicts object and blockers[] never disagree.
    const blockers = computeBlockers({
      mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
      conflicts: { conflicted: true, files: [] },
    });
    const conflict = blockers.find((b) => b.type === 'conflict');
    expect(conflict).toBeDefined();
    expect(conflict.detail).toMatch(/conflict/i);
  });

  test('BEHIND status with no derivable commit count still surfaces a fallback blocker', () => {
    // The #363 edge: mergeStateStatus=BEHIND but `behind` is unavailable (0) —
    // the PR is not mergeable, so it must not report "none detected".
    const blockers = computeBlockers({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', behind: 0 });
    expect(blockers.length).toBeGreaterThan(0);
  });

  test('unreadable required checks (branch-protection 403) surface as an explicit blocker', () => {
    const blockers = computeBlockers({
      mergeable: 'UNKNOWN', mergeStateStatus: 'BLOCKED',
      requiredClass: { missing: [], skipped: [], pending: [], failing: [], unreadable: true },
    });
    expect(blockers.some((b) => b.type === 'check-required-unreadable')).toBe(true);
  });
});

describe('renderPullSummary', () => {
  test('renders the merge state, numbered blockers, and thread locations', () => {
    const text = renderPullSummary({
      pr: '353', state: 'NEEDS_REVIEW', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
      blockers: [{ type: 'unresolved-threads', detail: '2 unresolved review thread(s) must be resolved before merge (see reviewThreads[]).' }],
      failures: [],
      reviewThreads: [{ file: 'lib/x.js', line: 44, author: 'coderabbitai', body: 'guard null' }],
    });
    expect(text).toContain('PR #353');
    expect(text).toContain('mergeStateStatus=BLOCKED');
    expect(text).toContain('[unresolved-threads]');
    expect(text).toContain('lib/x.js:44');
    expect(text).toContain('coderabbitai');
  });
});

describe('buildPullPayload (extended actionable-only fields)', () => {
  test('omits reviewDecision when APPROVED, includes it when CHANGES_REQUESTED', () => {
    const approved = buildPullPayload({ state: 'PENDING', summary: 's', reviewDecision: 'APPROVED', failures: [], reviewThreads: [] });
    expect(approved.reviewDecision).toBeUndefined();
    const changes = buildPullPayload({ state: 'PENDING', summary: 's', reviewDecision: 'CHANGES_REQUESTED', failures: [], reviewThreads: [] });
    expect(changes.reviewDecision).toBe('CHANGES_REQUESTED');
  });

  test('omits the requiredChecks block entirely when the required set is all green', () => {
    const payload = buildPullPayload({
      state: 'MERGE_READY', summary: 's',
      requiredChecks: { missing: [], skipped: [], pending: [], failing: [], unreadable: false },
      failures: [], reviewThreads: [],
    });
    expect(payload.requiredChecks).toBeUndefined();
  });

  test('includes requiredChecks + behind + conflicts only when actionable', () => {
    const payload = buildPullPayload({
      state: 'ESCALATE', summary: 's',
      requiredChecks: { missing: [], skipped: ['Gate'], pending: [], failing: [], unreadable: false },
      behind: 4,
      conflicts: { conflicted: true, files: ['a.js', 'b.js'] },
      failures: [], reviewThreads: [],
    });
    expect(payload.requiredChecks.skipped).toEqual(['Gate']);
    expect(payload.behind).toBe(4);
    expect(payload.conflicts.files).toEqual(['a.js', 'b.js']);
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

    // `state` is now DERIVED from the verdict (verdictToLegacyState), not from the
    // injected runPass: failing required matrix checks → BLOCKED-CHECKS → PENDING.
    expect(payload.state).toBe('PENDING');
    expect(payload.verdict).toBe('BLOCKED-CHECKS');
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

  test('is STRICTLY read-only: never fires a Tier-A rerun mutation on a failing required check', async () => {
    // --pull derives its verdict/state from a read-only snapshot and NEVER runs the
    // acting decision pass, so a FAILING required check (the path that would rerun
    // under `forge shepherd`) must NOT mutate CI here.
    let rerunCalls = 0;
    const checks = [
      { name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/111' },
    ];
    const adapter = {
      id: 'fake', kind: 'pr-state',
      async readState() { return { headSha: 's', state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', checks, threads: [] }; },
      async readRequiredChecks() { return ['unit']; },
      async readDivergence() { return { behind: 0, ahead: 1 }; },
      async readComments() { return []; },
      async rerunFailedChecks() { rerunCalls += 1; }, // MUST never be called
    };
    const ghCalls = [];
    const runGh = (args) => { ghCalls.push(args.join(' ')); return '2026-07-10T12:00:01.2Z (fail) unit > x\nerror: boom'; };

    const payload = await gatherPullSignal({
      pr: '5', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter, runGh, self: 'me', // note: NO runPass injected → real runShepherdPass
    });

    expect(rerunCalls).toBe(0); // no CI mutation
    expect(ghCalls.some((c) => c.includes('rerun'))).toBe(false); // runGh never asked to rerun
    expect(payload.state).toBeDefined(); // state still computed
    expect(payload.failures.length).toBe(1); // and the failure excerpt still extracted
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

  test('surfaces mergeState, blockers, failing-required + unresolved-threads together', async () => {
    const { adapter, runGh, runPass } = makeCtx();
    const payload = await gatherPullSignal({
      pr: '5', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter, runGh, runPass, self: 'me',
    });
    expect(payload.mergeStateStatus).toBe('BLOCKED');
    expect(payload.mergeable).toBe('MERGEABLE');
    const types = payload.blockers.map((b) => b.type);
    expect(types).toContain('check-failing'); // required matrix checks are FAILURE
    expect(types).toContain('unresolved-threads'); // the CodeRabbit thread
    expect(payload.requiredChecks.failing).toContain('test (ubuntu, 20)');
  });

  test('models the live #353 case: all-green required + BLOCKED + unresolved CodeRabbit thread', async () => {
    // All required checks green (incl. a matrix that reports twice), NOT behind,
    // reviewDecision empty, but 2 unresolved CodeRabbit threads → BLOCKED by
    // required-conversation-resolution. The payload must name that cause and the threads.
    const checks = [
      { name: 'CodeQL', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'Cross-OS Gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'Cross-OS Gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'Beads Integration', status: 'COMPLETED', conclusion: 'SKIPPED' }, // not required → ignored
    ];
    const threads = [
      { threadId: 'PRRT_a', path: 'lib/workflow/stage-transition.js', line: 44, isResolved: false, isOutdated: false, comments: [{ author: 'coderabbitai', body: 'Functional Correctness | Minor', commentId: '111' }] },
      { threadId: 'PRRT_b', path: 'lib/workflow/stage-transition.js', line: 77, isResolved: false, isOutdated: false, comments: [{ author: 'coderabbitai', body: 'Data Integrity | Major', commentId: '222' }] },
    ];
    const adapter = {
      id: 'fake', kind: 'pr-state',
      async readState() { return { headSha: 's', state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: null, isDraft: false, checks, threads: [] }; },
      async readRequiredChecks() { return ['CodeQL', 'Cross-OS Gate']; },
      async readDivergence() { return { behind: 0, ahead: 2 }; },
      async detectConflicts() { return { supported: true, conflicted: false, files: [] }; },
      async readComments() { return threads; },
    };
    const payload = await gatherPullSignal({
      pr: '353', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter, runGh: () => '', runPass: async () => ({ state: 'NEEDS_REVIEW', reason: 'threads' }), self: 'me',
    });
    expect(payload.mergeStateStatus).toBe('BLOCKED');
    // No required-check block: every required context is green → actionable-only omits it.
    expect(payload.requiredChecks).toBeUndefined();
    // The one and only blocker is the unresolved threads — named explicitly.
    expect(payload.blockers.map((b) => b.type)).toEqual(['unresolved-threads']);
    expect(payload.reviewThreads).toHaveLength(2);
    expect(payload.reviewThreads[0]).toMatchObject({ file: 'lib/workflow/stage-transition.js', line: 44, author: 'coderabbitai', threadId: 'PRRT_a', commentId: '111' });
    expect(payload.behind).toBeUndefined(); // not behind → omitted
  });

  test('behind base → a behind blocker with the commit count', async () => {
    const adapter = {
      id: 'fake', kind: 'pr-state',
      async readState() { return { headSha: 's', state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', checks: [], threads: [] }; },
      async readRequiredChecks() { return []; },
      async readDivergence() { return { behind: 5, ahead: 1 }; },
      async readComments() { return []; },
    };
    const payload = await gatherPullSignal({
      pr: '9', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter, runGh: () => '', runPass: async () => ({ state: 'ESCALATE', reason: 'behind' }), self: 'me',
    });
    expect(payload.behind).toBe(5);
    expect(payload.blockers.some((b) => b.type === 'behind')).toBe(true);
  });

  test('predicted merge conflicts → a conflict blocker listing the files', async () => {
    const adapter = {
      id: 'fake', kind: 'pr-state',
      async readState() { return { headSha: 's', state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', checks: [], threads: [] }; },
      async readRequiredChecks() { return []; },
      async readDivergence() { return { behind: 0, ahead: 1 }; },
      async detectConflicts() { return { supported: true, conflicted: true, files: ['lib/a.js', 'lib/b.js'] }; },
      async readComments() { return []; },
    };
    const payload = await gatherPullSignal({
      pr: '9', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter, runGh: () => '', runPass: async () => ({ state: 'ESCALATE', reason: 'conflict' }), self: 'me',
    });
    expect(payload.conflicts.files).toEqual(['lib/a.js', 'lib/b.js']);
    expect(payload.blockers.some((b) => b.type === 'conflict')).toBe(true);
  });

  test('a skipped REQUIRED check surfaces as the policy-block cause even when the rollup looks green', async () => {
    const checks = [
      { name: 'CodeQL', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'Cross-OS Gate', status: 'COMPLETED', conclusion: 'SKIPPED' },
    ];
    const adapter = {
      id: 'fake', kind: 'pr-state',
      async readState() { return { headSha: 's', state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', checks, threads: [] }; },
      async readRequiredChecks() { return ['CodeQL', 'Cross-OS Gate']; },
      async readDivergence() { return { behind: 0, ahead: 1 }; },
      async readComments() { return []; },
    };
    const payload = await gatherPullSignal({
      pr: '9', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter, runGh: () => '', runPass: async () => ({ state: 'ESCALATE', reason: 'skipped required' }), self: 'me',
    });
    expect(payload.requiredChecks.skipped).toEqual(['Cross-OS Gate']);
    expect(payload.blockers.some((b) => b.type === 'check-skipped')).toBe(true);
  });

  test('a failing StatusContext (Vercel-style ERROR) is classified as a failing required check', async () => {
    // GAP 1: Vercel/Netlify report via the legacy commit-Status API (StatusContext,
    // state=ERROR/FAILURE), not a CheckRun. The rollup normalizes state → conclusion,
    // so an ERROR status must classify as FAILING (previously it looked "pending").
    const checks = [
      { name: 'Vercel', status: '', conclusion: 'ERROR', detailsUrl: 'https://vercel.com/x/deployments/abc' },
      { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ];
    const adapter = {
      id: 'fake', kind: 'pr-state',
      async readState() { return { headSha: 's', state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', checks, threads: [] }; },
      async readRequiredChecks() { return ['Vercel', 'unit']; },
      async readDivergence() { return { behind: 0, ahead: 1 }; },
      async readComments() { return []; },
    };
    const payload = await gatherPullSignal({
      pr: '9', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter, runGh: () => '', runPass: async () => ({ state: 'ESCALATE', reason: 'vercel error' }), self: 'me',
    });
    expect(payload.requiredChecks.failing).toContain('Vercel');
    expect(payload.blockers.some((b) => b.type === 'check-failing')).toBe(true);
  });

  test('a failing bot status COMMENT (SonarCloud quality gate) surfaces as a bot-status blocker', async () => {
    // GAP 2: SonarCloud posts a Quality-Gate summary as a plain PR issue comment,
    // NOT a resolvable review thread — the thread path never sees it.
    const adapter = {
      id: 'fake', kind: 'pr-state',
      async readState() { return { headSha: 's', state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', checks: [], threads: [] }; },
      async readRequiredChecks() { return []; },
      async readDivergence() { return { behind: 0, ahead: 1 }; },
      async readComments() { return []; },
      async readIssueComments() {
        return [{ author: 'sonarqubecloud', body: '## Quality Gate failed\n❌ 3 New issues', createdAt: '2026-07-12T10:00:00Z' }];
      },
    };
    const payload = await gatherPullSignal({
      pr: '9', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter, runGh: () => '', runPass: async () => ({ state: 'NEEDS_REVIEW', reason: 'quality gate' }), self: 'me',
    });
    const bs = payload.blockers.find((b) => b.type === 'bot-status');
    expect(bs).toBeDefined();
    expect(bs.detail).toMatch(/sonarqubecloud/i);
    expect(bs.detail).toMatch(/quality gate failed/i);
  });

  test('a bot whose LATEST comment is a success does NOT surface (superseded)', async () => {
    const adapter = {
      id: 'fake', kind: 'pr-state',
      async readState() { return { headSha: 's', state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: [], threads: [] }; },
      async readRequiredChecks() { return []; },
      async readDivergence() { return { behind: 0, ahead: 1 }; },
      async readComments() { return []; },
      async readIssueComments() {
        return [
          { author: 'vercel', body: '❌ Deployment failed', createdAt: '2026-07-12T10:00:00Z' },
          { author: 'vercel', body: '✅ Deployment has completed — Ready', createdAt: '2026-07-12T11:00:00Z' },
        ];
      },
    };
    const payload = await gatherPullSignal({
      pr: '9', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter, runGh: () => '', runPass: async () => ({ state: 'MERGE_READY', reason: 'clean' }), self: 'me',
    });
    expect(payload.blockers.some((b) => b.type === 'bot-status')).toBe(false);
  });
});

describe('buildBotStatusBlockers (bot status/deploy/quality comment scanner)', () => {
  test('surfaces a failing Vercel deployment comment', () => {
    const out = buildBotStatusBlockers([
      { author: 'vercel', body: 'Latest commit\n❌  Failed — Deployment error', createdAt: '2026-07-12T10:00:00Z' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('bot-status');
    expect(out[0].detail).toMatch(/vercel/i);
  });

  test('surfaces a failing Codecov comment (an "automation" bot for threads, but its status comment is actionable)', () => {
    const out = buildBotStatusBlockers([
      { author: 'codecov[bot]', body: '❌ Patch coverage decreased below threshold', createdAt: '2026-07-12T10:00:00Z' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].detail).toMatch(/codecov/i);
  });

  test('a later SUCCESS comment supersedes an earlier failure (uses timestamps, not array order)', () => {
    const out = buildBotStatusBlockers([
      { author: 'sonarqubecloud', body: 'Quality Gate passed ✅', createdAt: '2026-07-12T11:00:00Z' },
      { author: 'sonarqubecloud', body: 'Quality Gate failed ❌', createdAt: '2026-07-12T10:00:00Z' },
    ]);
    expect(out).toHaveLength(0);
  });

  test('ignores comments from non-status bots and humans', () => {
    const out = buildBotStatusBlockers([
      { author: 'coderabbitai', body: 'Quality issue: guard null ❌', createdAt: '2026-07-12T10:00:00Z' },
      { author: 'a-human', body: 'this deployment failed for me too ❌', createdAt: '2026-07-12T10:00:00Z' },
    ]);
    expect(out).toHaveLength(0);
  });

  test('a healthy latest status comment is not a blocker', () => {
    const out = buildBotStatusBlockers([
      { author: 'netlify', body: '✅ Deploy Preview ready!', createdAt: '2026-07-12T10:00:00Z' },
    ]);
    expect(out).toHaveLength(0);
  });

  test('STATUS_BOT_LOGINS covers the named deploy/quality bots', () => {
    for (const login of ['vercel', 'netlify', 'sonarqubecloud', 'codecov', 'cloudflare-pages', 'render']) {
      expect(STATUS_BOT_LOGINS.has(login)).toBe(true);
    }
  });
});

describe('computeBlockers with bot-status blockers', () => {
  test('bot-status blockers are folded into the ordered blocker list', () => {
    const blockers = computeBlockers({
      mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
      botStatusBlockers: [{ type: 'bot-status', detail: 'vercel reports a failing status: ❌ Failed' }],
    });
    expect(blockers.some((b) => b.type === 'bot-status')).toBe(true);
  });

  test('a bot-status failure is enough to avoid the blocked-unknown fallback', () => {
    const blockers = computeBlockers({
      mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
      botStatusBlockers: [{ type: 'bot-status', detail: 'sonarqubecloud reports a failing status: Quality Gate failed' }],
    });
    expect(blockers.some((b) => b.type === 'blocked-unknown')).toBe(false);
    expect(blockers.some((b) => b.type === 'bot-status')).toBe(true);
  });
});

// Regression for c01936be: `forge shepherd --pull --json` must emit a `.verdict`.
// The CLI prints `JSON.stringify(pull)`, and `pull` is what buildPullPayload
// returns — so guarding that buildPullPayload carries `verdict` (and that
// computeVerdict only produces canonical enum values) locks the surface.
describe('pull payload carries the merge verdict (c01936be regression)', () => {
  test('buildPullPayload includes the top-level verdict field', () => {
    const payload = buildPullPayload({
      pr: '7', state: 'ESCALATE', verdict: 'BEHIND', summary: 's',
      mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', behind: 3,
    });
    expect(payload.verdict).toBe('BEHIND');
  });

  test('computeVerdict only ever returns a value in the canonical MERGE_VERDICTS set', () => {
    const inputs = [
      {},
      { mergeStateStatus: 'DIRTY' },
      { behind: 5 },
      { requiredChecks: { failing: ['x'], missing: [], skipped: [], pending: [], unreadable: false } },
      { unresolvedThreadCount: 2 },
      { mergeStateStatus: 'CLEAN', headPushKnown: true },
    ];
    for (const input of inputs) {
      const { verdict } = computeVerdict(input);
      expect(MERGE_VERDICTS).toContain(verdict);
    }
  });

  test('verdictLabel maps every canonical verdict into the reconcile set (fail-closed)', () => {
    for (const v of MERGE_VERDICTS) expect(VERDICT_LABELS).toContain(verdictLabel(v));
    expect(verdictLabel('')).toBe('pr-verdict:unknown');
    expect(verdictLabel('not-a-verdict')).toBe('pr-verdict:unknown');
  });
});

// verdictToLegacyState is the SINGLE source that maps the canonical 7-enum
// verdict onto the deprecated `runShepherdPass` ladder for back-compat consumers.
// The read-only `--pull` payload no longer runs a second decision pass to compute
// `state` independently — it derives `state` from `verdict` through this one map,
// so the two vocabularies can never disagree.
describe('verdictToLegacyState (verdict → deprecated legacy ladder, single source)', () => {
  test('maps every canonical verdict to a legacy terminal state', () => {
    expect(verdictToLegacyState('CLEAN-MERGEABLE')).toBe('MERGE_READY');
    expect(verdictToLegacyState('REVIEW-PENDING')).toBe('NEEDS_REVIEW');
    expect(verdictToLegacyState('BLOCKED-THREADS')).toBe('NEEDS_REVIEW');
    expect(verdictToLegacyState('BLOCKED-CHECKS')).toBe('PENDING');
    // BEHIND escalates (legacy handleBehindBase default) — not PENDING.
    expect(verdictToLegacyState('BEHIND')).toBe('ESCALATE');
    expect(verdictToLegacyState('BLOCKED-CONFLICT')).toBe('ESCALATE');
    expect(verdictToLegacyState('UNKNOWN')).toBe('UNKNOWN');
  });

  test('covers the whole MERGE_VERDICTS set (no verdict falls through)', () => {
    for (const v of MERGE_VERDICTS) {
      expect(typeof verdictToLegacyState(v)).toBe('string');
      expect(verdictToLegacyState(v)).not.toBe('');
    }
  });

  test('fails closed to UNKNOWN for empty / unrecognized input', () => {
    expect(verdictToLegacyState('')).toBe('UNKNOWN');
    expect(verdictToLegacyState(undefined)).toBe('UNKNOWN');
    expect(verdictToLegacyState('not-a-verdict')).toBe('UNKNOWN');
  });
});

describe('legacyStateFor (terminal lifecycle wins over the verdict projection)', () => {
  test('a MERGED / CLOSED lifecycle overrides the verdict', () => {
    // Regression: the old dry-run runShepherdPass emitted MERGED/CLOSED via
    // lifecycleOutcome, so a legacy `state` consumer stops polling a landed PR.
    expect(legacyStateFor('CLEAN-MERGEABLE', 'MERGED')).toBe('MERGED');
    expect(legacyStateFor('UNKNOWN', 'MERGED')).toBe('MERGED');
    expect(legacyStateFor('BLOCKED-CHECKS', 'CLOSED')).toBe('CLOSED');
    expect(legacyStateFor('REVIEW-PENDING', 'closed')).toBe('CLOSED');
  });

  test('an OPEN / absent lifecycle falls through to the verdict projection', () => {
    expect(legacyStateFor('CLEAN-MERGEABLE', 'OPEN')).toBe('MERGE_READY');
    expect(legacyStateFor('BEHIND', 'OPEN')).toBe('ESCALATE');
    expect(legacyStateFor('BLOCKED-CONFLICT', undefined)).toBe('ESCALATE');
    expect(legacyStateFor('UNKNOWN', '')).toBe('UNKNOWN');
  });
});

// Regression for 5291f2d2: the BEHIND verdict must track GitHub's actual blocking
// state (mergeStateStatus=BEHIND), NOT a raw compareCommits behind-count. A stale
// or non-blocking behind-count>0 must NOT escalate a mergeable PR to BEHIND, or the
// pr-verdict label falsely reads `behind` on a PR GitHub considers up-to-date.
describe('BEHIND verdict reconciles with mergeStateStatus (5291f2d2)', () => {
  const settled = { headOidStart: 'h', headOidEnd: 'h' };

  test('behind-count>0 but mss=UNSTABLE (the #402 case) is NOT BEHIND', () => {
    const { verdict } = computeVerdict({ mergeStateStatus: 'UNSTABLE', behind: 25, ...settled });
    expect(verdict).not.toBe('BEHIND');
    expect(verdict).toBe('BLOCKED-CHECKS'); // UNSTABLE routes to the checks rung
  });

  test('behind-count>0 but mss=CLEAN stays CLEAN-MERGEABLE (count ignored)', () => {
    const { verdict } = computeVerdict({
      mergeStateStatus: 'CLEAN', behind: 5, headPushKnown: true, ...settled,
    });
    expect(verdict).toBe('CLEAN-MERGEABLE');
  });

  test('mss=BEHIND still yields BEHIND (GitHub actually blocks)', () => {
    const { verdict } = computeVerdict({ mergeStateStatus: 'BEHIND', behind: 25, ...settled });
    expect(verdict).toBe('BEHIND');
  });

  test('mss=BEHIND yields BEHIND even when the commit count is unavailable', () => {
    const { verdict } = computeVerdict({ mergeStateStatus: 'BEHIND', behind: 0, ...settled });
    expect(verdict).toBe('BEHIND');
  });
});
