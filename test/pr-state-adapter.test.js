'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { PrStateAdapter, PR_VIEW_FIELDS } = require('../lib/adapters/pr-state-adapter');
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

  test('PR_VIEW_FIELDS excludes reviewThreads (not a valid gh pr view --json field)', () => {
    // Regression guard: requesting `reviewThreads` via `gh pr view --json` makes gh
    // exit non-zero ("Unknown JSON field"), which crashed readState on every real PR.
    // Review threads must be read via GraphQL (readComments), never gh pr view.
    expect(PR_VIEW_FIELDS.split(',')).not.toContain('reviewThreads');
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

// Fields the monitor bundle (lib/pr-bundle.js) depends on. These are additive to
// the read surface; the shepherd's existing consumers ignore them.
describe('PrStateAdapter — bundle gather fields', () => {
  test('PR_VIEW_FIELDS requests mergeable and readState surfaces it', async () => {
    expect(PR_VIEW_FIELDS.split(',')).toContain('mergeable');
    const { run } = makeRunner([
      ['pr view', JSON.stringify({
        headRefOid: 'abc', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY',
        state: 'OPEN', statusCheckRollup: [],
      })],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const state = await adapter.readState('123');
    expect(state.mergeable).toBe('CONFLICTING');
  });

  test('readState defaults mergeable to UNKNOWN when gh omits it', async () => {
    const { run } = makeRunner([['pr view', PR_VIEW_JSON]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const state = await adapter.readState('123');
    expect(state.mergeable).toBe('UNKNOWN');
  });

  test('readComments surfaces threadId, path and line per thread', async () => {
    const graphqlJson = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [
        {
          id: 'PRRT_1', isResolved: false, isOutdated: false, path: 'src/a.js', line: 42,
          comments: { nodes: [{ author: { login: 'coderabbitai' }, body: 'nit' }] },
        },
      ] } } } },
    });
    const { run, calls } = makeRunner([['api graphql', graphqlJson]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const threads = await adapter.readComments({ owner: 'o', repo: 'r', pr: '7' });

    expect(threads[0].threadId).toBe('PRRT_1');
    expect(threads[0].path).toBe('src/a.js');
    expect(threads[0].line).toBe(42);
    expect(threads[0].comments[0].author).toBe('coderabbitai');
    // the GraphQL query must actually request the new fields
    const q = calls.find((c) => c.args.join(' ').includes('graphql')).args.join(' ');
    expect(q).toContain('id isResolved');
    expect(q).toContain('path line');
  });

  test('readComments surfaces the REST commentId (fullDatabaseId) for replies', async () => {
    const graphqlJson = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [
        {
          id: 'PRRT_1', isResolved: false, isOutdated: false, path: 'src/a.js', line: 42,
          comments: { nodes: [{ fullDatabaseId: '987654321', author: { login: 'coderabbitai' }, body: 'nit' }] },
        },
      ] } } } },
    });
    const { run, calls } = makeRunner([['api graphql', graphqlJson]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const threads = await adapter.readComments({ owner: 'o', repo: 'r', pr: '7' });

    expect(threads[0].comments[0].commentId).toBe('987654321');
    // the GraphQL query must actually request the comment database id
    const q = calls.find((c) => c.args.join(' ').includes('graphql')).args.join(' ');
    expect(q).toContain('fullDatabaseId');
  });

  test('readComments coerces a missing line to null', async () => {
    const graphqlJson = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [
        { id: 'T', isResolved: false, isOutdated: false, path: 'f', line: null, comments: { nodes: [] } },
      ] } } } },
    });
    const { run } = makeRunner([['api graphql', graphqlJson]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const threads = await adapter.readComments({ owner: 'o', repo: 'r', pr: '7' });
    expect(threads[0].line).toBeNull();
  });

  test('readComments paginates reviewThreads AND nested comments until exhausted', async () => {
    // Page 1: thread A (comments complete inline) + more threads to come.
    const outerPage1 = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: true, endCursor: 'C1' },
        nodes: [{
          id: 'PRRT_A', isResolved: false, isOutdated: false, path: 'a.js', line: 1,
          comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ author: { login: 'bot' }, body: 'a1' }] },
        }],
      } } } },
    });
    // Page 2 (after=C1): thread B whose comment chain itself spills to a 2nd page.
    const outerPage2 = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: 'C1' },
        nodes: [{
          id: 'PRRT_B', isResolved: false, isOutdated: false, path: 'b.js', line: 2,
          comments: { pageInfo: { hasNextPage: true, endCursor: 'CB1' }, nodes: [{ author: { login: 'bot' }, body: 'b1' }] },
        }],
      } } } },
    });
    // Remaining comments of thread B, fetched by node id.
    const innerCommentsPage = JSON.stringify({
      data: { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ author: { login: 'human' }, body: 'b2' }] } } },
    });
    // Order matters: inner (id=) before the generic after= rule; page-1 has neither.
    const { run, calls } = makeRunner([
      ['id=PRRT_B', innerCommentsPage],
      ['after=C1', outerPage2],
      ['api graphql', outerPage1],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const threads = await adapter.readComments({ owner: 'o', repo: 'r', pr: '7' });

    // Both pages of threads are present (no 100-cap drop).
    expect(threads.map((t) => t.threadId)).toEqual(['PRRT_A', 'PRRT_B']);
    // Thread B's full comment chain spans both pages (later human reply preserved).
    expect(threads[1].comments.map((c) => c.body)).toEqual(['b1', 'b2']);
    // The first page must NOT send an `after` cursor (null cursor = from the start).
    const firstGraphql = calls.find((c) => c.args.join(' ').includes('reviewThreads'));
    expect(firstGraphql.args.join(' ')).not.toContain('after=');
    // The query declares the cursor variable + pageInfo on both connections.
    expect(firstGraphql.args.join(' ')).toContain('pageInfo{hasNextPage endCursor}');
  });

  test('detectConflicts reports a clean merge when merge-tree exits 0', async () => {
    const { run, calls } = makeRunner([['merge-tree', 'TREEOID\n']]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const res = await adapter.detectConflicts({ baseRef: 'origin/master' });
    expect(res).toEqual({ supported: true, conflicted: false, files: [] });
    const call = calls.find((c) => c.args.join(' ').includes('merge-tree'));
    expect(call.args).toContain('--write-tree');
    expect(call.args).toContain('--name-only');
  });

  test('detectConflicts parses conflicted files from a merge-tree exit-1 failure', async () => {
    // git merge-tree exits 1 on a conflicted merge; the OID is line 1, then paths.
    const err = new Error('conflict');
    err.status = 1;
    err.stdout = 'TREEOID\nsrc/a.js\nsrc/b.js\n';
    const { run } = makeRunner([['merge-tree', () => { throw err; }]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const res = await adapter.detectConflicts({ baseRef: 'origin/master' });
    expect(res.supported).toBe(true);
    expect(res.conflicted).toBe(true);
    expect(res.files).toEqual(['src/a.js', 'src/b.js']);
  });

  test('detectConflicts degrades to unsupported on a non-conflict error (e.g. old git)', async () => {
    const err = new Error('unknown option --write-tree');
    err.status = 129;
    const { run } = makeRunner([['merge-tree', () => { throw err; }]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const res = await adapter.detectConflicts({ baseRef: 'origin/master' });
    expect(res.supported).toBe(false);
    expect(res.reason).toContain('--write-tree');
  });

  test('readState maps a StatusContext (commit-status, no conclusion) into the same shape as a CheckRun', async () => {
    // Vercel/Netlify report via the legacy commit-Status API — statusCheckRollup
    // entries carry `context`+`state`+`targetUrl` (no name/conclusion/detailsUrl).
    const rollupJson = JSON.stringify({
      headRefOid: 'sha',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [
        { __typename: 'StatusContext', context: 'Vercel', state: 'FAILURE', targetUrl: 'https://vercel.com/x' },
        { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://gh/job/1' },
      ],
    });
    const { run } = makeRunner([['pr view', rollupJson]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const state = await adapter.readState('7');
    const vercel = state.checks.find((c) => c.name === 'Vercel');
    expect(vercel).toBeDefined();
    expect(vercel.conclusion).toBe('FAILURE'); // state → conclusion
    expect(vercel.detailsUrl).toBe('https://vercel.com/x'); // targetUrl → detailsUrl
  });

  test('readIssueComments returns author/authorTypename/body/createdAt from paginated GraphQL', async () => {
    const page = JSON.stringify({
      data: { repository: { pullRequest: { comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          { author: { __typename: 'Bot', login: 'sonarqubecloud' }, body: 'Quality Gate failed', createdAt: '2026-07-12T10:00:00Z' },
          { author: { __typename: 'User', login: 'a-human' }, body: 'thanks', createdAt: '2026-07-12T11:00:00Z' },
        ],
      } } } },
    });
    const { run, calls } = makeRunner([['api graphql', page]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const comments = await adapter.readIssueComments({ owner: 'o', repo: 'r', pr: '7' });
    expect(comments).toHaveLength(2);
    // The actor TYPE is surfaced so a bot direct-comment is detectable by mechanism.
    expect(comments[0]).toEqual({ author: 'sonarqubecloud', authorTypename: 'Bot', body: 'Quality Gate failed', createdAt: '2026-07-12T10:00:00Z' });
    expect(comments[1].authorTypename).toBe('User');
    expect(calls.some((c) => [c.cmd, ...c.args].join(' ').includes('api graphql'))).toBe(true);
  });

  test('readReviews constructs a GraphQL request and keeps the LATEST review per author with commitOid', async () => {
    const page = JSON.stringify({
      data: { repository: { pullRequest: { reviews: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          // Oldest→newest: coderabbitai's second review supersedes its first.
          { author: { __typename: 'Bot', login: 'coderabbitai' }, state: 'COMMENTED', submittedAt: '2026-07-12T09:00:00Z', commit: { oid: 'old-sha' }, body: 'first pass' },
          { author: { __typename: 'Bot', login: 'coderabbitai' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-07-12T10:00:00Z', commit: { oid: 'head-sha' }, body: 'second pass' },
          { author: { __typename: 'User', login: 'alice' }, state: 'APPROVED', submittedAt: '2026-07-12T11:00:00Z', commit: { oid: 'head-sha' }, body: 'lgtm' },
        ],
      } } } },
    });
    const { run, calls } = makeRunner([['reviews(first', page]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const reviews = await adapter.readReviews({ owner: 'o', repo: 'r', pr: '7' });

    // Latest-per-author: coderabbitai collapses to its newer (second) review.
    expect(reviews).toHaveLength(2);
    const cr = reviews.find((r) => r.author === 'coderabbitai');
    expect(cr).toEqual({ author: 'coderabbitai', authorTypename: 'Bot', state: 'CHANGES_REQUESTED', submittedAt: '2026-07-12T10:00:00Z', commitOid: 'head-sha', body: 'second pass' });
    const alice = reviews.find((r) => r.author === 'alice');
    expect(alice.commitOid).toBe('head-sha');
    expect(alice.authorTypename).toBe('User');
    // A GraphQL request was constructed (not a `gh pr view`).
    expect(calls.some((c) => [c.cmd, ...c.args].join(' ').includes('api graphql'))).toBe(true);
  });

  test('readReviews paginates until hasNextPage is false', async () => {
    let call = 0;
    const run = (cmd, args) => {
      const joined = [cmd, ...args].join(' ');
      if (!joined.includes('reviews(first')) return '';
      call += 1;
      if (call === 1) {
        return JSON.stringify({ data: { repository: { pullRequest: { reviews: {
          pageInfo: { hasNextPage: true, endCursor: 'CUR' },
          nodes: [{ author: { __typename: 'Bot', login: 'bot-a' }, state: 'COMMENTED', submittedAt: '2026-07-12T09:00:00Z', commit: { oid: 'x' }, body: '' }],
        } } } } });
      }
      return JSON.stringify({ data: { repository: { pullRequest: { reviews: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ author: { __typename: 'Bot', login: 'bot-b' }, state: 'COMMENTED', submittedAt: '2026-07-12T10:00:00Z', commit: { oid: 'y' }, body: '' }],
      } } } } });
    };
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const reviews = await adapter.readReviews({ owner: 'o', repo: 'r', pr: '7' });
    expect(call).toBe(2); // followed the cursor
    expect(reviews.map((r) => r.author).sort()).toEqual(['bot-a', 'bot-b']);
  });

  test('readHeadCommitTime parses the head commit committedDate to epoch ms', async () => {
    const iso = '2026-07-12T10:00:00Z';
    const { run, calls } = makeRunner([['.commits[-1].committedDate', iso]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const t = await adapter.readHeadCommitTime({ pr: '7' });
    expect(t).toBe(Date.parse(iso));
    // Requests the commits field with a jq projection (not the whole PR).
    expect(calls.some((c) => [c.cmd, ...c.args].join(' ').includes('--json commits'))).toBe(true);
  });

  test('readHeadCommitTime returns null for an invalid or unreadable value', async () => {
    const bad = makeRunner([['.commits[-1].committedDate', 'not-a-date']]);
    expect(await new PrStateAdapter({ gh: bad.run, git: bad.run }).readHeadCommitTime({ pr: '7' })).toBeNull();
    // Empty output (e.g. an unreadable/edge PR) → null, never NaN.
    const empty = makeRunner([]);
    expect(await new PrStateAdapter({ gh: empty.run, git: empty.run }).readHeadCommitTime({ pr: '7' })).toBeNull();
  });
});
