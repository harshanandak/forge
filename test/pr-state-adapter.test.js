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
  headRefOid: 'a'.repeat(40),
  state: 'OPEN',
  isDraft: false,
  mergeStateStatus: 'BLOCKED',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'optional-bench', status: 'COMPLETED', conclusion: 'FAILURE' },
  ],
  reviewThreads: [],
});

const REQUIRED_CHECKS_JSON = JSON.stringify({ contexts: ['unit', 'lint'] });

// A statusCheckRollup GraphQL payload with per-context `isRequired` — the shape
// `gh api graphql` returns and the fallback path reads when branch-protection is
// unreadable by the Actions token. Includes a StatusContext, a non-required
// CheckRun, and a matrix duplicate (must dedupe to ['unit', 'deploy/ok']).
const ROLLUP_REQUIRED_JSON = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        headRef: {
          target: {
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { __typename: 'CheckRun', name: 'unit', isRequired: true },
                  { __typename: 'CheckRun', name: 'optional-bench', isRequired: false },
                  { __typename: 'StatusContext', context: 'deploy/ok', isRequired: true },
                  { __typename: 'CheckRun', name: 'unit', isRequired: true },
                ],
              },
            },
          },
        },
      },
    },
  },
});

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

    expect(state.headSha).toBe('a'.repeat(40));
    expect(state.providerEvidenceReadable).toBe(true);
    expect(state.mergeStateStatus).toBe('BLOCKED');
    expect(state.checks).toHaveLength(3);
    expect(state.checks.find((c) => c.name === 'lint').conclusion).toBe('FAILURE');
  });

  test('pins every numeric PR read to the configured upstream repository', async () => {
    const committedAt = '2026-08-19T10:00:00.000Z';
    const { run, calls } = makeRunner([
      ['--json commits', committedAt],
      ['pr view', PR_VIEW_JSON],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run, repository: 'upstream/forge' });

    await adapter.readState('541');
    await adapter.readHeadCommitTime({ pr: '541' });

    const reads = calls.filter(call => call.cmd === 'gh' && call.args[0] === 'pr' && call.args[1] === 'view');
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.args).toEqual(expect.arrayContaining(['--repo', 'upstream/forge']));
    }
  });

  test('readState marks missing lifecycle fields and malformed optional rollup unreadable', async () => {
    for (const payload of [
      { headRefOid: 'a'.repeat(40), statusCheckRollup: [], isDraft: false },
      {
        headRefOid: 'a'.repeat(40), state: 'OPEN', isDraft: false,
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'optional' }],
      },
      {
        headRefOid: 'a'.repeat(40), state: 'OPEN', isDraft: false,
        mergeStateStatus: 'BOGUS', statusCheckRollup: [],
      },
      {
        headRefOid: 'a'.repeat(40), state: 'OPEN', isDraft: false,
        mergeStateStatus: 'UNKNOWN', statusCheckRollup: [],
      },
    ]) {
      const { run } = makeRunner([['pr view', JSON.stringify(payload)]]);
      const state = await new PrStateAdapter({ gh: run, git: run }).readState('123');
      expect(state.providerEvidenceReadable).toBe(false);
    }
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

  test('readRequiredCheckPolicy preserves app identity while the compatibility API returns names', async () => {
    const payload = JSON.stringify({
      contexts: ['unit', 'lint'],
      checks: [
        { context: 'unit', app_id: 15368 },
        { context: 'lint', app_id: null },
      ],
    });
    const { run } = makeRunner([['protection/required_status_checks', payload]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });

    expect(await adapter.readRequiredCheckPolicy({ owner: 'o', repo: 'r', base: 'master' })).toEqual([
      { context: 'unit', appId: 15368 },
      { context: 'lint', appId: null },
    ]);
    expect(adapter.lastRequiredSource).toBe('protection');
    expect(await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master' })).toEqual(['unit', 'lint']);
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

  test('readRequiredChecks fails closed when contexts and app-scoped checks disagree', async () => {
    const { run } = makeRunner([
      ['protection/required_status_checks', JSON.stringify({
        contexts: ['unit'],
        checks: [{ context: 'different', app_id: 123 }],
      })],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const result = await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master' });

    expect(result).toBeNull();
  });

  test('readRequiredChecks fails closed on malformed app identity', async () => {
    const { run } = makeRunner([
      ['protection/required_status_checks', JSON.stringify({
        checks: [{ context: 'unit', app_id: 'not-an-integer' }],
      })],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const result = await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master' });

    expect(result).toBeNull();
  });

  test('readRequiredCheckPolicy rejects missing or conflicting application identity', async () => {
    for (const checks of [
      [{ context: 'ci' }],
      [{ context: 'ci', app_id: 12 }, { context: 'ci', app_id: 13 }],
    ]) {
      const { run } = makeRunner([[
        'protection/required_status_checks', JSON.stringify({ contexts: ['ci'], checks }),
      ]]);
      const adapter = new PrStateAdapter({ gh: run, git: run });
      expect(await adapter.readRequiredCheckPolicy({ owner: 'o', repo: 'r', base: 'master' })).toBeNull();
    }
  });

  test('malformed protection cannot fall through to a valid rollup', async () => {
    const { run } = makeRunner([
      ['protection/required_status_checks', JSON.stringify({
        contexts: ['ci'],
        checks: [{ context: 'ci', app_id: 12 }, { context: 'ci', app_id: 13 }],
      })],
      ['api graphql', ROLLUP_REQUIRED_JSON],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    expect(await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master', pr: '419' }))
      .toBeNull();
    expect(adapter.lastRequiredSource).toBeNull();
  });

  test('readRequiredCheckPolicy deduplicates exact duplicate identities', async () => {
    const { run } = makeRunner([[
      'protection/required_status_checks',
      JSON.stringify({
        contexts: ['ci'],
        checks: [{ context: 'ci', app_id: 12 }, { context: 'ci', app_id: 12 }],
      }),
    ]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    expect(await adapter.readRequiredCheckPolicy({ owner: 'o', repo: 'r', base: 'master' }))
      .toEqual([{ context: 'ci', appId: 12 }]);
    expect(await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master' }))
      .toEqual(['ci']);
  });

  test('readRequiredChecks rejects wrong-typed dual policy fields instead of using the other field', async () => {
    for (const payload of [
      { contexts: ['unit'], checks: {} },
      { contexts: {}, checks: [{ context: 'unit', app_id: 123 }] },
      { contexts: ['   '] },
    ]) {
      const { run } = makeRunner([
        ['protection/required_status_checks', JSON.stringify(payload)],
      ]);
      const adapter = new PrStateAdapter({ gh: run, git: run });
      const result = await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master' });
      expect(result).toBeNull();
    }
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

  test('rollup evidence remains diagnostic and cannot authorize when protection is unreadable', async () => {
    // The real bug: the Actions GITHUB_TOKEN can NEVER read branch protection
    // (admin scope), so protection 403s in CI and the required set was permanently
    // null → verdict UNKNOWN. The rollup `isRequired` fallback is readable with the
    // plain PR-read scope the Actions token DOES hold.
    const err = new Error('403');
    err.stderr = 'HTTP 403: Resource not accessible by integration';
    const { run } = makeRunner([
      ['protection/required_status_checks', () => { throw err; }],
      ['api graphql', ROLLUP_REQUIRED_JSON],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const required = await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master', pr: '419' });

    expect(required).toBeNull();
    expect(adapter.lastRequiredSource).toBeNull();
  });

  test('rollup fallback rejects GraphQL errors, missing pagination, and malformed nodes', async () => {
    const protectionError = new Error('403');
    protectionError.stderr = 'HTTP 403: Resource not accessible by integration';
    const validData = JSON.parse(ROLLUP_REQUIRED_JSON);
    const malformedPayloads = [
      { ...validData, errors: [{ message: 'partial' }] },
      (() => {
        const value = JSON.parse(ROLLUP_REQUIRED_JSON);
        delete value.data.repository.pullRequest.headRef.target.statusCheckRollup.contexts.pageInfo;
        return value;
      })(),
      (() => {
        const value = JSON.parse(ROLLUP_REQUIRED_JSON);
        value.data.repository.pullRequest.headRef.target.statusCheckRollup.contexts.pageInfo = {
          hasNextPage: true, endCursor: null,
        };
        return value;
      })(),
      (() => {
        const value = JSON.parse(ROLLUP_REQUIRED_JSON);
        value.data.repository.pullRequest.headRef.target.statusCheckRollup.contexts.nodes = [
          { __typename: 'CheckRun', name: 'unit' },
        ];
        return value;
      })(),
    ];
    for (const payload of malformedPayloads) {
      const { run } = makeRunner([
        ['protection/required_status_checks', () => { throw protectionError; }],
        ['api graphql', JSON.stringify(payload)],
      ]);
      const adapter = new PrStateAdapter({ gh: run, git: run });
      expect(await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master', pr: '419' }))
        .toBeNull();
    }
  });

  test('rollup fallback consumes every cursor page before projecting required names', async () => {
    const protectionError = new Error('403');
    protectionError.stderr = 'HTTP 403: Resource not accessible by integration';
    let page = 0;
    const pagePayload = (nodes, hasNextPage, endCursor) => JSON.stringify({
      data: { repository: { pullRequest: { headRef: { target: { statusCheckRollup: {
        contexts: { nodes, pageInfo: { hasNextPage, endCursor } },
      } } } } } },
    });
    const { run } = makeRunner([
      ['protection/required_status_checks', () => { throw protectionError; }],
      ['api graphql', () => {
        page += 1;
        return page === 1
          ? pagePayload([{ __typename: 'CheckRun', name: 'unit', isRequired: true }], true, 'NEXT')
          : pagePayload([{ __typename: 'StatusContext', context: 'lint', isRequired: true }], false, null);
      }],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    expect(await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master', pr: '419' }))
      .toBeNull();
    expect(page).toBe(2);
  });

  test('rollup evidence rejects non-canonical PR selectors before GraphQL', async () => {
    for (const pr of ['42e0', '042', '42.0', '-1', '0']) {
      let graphqlCalls = 0;
      const protectionError = new Error('403');
      protectionError.stderr = 'HTTP 403: Resource not accessible by integration';
      const { run } = makeRunner([
        ['protection/required_status_checks', () => { throw protectionError; }],
        ['api graphql', () => { graphqlCalls += 1; return ROLLUP_REQUIRED_JSON; }],
      ]);
      const adapter = new PrStateAdapter({ gh: run, git: run });
      expect(await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master', pr })).toBeNull();
      expect(graphqlCalls).toBe(0);
    }
  });

  test('readRequiredChecks stamps requiredSource=protection when protection is readable', async () => {
    const { run } = makeRunner([
      ['protection/required_status_checks', REQUIRED_CHECKS_JSON],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const required = await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master', pr: '419' });

    // Unchanged behaviour on the readable path — no rollup call, source = protection.
    expect(required).toEqual(['unit', 'lint']);
    expect(adapter.lastRequiredSource).toBe('protection');
  });

  test('readRequiredChecks returns null (fail-closed) when BOTH protection and rollup are unreadable', async () => {
    const err = new Error('403');
    err.stderr = 'HTTP 403: Resource not accessible by integration';
    const { run } = makeRunner([
      ['protection/required_status_checks', () => { throw err; }],
      ['api graphql', () => { throw new Error('graphql boom'); }],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const result = await adapter.readRequiredChecks({ owner: 'o', repo: 'r', base: 'master', pr: '419' });

    expect(result).toBeNull();
    expect(adapter.lastRequiredSource).toBeNull();
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
    expect(call.args.join(' ')).toContain('origin/master...HEAD');
  });

  test('readDivergence compares the base to an explicit authoritative PR head', async () => {
    const { run, calls } = makeRunner([
      ['rev-list --left-right --count', '0\t6\n'],
    ]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const d = await adapter.readDivergence({
      baseRef: 'origin/master',
      headRef: '671a63580b46fc77eaf8fddf6ece0b9a73ae3331',
      cwd: '/stable/root',
    });

    expect(d).toEqual({ behind: 0, ahead: 6 });
    const call = calls.find((c) => c.args.join(' ').includes('rev-list'));
    expect(call.args.join(' ')).toContain(
      'origin/master...671a63580b46fc77eaf8fddf6ece0b9a73ae3331',
    );
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

  test('detectConflicts compares the base to an explicit authoritative PR head', async () => {
    const { run, calls } = makeRunner([['merge-tree --write-tree', 'tree\n']]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const result = await adapter.detectConflicts({
      baseRef: 'origin/master',
      headRef: 'pr-head-sha',
      cwd: '/stable/root',
    });
    expect(result).toEqual({ supported: true, conflicted: false, files: [] });
    const call = calls.find((c) => c.args[0] === 'merge-tree');
    expect(call.args).toContain('pr-head-sha');
    expect(call.args).not.toContain('HEAD');
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
      data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        {
          id: 'PRRT_1', isResolved: false, isOutdated: false, path: 'src/a.js', line: 42,
          comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ fullDatabaseId: '1', author: { __typename: 'Bot', login: 'coderabbitai' }, body: 'nit' }] },
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

  test('readComments rejects non-canonical PR selectors before GraphQL', async () => {
    let calls = 0;
    const adapter = new PrStateAdapter({ gh: () => { calls += 1; return '{}'; }, git: () => '' });
    await expect(adapter.readComments({ owner: 'o', repo: 'r', pr: '042' })).rejects.toThrow(/PR selector/i);
    expect(calls).toBe(0);
  });

  test('readComments surfaces the REST commentId (fullDatabaseId) for replies', async () => {
    const graphqlJson = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        {
          id: 'PRRT_1', isResolved: false, isOutdated: false, path: 'src/a.js', line: 42,
          comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ fullDatabaseId: '987654321', author: { __typename: 'Bot', login: 'coderabbitai' }, body: 'nit' }] },
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
    expect(q).toContain('__typename');
  });

  test('readComments rejects nested authors without a complete actor type', async () => {
    const graphqlJson = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{
          id: 'PRRT_1', isResolved: false, isOutdated: false, path: 'src/a.js', line: 42,
          comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
            { fullDatabaseId: '987654321', author: { login: 'coderabbitai' }, body: 'nit' },
          ] },
        }],
      } } } },
    });
    const { run } = makeRunner([['api graphql', graphqlJson]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    await expect(adapter.readComments({ owner: 'o', repo: 'r', pr: '7' })).rejects.toThrow(/author identity/i);
  });

  test('readComments coerces a missing line to null', async () => {
    const graphqlJson = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { id: 'T', isResolved: false, isOutdated: false, path: 'f', line: null, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
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
          comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ fullDatabaseId: '11', author: { __typename: 'Bot', login: 'bot' }, body: 'a1' }] },
        }],
      } } } },
    });
    // Page 2 (after=C1): thread B whose comment chain itself spills to a 2nd page.
    const outerPage2 = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: 'C1' },
        nodes: [{
          id: 'PRRT_B', isResolved: false, isOutdated: false, path: 'b.js', line: 2,
          comments: { pageInfo: { hasNextPage: true, endCursor: 'CB1' }, nodes: [{ fullDatabaseId: '21', author: { __typename: 'Bot', login: 'bot' }, body: 'b1' }] },
        }],
      } } } },
    });
    // Remaining comments of thread B, fetched by node id.
    const innerCommentsPage = JSON.stringify({
      data: { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ fullDatabaseId: '22', author: { __typename: 'User', login: 'human' }, body: 'b2' }] } } },
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
    const innerGraphql = calls.find((c) => c.args.join(' ').includes('id=PRRT_B'));
    expect(innerGraphql.args.join(' ')).toContain('author{__typename login}');
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

  test('readIssueComments returns id/author/authorTypename/body/createdAt from paginated GraphQL', async () => {
    const page = JSON.stringify({
      data: { repository: { pullRequest: { comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          // With fullDatabaseId → the stable REST id is used as the monitor key.
          { fullDatabaseId: '999', author: { __typename: 'Bot', login: 'sonarqubecloud' }, body: 'Quality Gate failed', createdAt: '2026-07-12T10:00:00Z', updatedAt: '2026-07-12T10:05:00Z' },
          { fullDatabaseId: '1000', author: { __typename: 'User', login: 'a-human' }, body: 'thanks', createdAt: '2026-07-12T11:00:00Z', updatedAt: '2026-07-12T11:00:00Z' },
        ],
      } } } },
    });
    const { run, calls } = makeRunner([['api graphql', page]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const comments = await adapter.readIssueComments({ owner: 'o', repo: 'r', pr: '7' });
    expect(comments).toHaveLength(2);
    // The actor TYPE is surfaced so a bot direct-comment is detectable by mechanism.
    expect(comments[0]).toEqual({ id: '999', author: 'sonarqubecloud', authorTypename: 'Bot', body: 'Quality Gate failed', createdAt: '2026-07-12T10:00:00Z', updatedAt: '2026-07-12T10:05:00Z' });
    expect(comments[1].id).toBe('1000');
    expect(comments[1].authorTypename).toBe('User');
    expect(calls.some((c) => [c.cmd, ...c.args].join(' ').includes('api graphql'))).toBe(true);
  });

  test('readReviews constructs a GraphQL request and keeps the LATEST review per author with commitOid', async () => {
    const page = JSON.stringify({
      data: { repository: { pullRequest: { reviews: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          // Oldest→newest: coderabbitai's second review supersedes its first.
          { id: 'R-OLD', author: { __typename: 'Bot', login: 'coderabbitai' }, state: 'COMMENTED', createdAt: '2026-07-12T08:59:00Z', updatedAt: '2026-07-12T12:00:00Z', submittedAt: '2026-07-12T09:00:00Z', commit: { oid: 'a'.repeat(40) }, body: 'first pass' },
          { id: 'R-HEAD', author: { __typename: 'Bot', login: 'coderabbitai' }, state: 'CHANGES_REQUESTED', createdAt: '2026-07-12T09:59:00Z', updatedAt: '2026-07-12T10:00:00Z', submittedAt: '2026-07-12T10:00:00Z', commit: { oid: 'b'.repeat(40) }, body: 'second pass' },
          { id: 'R-ALICE', author: { __typename: 'User', login: 'alice' }, state: 'APPROVED', createdAt: '2026-07-12T10:59:00Z', updatedAt: '2026-07-12T11:00:00Z', submittedAt: '2026-07-12T11:00:00Z', commit: { oid: 'b'.repeat(40) }, body: 'lgtm' },
        ],
      } } } },
    });
    const { run, calls } = makeRunner([['reviews(first', page]]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const reviews = await adapter.readReviews({ owner: 'o', repo: 'r', pr: '7' });

    // Latest-per-author: coderabbitai collapses to its newer (second) review.
    expect(reviews).toHaveLength(2);
    const cr = reviews.find((r) => r.author === 'coderabbitai');
    expect(cr).toEqual({ id: 'R-HEAD', author: 'coderabbitai', authorTypename: 'Bot', state: 'CHANGES_REQUESTED', createdAt: '2026-07-12T09:59:00Z', updatedAt: '2026-07-12T10:00:00Z', submittedAt: '2026-07-12T10:00:00Z', activityAt: '2026-07-12T12:00:00.000Z', commitOid: 'b'.repeat(40), body: 'second pass' });
    const alice = reviews.find((r) => r.author === 'alice');
    expect(alice.commitOid).toBe('b'.repeat(40));
    expect(alice.authorTypename).toBe('User');
    // A GraphQL request was constructed (not a `gh pr view`).
    expect(calls.some((c) => [c.cmd, ...c.args].join(' ').includes('api graphql'))).toBe(true);
    const query = calls.find((c) => c.args.join(' ').includes('reviews(first')).args.join(' ');
    expect(query).toContain('createdAt updatedAt submittedAt');
  });

  test('readReviews paginates until hasNextPage is false', async () => {
    let call = 0;
    const calls = [];
    const run = (cmd, args) => {
      calls.push({ cmd, args });
      const joined = [cmd, ...args].join(' ');
      if (!joined.includes('reviews(first')) return '';
      call += 1;
      if (call === 1) {
        return JSON.stringify({ data: { repository: { pullRequest: { reviews: {
          pageInfo: { hasNextPage: true, endCursor: 'CUR' },
          nodes: [{ id: 'R-A', author: { __typename: 'Bot', login: 'bot-a' }, state: 'COMMENTED', createdAt: '2026-07-12T08:59:00Z', updatedAt: '2026-07-12T09:00:00Z', submittedAt: '2026-07-12T09:00:00Z', commit: { oid: 'a'.repeat(40) }, body: '' }],
        } } } } });
      }
      return JSON.stringify({ data: { repository: { pullRequest: { reviews: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ id: 'R-B', author: { __typename: 'Bot', login: 'bot-b' }, state: 'COMMENTED', createdAt: '2026-07-12T09:59:00Z', updatedAt: '2026-07-12T10:00:00Z', submittedAt: '2026-07-12T10:00:00Z', commit: { oid: 'b'.repeat(40) }, body: '' }],
      } } } } });
    };
    const adapter = new PrStateAdapter({ gh: run, git: run });
    const reviews = await adapter.readReviews({ owner: 'o', repo: 'r', pr: '7' });
    expect(call).toBe(2); // followed the cursor
    // The second page request must actually forward the returned cursor.
    expect(calls[1].args).toContain('after=CUR');
    expect(reviews.map((r) => r.author).sort()).toEqual(['bot-a', 'bot-b']);
  });

  test('readReviews rejects unknown states and non-full commit OIDs', async () => {
    for (const review of [
      { state: 'BOGUS', commit: { oid: 'a'.repeat(40) } },
      { state: 'COMMENTED', commit: { oid: 'short' } },
    ]) {
      const page = JSON.stringify({ data: { repository: { pullRequest: { reviews: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{
          id: 'R-INVALID', author: { __typename: 'Bot', login: 'review-agent' },
          createdAt: '2026-07-12T08:59:00Z', updatedAt: '2026-07-12T09:00:00Z',
          submittedAt: '2026-07-12T09:00:00Z', body: '', ...review,
        }],
      } } } } });
      const { run } = makeRunner([['reviews(first', page]]);
      const adapter = new PrStateAdapter({ gh: run, git: run });
      await expect(adapter.readReviews({ owner: 'o', repo: 'r', pr: '7' })).rejects.toThrow(/review/i);
    }
  });

  test('readReviews rejects malformed stable ids and authors before normalization', async () => {
    for (const identity of [
      { id: { value: 'R-OBJECT' }, author: { __typename: 'Bot', login: 'review-agent[bot]' } },
      { id: 'R-EMPTY-AUTHOR', author: { __typename: 'Bot', login: '[bot]' } },
    ]) {
      const page = JSON.stringify({ data: { repository: { pullRequest: { reviews: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{
          ...identity,
          state: 'CHANGES_REQUESTED',
          createdAt: '2026-07-12T08:59:00Z', updatedAt: '2026-07-12T09:00:00Z',
          submittedAt: '2026-07-12T09:00:00Z', commit: { oid: 'a'.repeat(40) }, body: '',
        }],
      } } } } });
      const { run } = makeRunner([['reviews(first', page]]);
      const adapter = new PrStateAdapter({ gh: run, git: run });
      await expect(adapter.readReviews({ owner: 'o', repo: 'r', pr: '7' })).rejects.toThrow(/review/i);
    }
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

describe('PrStateAdapter — fetchBase (audit A6: stale-ref guard)', () => {
  test('splits <remote>/<branch> and fetches the base before divergence is read', async () => {
    const { run, calls } = makeRunner([]);
    const adapter = new PrStateAdapter({ gh: run, git: run });
    await adapter.fetchBase({ baseRef: 'origin/master' });
    expect(calls.some((c) => [c.cmd, ...c.args].join(' ') === 'git fetch origin master')).toBe(true);
  });

  test('threads cwd through to the git runner', async () => {
    const seen = [];
    const git = (cmd, args, opts) => { seen.push({ cmd, args, opts }); return ''; };
    const adapter = new PrStateAdapter({ gh: () => '', git });
    await adapter.fetchBase({ baseRef: 'upstream/main', cwd: '/wt' });
    expect(seen[0]).toEqual({ cmd: 'git', args: ['fetch', 'upstream', 'main'], opts: { cwd: '/wt' } });
  });

  test('no-ops on a bare ref with no remote (nothing safe to fetch)', async () => {
    const { run, calls } = makeRunner([]);
    await new PrStateAdapter({ gh: run, git: run }).fetchBase({ baseRef: 'master' });
    expect(calls).toHaveLength(0);
  });
});
