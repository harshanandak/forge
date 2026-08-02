'use strict';

const { describe, test, expect } = require('bun:test');

const mergeCmd = require('../../lib/commands/merge');
const { PrStateAdapter } = require('../../lib/adapters/pr-state-adapter');

const HEAD = 'a'.repeat(40);
const ISSUE = '36230258-7b64-4de0-8683-fd8b8eabab51';
const ENABLED = { merge: { auto: { enabled: true, rules: ['checks_green'] } } };
const NOW = Date.parse('2026-08-01T12:00:00Z');

function args(pr = '42') {
  return [pr, '--auto', '--expect-head', HEAD, '--issue', ISSUE];
}

function context(overrides = {}) {
  return {
    number: 42,
    repository: 'acme/forge',
    state: 'OPEN',
    headSha: HEAD,
    isDraft: false,
    conflicting: false,
    unresolvedThreads: 0,
    checks: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', appId: 123 }],
    requiredChecks: [{ context: 'ci', appId: 123 }],
    requiredCheckSource: 'protection',
    requiredChecksKnown: true,
    comments: [],
    now: NOW,
    ...overrides,
  };
}

function deps(overrides = {}) {
  return {
    loadConfig: () => ENABLED,
    verifyIssueOwnership: async () => ({ owned: true, actor: 'release-actor', claimedBy: 'release-actor', expired: false }),
    verifyPrIssueBinding: async () => ({ bound: true }),
    env: { FORGE_ACTOR: 'release-actor' },
    fetchPrContext: async () => context(),
    mergePr: async () => ({ merged: true }),
    ...overrides,
  };
}

function makeGh(threadPayload, viewOverrides = {}, checkRuns = null) {
  return (argv) => {
    if (argv[0] === 'pr' && argv[1] === 'view') {
      return JSON.stringify({
        number: 42,
        headRefOid: HEAD,
        baseRefName: 'master',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [],
        reviews: [],
        comments: [],
        updatedAt: '2026-08-01T00:00:00Z',
        ...viewOverrides,
      });
    }
    if (argv[0] === 'repo' && argv[1] === 'view') {
      return JSON.stringify({ owner: { login: 'acme' }, name: 'forge' });
    }
    if (argv[0] === 'api' && argv[1] === 'repos/acme/forge/branches/master/protection/required_status_checks') {
      return JSON.stringify({ contexts: ['ci'], checks: [{ context: 'ci', app_id: 123 }] });
    }
    if (argv[0] === 'api' && argv.includes('--paginate') && argv.includes('--slurp')) {
      const runs = checkRuns || [{
          id: 7,
          name: 'ci',
          head_sha: HEAD,
          status: 'completed',
          conclusion: 'success',
          app: { id: 123 },
        }];
      return JSON.stringify([{ total_count: runs.length, check_runs: runs }]);
    }
    if (argv[0] === 'api' && argv[1] === 'graphql') return JSON.stringify(threadPayload);
    throw new Error(`unexpected gh call: ${argv.join(' ')}`);
  };
}

const validThreads = {
  data: { repository: { pullRequest: { reviewThreads: {
    nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
  } } } },
};

describe('merge authority — exact reviewer regressions', () => {
  test('enforces the mandatory ten-minute settle even when config omits settle_min', async () => {
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => context({
        comments: [{ author: 'reviewer', at: new Date(NOW - 60_000).toISOString() }],
      }),
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(out.merged).toBe(false);
    expect(merges).toBe(0);
    expect(out.error || out.reason).toMatch(/settle|quiet|10.minute/i);
  });

  test('uses the later edited timestamp for settle evidence', async () => {
    const editedAt = new Date(NOW - 60_000).toISOString();
    const fetched = await mergeCmd.defaultFetchPrContext({
      pr: '42',
      now: NOW,
      gh: makeGh(validThreads, {
        comments: [{
          author: { login: 'reviewer' },
          createdAt: new Date(NOW - 30 * 60_000).toISOString(),
          updatedAt: editedAt,
        }],
      }),
    });
    expect(fetched.comments[0].at).toBe(editedAt);
  });

  test('uses a later review update for mandatory settle evidence', async () => {
    const updatedAt = new Date(NOW - 60_000).toISOString();
    const fetched = await mergeCmd.defaultFetchPrContext({
      pr: '42',
      now: NOW,
      gh: makeGh(validThreads, {
        reviews: [{
          author: { login: 'reviewer' },
          state: 'COMMENTED',
          createdAt: new Date(NOW - 40 * 60_000).toISOString(),
          submittedAt: new Date(NOW - 30 * 60_000).toISOString(),
          updatedAt,
        }],
      }),
    });
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => fetched,
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(fetched.lastActivityAt).toBe(Date.parse(updatedAt));
    expect(out.merged).toBe(false);
    expect(merges).toBe(0);
  });

  test('uses recent PR or review activity for mandatory settle without comments', async () => {
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => context({ comments: [], lastActivityAt: NOW - 60_000 }),
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(out.merged).toBe(false);
    expect(merges).toBe(0);
    expect(out.error || out.reason).toMatch(/settle|quiet|10.minute/i);
  });

  test('rejects a malformed optional StatusContext before protected evaluation', async () => {
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => context({
        checks: [
          { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', appId: 123 },
          { name: 'optional-status', appId: null, state: '' },
        ],
      }),
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(out.merged).toBe(false);
    expect(merges).toBe(0);
    expect(out.error).toMatch(/observation|malformed/i);
  });

  test('default provider collection rejects unknown optional check-run enums', async () => {
    const fetched = await mergeCmd.defaultFetchPrContext({
      pr: '42',
      now: NOW,
      gh: makeGh(validThreads, {}, [
        { id: 7, name: 'ci', head_sha: HEAD, status: 'completed', conclusion: 'success', app: { id: 123 } },
        { id: 8, name: 'optional', head_sha: HEAD, status: 'garbage', conclusion: 'success', app: { id: 999 } },
      ]),
    });
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => fetched,
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(out.merged).toBe(false);
    expect(merges).toBe(0);
  });

  test('default provider collection does not drop nonterminal optional rollup CheckRuns', async () => {
    const fetched = await mergeCmd.defaultFetchPrContext({
      pr: '42',
      now: NOW,
      gh: makeGh(validThreads, {
        statusCheckRollup: [{
          __typename: 'CheckRun', name: 'optional', status: 'IN_PROGRESS', conclusion: 'SUCCESS',
        }],
      }),
    });
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => fetched,
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(out.merged).toBe(false);
    expect(merges).toBe(0);
  });

  test('optional NEUTRAL and SKIPPED checks block the mutation seam', async () => {
    for (const conclusion of ['NEUTRAL', 'SKIPPED']) {
      let merges = 0;
      const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
        fetchPrContext: async () => context({ checks: [
          { name: 'ci', appId: 123, status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'optional', appId: 999, status: 'COMPLETED', conclusion },
        ] }),
        mergePr: async () => { merges += 1; return { merged: true }; },
      }));
      expect(out.merged).toBe(false);
      expect(merges).toBe(0);
    }
  });

  test('requires a canonical positive-decimal PR number', () => {
    for (const selector of ['-R=evil/other', '--repo=evil/other', '0', '-1', '1.5', 'https://github.com/acme/forge/pull/42', '', ' 42']) {
      const parsed = mergeCmd.parseMergeArgs(args(selector));
      expect(parsed.error).toMatch(/PR number|selector|invalid|unknown merge option/i);
      expect(parsed.pr).toBeNull();
    }
    expect(mergeCmd.parseMergeArgs(args('42')).pr).toBe('42');
  });

  test('only OPEN proceeds and only MERGED/CLOSED are terminal no-ops on either read', async () => {
    for (const state of [undefined, null, '', 'UNKNOWN', 'DRAFT', 'BOGUS']) {
      let merges = 0;
      const first = await mergeCmd.handler(args(), {}, process.cwd(), deps({
        fetchPrContext: async () => context({ state }),
        mergePr: async () => { merges += 1; return { merged: true }; },
      }));
      expect(first.success).toBe(false);
      expect(first.merged).toBe(false);
      expect(merges).toBe(0);

      let reads = 0;
      const second = await mergeCmd.handler(args(), {}, process.cwd(), deps({
        fetchPrContext: async () => {
          reads += 1;
          return context({ state: reads === 1 ? 'OPEN' : state });
        },
        mergePr: async () => { merges += 1; return { merged: true }; },
      }));
      expect(second.success).toBe(false);
      expect(second.merged).toBe(false);
      expect(merges).toBe(0);
    }

    for (const state of ['MERGED', 'CLOSED']) {
      const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
        fetchPrContext: async () => context({ state }),
      }));
      expect(out.success).toBe(true);
      expect(out.merged).toBe(false);
      expect(out.state).toBe(state);
    }
  });

  test('ownership requires explicit expired=false', async () => {
    for (const expired of [undefined, null, 'false', 0, true]) {
      const out = await mergeCmd.defaultVerifyIssueOwnership({
        issueId: ISSUE,
        projectRoot: process.cwd(),
        env: { FORGE_ACTOR: 'release-actor' },
        runIssue: async () => ({
          ok: true,
          data: { owned: true, actor: 'release-actor', claimed_by: 'release-actor', expired },
        }),
      });
      expect(out.owned).toBe(false);
    }
  });

  test('both ownership probes require explicit actor and claimedBy identity', async () => {
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      verifyIssueOwnership: async () => ({ owned: true, expired: false }),
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(out.merged).toBe(false);
    expect(merges).toBe(0);
  });

  test('injected Kernel binding drivers remain caller-owned', async () => {
    let closes = 0;
    const driver = { close() { closes += 1; } };
    const broker = { listOpenPrs: async () => [{ repo: 'acme/forge', number: 42, state: 'open', issue_id: ISSUE }] };
    const result = await mergeCmd.defaultVerifyPrIssueBinding({
      issueId: ISSUE,
      pr: '42',
      projectRoot: process.cwd(),
      prContext: context(),
      buildBroker: async () => ({ broker, driver, gitCommonDir: 'C:/repo/.git' }),
    });
    expect(result.bound).toBe(true);
    expect(closes).toBe(0);
    expect(await broker.listOpenPrs()).toHaveLength(1);
  });

  test('missing policy application identity or check-run status is non-authorizing', async () => {
    for (const overrides of [
      { requiredChecks: [{ context: 'ci' }] },
      { checks: [{ name: 'ci', appId: 123, conclusion: 'SUCCESS' }] },
    ]) {
      let merges = 0;
      const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
        fetchPrContext: async () => context(overrides),
        mergePr: async () => { merges += 1; return { merged: true }; },
      }));
      expect(out.merged).toBe(false);
      expect(merges).toBe(0);
    }
  });

  test('freezes actor identity across both ownership probes', async () => {
    const env = { FORGE_ACTOR: 'alice' };
    let ownershipCalls = 0;
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      env,
      verifyIssueOwnership: async (input) => {
        ownershipCalls += 1;
        expect(input.actor).toBe('alice');
        if (ownershipCalls === 1) {
          env.FORGE_ACTOR = 'bob';
          return { owned: true, expired: false, actor: 'alice', claimedBy: 'alice' };
        }
        return { owned: true, expired: false, actor: 'bob', claimedBy: 'bob' };
      },
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(ownershipCalls).toBe(2);
    expect(out.success).toBe(false);
    expect(out.merged).toBe(false);
    expect(merges).toBe(0);
  });

  test('requires an exact authoritative PR-to-issue Kernel binding on both reads', async () => {
    let bindingCalls = 0;
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      verifyPrIssueBinding: async () => {
        bindingCalls += 1;
        return bindingCalls === 1 ? { bound: true } : { bound: false };
      },
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(bindingCalls).toBe(2);
    expect(out.success).toBe(false);
    expect(out.merged).toBe(false);
    expect(merges).toBe(0);
  });

  test('default binding verifier rejects absent, foreign, duplicate, and wrong-issue rows', async () => {
    expect(typeof mergeCmd.defaultVerifyPrIssueBinding).toBe('function');
    const run = (rows) => mergeCmd.defaultVerifyPrIssueBinding({
      issueId: ISSUE,
      pr: '42',
      projectRoot: process.cwd(),
      prContext: context(),
      buildBroker: async () => ({
        gitCommonDir: '/repo/.git',
        broker: { listOpenPrs: async () => rows },
        driver: { close() {} },
      }),
    });
    expect((await run([])).bound).toBe(false);
    expect((await run([{ repo: 'other/forge', number: 42, issue_id: ISSUE, state: 'open' }])).bound).toBe(false);
    expect((await run([{ repo: 'acme/forge', number: 42, issue_id: 'wrong', state: 'open' }])).bound).toBe(false);
    expect((await run([
      { repo: 'acme/forge', number: 42, issue_id: ISSUE, state: 'open' },
      { repo: 'acme/forge', number: 42, issue_id: ISSUE, state: 'open' },
    ])).bound).toBe(false);
    expect((await run([{ repo: 'acme/forge', number: 42, issue_id: ISSUE, state: 'open' }])).bound).toBe(true);
    for (const malformedNumber of ['0x2a', '42e0', '042', '42.0']) {
      expect((await run([{
        repo: 'acme/forge', number: malformedNumber, issue_id: ISSUE, state: 'open',
      }])).bound).toBe(false);
    }
    expect((await run([
      { repo: 'acme/forge', number: 42, issue_id: ISSUE, state: 'open' },
      { repo: 'acme/forge', number: '0x2a', issue_id: 'other', state: 'open' },
    ])).bound).toBe(false);
  });

  test('leases normalized repository identity across both reads and final mutation', async () => {
    let reads = 0;
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => {
        reads += 1;
        return context({ repository: reads === 1 ? 'acme/forge' : 'evil/other' });
      },
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(reads).toBe(2);
    expect(out.success).toBe(false);
    expect(out.merged).toBe(false);
    expect(out.error).toMatch(/repository|identity|changed/i);
    expect(merges).toBe(0);
  });

  test('malformed or partial GraphQL thread envelopes are unreadable', async () => {
    const malformed = [
      { errors: [{ message: 'partial' }], ...validThreads },
      { errors: { message: 'malformed' }, ...validThreads },
      { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false } } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { nodes: null, pageInfo: { hasNextPage: false } } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { nodes: [null], pageInfo: { hasNextPage: false } } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { nodes: [{}], pageInfo: { hasNextPage: false } } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: {} } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } } },
    ];
    for (const payload of malformed) {
      const out = await mergeCmd.defaultFetchPrContext({ pr: '42', gh: makeGh(payload) });
      expect(out.unresolvedThreads).toBeUndefined();
    }
    const valid = await mergeCmd.defaultFetchPrContext({ pr: '42', gh: makeGh(validThreads) });
    expect(valid.unresolvedThreads).toBe(0);
  });

  test('uses the leased repository for thread evidence without resolving it again', async () => {
    const baseGh = makeGh(validThreads);
    let repoReads = 0;
    let graphqlArgs = [];
    const gh = (argv) => {
      if (argv[0] === 'repo' && argv[1] === 'view') {
        repoReads += 1;
        return JSON.stringify(repoReads === 1
          ? { owner: { login: 'acme' }, name: 'forge' }
          : { owner: { login: 'evil' }, name: 'other' });
      }
      if (argv[0] === 'api' && argv[1] === 'graphql') graphqlArgs = argv;
      return baseGh(argv);
    };
    const fetched = await mergeCmd.defaultFetchPrContext({ pr: '42', gh });
    expect(fetched.repository).toBe('acme/forge');
    expect(repoReads).toBe(1);
    expect(graphqlArgs).toContain('o=acme');
    expect(graphqlArgs).toContain('n=forge');
  });

  test('rejects the complete check-run collection when any optional observation is malformed', async () => {
    const baseGh = makeGh(validThreads);
    const gh = (argv) => {
      if (argv[0] === 'api' && argv.includes('--paginate') && argv.includes('--slurp')) {
        return JSON.stringify([{
          total_count: 2,
          check_runs: [
            { id: 7, name: 'ci', head_sha: HEAD, status: 'completed', conclusion: 'success', app: { id: 123 } },
            { id: 8, name: 'optional', head_sha: HEAD, status: 'completed', conclusion: 'success', app: null },
          ],
        }]);
      }
      return baseGh(argv);
    };
    const fetched = await mergeCmd.defaultFetchPrContext({ pr: '42', gh });
    expect(fetched.checks).toBeNull();
  });

  test('shared adapter rejects GraphQL errors, missing connections, and non-progressing cursors', async () => {
    const partial = new PrStateAdapter({
      gh: () => JSON.stringify({
        errors: [{ message: 'partial' }],
        data: { repository: { pullRequest: { reviews: {
          nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
        } } } },
      }),
      git: () => '',
    });
    await expect(partial.readReviews({ owner: 'o', repo: 'r', pr: '42' })).rejects.toThrow(/GraphQL|error/i);

    const missing = new PrStateAdapter({
      gh: () => JSON.stringify({ data: { repository: { pullRequest: {} } } }),
      git: () => '',
    });
    await expect(missing.readComments({ owner: 'o', repo: 'r', pr: '42' })).rejects.toThrow(/connection|nodes|pageInfo/i);

    const repeated = new PrStateAdapter({
      gh: () => JSON.stringify({ data: { repository: { pullRequest: { reviews: {
        nodes: [], pageInfo: { hasNextPage: true, endCursor: 'SAME' },
      } } } } }),
      git: () => '',
    });
    await expect(repeated.readReviews({ owner: 'o', repo: 'r', pr: '42' })).rejects.toThrow(/cursor|advance/i);

    const terminalPage = { hasNextPage: false, endCursor: null };
    const malformedReview = new PrStateAdapter({
      gh: () => JSON.stringify({ data: { repository: { pullRequest: { reviews: {
        nodes: [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-08-01T00:00:00Z', commit: { oid: HEAD }, body: 'blocker' }],
        pageInfo: terminalPage,
      } } } } }),
      git: () => '',
    });
    await expect(malformedReview.readReviews({ owner: 'o', repo: 'r', pr: '42' })).rejects.toThrow(/review|node|author|id/i);

    const malformedIssueComment = new PrStateAdapter({
      gh: () => JSON.stringify({ data: { repository: { pullRequest: { comments: {
        nodes: [{ author: { __typename: 'Bot', login: 'bot' }, body: 'blocker', createdAt: '2026-08-01T00:00:00Z' }],
        pageInfo: terminalPage,
      } } } } }),
      git: () => '',
    });
    await expect(malformedIssueComment.readIssueComments({ owner: 'o', repo: 'r', pr: '42' })).rejects.toThrow(/comment|node|id/i);

    const malformedThreadComment = new PrStateAdapter({
      gh: () => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: [{
          id: 'T1', isResolved: false, isOutdated: false,
          comments: { nodes: [{ body: 'blocker' }], pageInfo: terminalPage },
        }],
        pageInfo: terminalPage,
      } } } } }),
      git: () => '',
    });
    await expect(malformedThreadComment.readComments({ owner: 'o', repo: 'r', pr: '42' })).rejects.toThrow(/comment|node|author|id/i);
  });

  test('preserves required app identity and rejects wrong-app or contradictory observations', async () => {
    const fetched = await mergeCmd.defaultFetchPrContext({ pr: '42', gh: makeGh(validThreads) });
    expect(fetched.requiredChecks).toEqual([{ context: 'ci', appId: 123 }]);
    expect(fetched.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ci', appId: 123, status: 'COMPLETED', conclusion: 'SUCCESS' }),
    ]));

    const wrongApp = mergeCmd.evaluateProtectedRequiredChecks(context({
      checks: [{ name: 'ci', appId: 999, status: 'COMPLETED', conclusion: 'SUCCESS' }],
    }));
    expect(wrongApp.allowed).toBe(false);

    const contradictory = mergeCmd.evaluateProtectedRequiredChecks(context({
      checks: [{ name: 'ci', appId: 123, status: 'IN_PROGRESS', conclusion: 'SUCCESS' }],
    }));
    expect(contradictory.allowed).toBe(false);
  });
});
