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
    reviewEvidenceReadable: true,
    reviews: [],
    comments: [],
    lastActivityAt: NOW - 60 * 60_000,
    now: NOW,
    ...overrides,
  };
}

function deps(overrides = {}) {
  return {
    loadConfig: () => ENABLED,
    verifyIssueOwnership: async () => ({
      owned: true, actor: 'release-actor', claimedBy: 'release-actor', sessionId: 'release-session', expired: false,
    }),
    verifyPrIssueBinding: async () => ({ bound: true }),
    verifyMergeGate: async () => true,
    prepareMergeDecision: async () => ({ decisionId: 'decision-1' }),
    recordMergeDecision: async () => ({ receiptId: 'receipt-1' }),
    env: { FORGE_ACTOR: 'release-actor', FORGE_SESSION_ID: 'release-session' },
    fetchPrContext: async () => context(),
    mergePr: async () => ({ merged: true }),
    ...overrides,
  };
}

function makeGh(threadPayload, viewOverrides = {}, checkRuns = null) {
  return (argv) => {
    if (argv[0] === 'pr' && argv[1] === 'view') {
      const payload = {
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
      };
      // Match the real `gh pr view --json reviews` projection: review edit and
      // creation timestamps are not exported on this surface.
      payload.reviews = (viewOverrides.reviews || []).map((review) => ({
        author: review.author,
        state: review.state,
        submittedAt: review.submittedAt,
      }));
      return JSON.stringify(payload);
    }
    if (argv[0] === 'repo' && argv[1] === 'view') {
      return JSON.stringify({ owner: { login: 'acme' }, name: 'forge', isFork: false, parent: null });
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
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      const queryArg = argv.find((arg) => String(arg).startsWith('query=')) || '';
      if (queryArg.includes('reviews(first')) {
        const nodes = (viewOverrides.reviews || []).map((review, index) => ({
          id: review.id || `R-${index + 1}`,
          author: {
            __typename: review.author?.__typename || 'User',
            login: review.author?.login || 'reviewer',
          },
          state: review.state || 'COMMENTED',
          createdAt: review.createdAt || review.submittedAt,
          updatedAt: review.updatedAt || review.submittedAt,
          submittedAt: review.submittedAt,
          commit: review.commit || { oid: HEAD },
          body: review.body || '',
        }));
        return JSON.stringify({ data: { repository: { pullRequest: { reviews: {
          nodes, pageInfo: { hasNextPage: false, endCursor: null },
        } } } } });
      }
      return JSON.stringify(threadPayload);
    }
    throw new Error(`unexpected gh call: ${argv.join(' ')}`);
  };
}

const validThreads = {
  data: { repository: { pullRequest: { reviewThreads: {
    nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
  } } } },
};

describe('merge authority — exact reviewer regressions', () => {
  test('allows an immediate merge when config omits settle_min', async () => {
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => context({
        comments: [{ author: 'reviewer', at: new Date(NOW - 60_000).toISOString() }],
      }),
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(out.merged).toBe(true);
    expect(merges).toBe(1);
  });

  test('still blocks a recent comment when settle_min is explicitly configured', async () => {
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      loadConfig: () => ({ merge: { auto: { enabled: true, rules: ['checks_green', 'settle_min:10'] } } }),
      fetchPrContext: async () => context({
        comments: [{ author: 'reviewer', at: new Date(NOW - 60_000).toISOString() }],
      }),
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(out.merged).toBe(false);
    expect(out.allowed).toBe(false);
    expect(out.unmet.some((item) => item.rule === 'settle_min:10')).toBe(true);
    expect(merges).toBe(0);
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

  test('preserves a later review update without imposing settle_min when unconfigured', async () => {
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
    expect(out.merged).toBe(true);
    expect(merges).toBe(1);
  });

  test('review authority rejects unreadable, malformed, stale, and blocking latest evidence', async () => {
    const valid = {
      id: 'R-1', author: 'reviewer', authorTypename: 'User', state: 'COMMENTED',
      createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z',
      submittedAt: '2026-08-01T10:00:00Z', activityAt: '2026-08-01T10:00:00.000Z',
      commitOid: HEAD, body: '',
    };
    for (const overrides of [
      { reviewEvidenceReadable: false },
      { reviews: [{ ...valid, state: 'BOGUS' }] },
      { reviews: [{ ...valid, commitOid: 'short' }] },
      { reviews: [{ ...valid, state: 'APPROVED', commitOid: 'b'.repeat(40) }] },
      { reviews: [{ ...valid, state: 'CHANGES_REQUESTED', commitOid: 'b'.repeat(40) }] },
      { reviews: [{ ...valid, state: 'CHANGES_REQUESTED' }] },
    ]) {
      let merges = 0;
      const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
        fetchPrContext: async () => context(overrides),
        mergePr: async () => { merges += 1; return { merged: true }; },
      }));
      expect(out.merged).toBe(false);
      expect(merges).toBe(0);
      expect(out.error || out.reason).toMatch(/review/i);
    }
  });


  test('treats stale COMMENTED review history as non-authorizing and non-vetoing', async () => {
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => context({
        reviews: [{
          id: 'R-commented-stale',
          author: 'reviewer',
          authorTypename: 'User',
          state: 'COMMENTED',
          createdAt: '2026-08-01T10:00:00Z',
          updatedAt: '2026-08-01T10:00:00Z',
          submittedAt: '2026-08-01T10:00:00Z',
          activityAt: '2026-08-01T10:00:00.000Z',
          commitOid: 'b'.repeat(40),
          body: '',
        }],
      }),
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(out.success).toBe(true);
    expect(out.merged).toBe(true);
    expect(merges).toBe(1);
  });
  test('does not require recent PR or review activity when settle_min is unconfigured', async () => {
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => context({ comments: [], lastActivityAt: NOW - 60_000 }),
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(out.merged).toBe(true);
    expect(merges).toBe(1);
  });

  test('TOCTOU re-check aborts thread, check, review, and head regressions', async () => {
    const regressions = [
      { override: { unresolvedThreads: 1 }, pattern: /thread/i },
      {
        override: { checks: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', appId: 123 }] },
        pattern: /check|terminal/i,
      },
      {
        override: {
          reviews: [{
            id: 'R-block', author: 'reviewer', authorTypename: 'User', state: 'CHANGES_REQUESTED',
            createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z',
            submittedAt: '2026-08-01T10:00:00Z', activityAt: '2026-08-01T10:00:00Z',
            commitOid: HEAD, body: 'blocker',
          }],
        },
        pattern: /review/i,
      },
      { override: { headSha: 'b'.repeat(40) }, pattern: /head/i },
    ];

    for (const { override, pattern } of regressions) {
      let reads = 0;
      let merges = 0;
      const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
        fetchPrContext: async () => {
          reads += 1;
          return reads === 1 ? context() : context(override);
        },
        mergePr: async () => { merges += 1; return { merged: true }; },
      }));
      expect(reads).toBe(2);
      expect(out.merged).toBe(false);
      expect(merges).toBe(0);
      expect(out.error || out.reason).toMatch(pattern);
    }
  });

  test('TOCTOU allows a new comment when settle_min is unconfigured', async () => {
    let reads = 0;
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => {
        reads += 1;
        return context({
          comments: reads === 1 ? [] : [{ author: 'reviewer', at: new Date(NOW - 60_000).toISOString() }],
          lastActivityAt: reads === 1 ? NOW - 60 * 60_000 : NOW - 60_000,
        });
      },
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(out.merged).toBe(true);
    expect(merges).toBe(1);
  });

  test('TOCTOU blocks a new comment when settle_min is configured', async () => {
    let reads = 0;
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      loadConfig: () => ({ merge: { auto: { enabled: true, rules: ['checks_green', 'settle_min:10'] } } }),
      fetchPrContext: async () => {
        reads += 1;
        return context({
          comments: reads === 1
            ? [{ author: 'reviewer', at: new Date(NOW - 60 * 60_000).toISOString() }]
            : [{ author: 'reviewer', at: new Date(NOW - 60_000).toISOString() }],
        });
      },
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(out.merged).toBe(false);
    expect(out.allowed).toBe(false);
    expect(out.unmet.some((item) => item.rule === 'settle_min:10')).toBe(true);
    expect(merges).toBe(0);
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

  test('only OPEN proceeds, MERGED reconciles evidence, and CLOSED is a terminal no-op', async () => {
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

    const merged = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => context({ state: 'MERGED' }),
    }));
    expect(merged).toMatchObject({ success: true, merged: true, recovered: true });

    const closed = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => context({ state: 'CLOSED' }),
    }));
    expect(closed).toMatchObject({ success: true, merged: false, state: 'CLOSED' });
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
    const env = { FORGE_ACTOR: 'alice', FORGE_SESSION_ID: 'alice-session' };
    let ownershipCalls = 0;
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      env,
      verifyIssueOwnership: async (input) => {
        ownershipCalls += 1;
        expect(input.actor).toBe('alice');
        if (ownershipCalls === 1) {
          env.FORGE_ACTOR = 'bob';
          return {
            owned: true, expired: false, actor: 'alice', claimedBy: 'alice', sessionId: 'alice-session',
          };
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

  test('requires a session identity before the external merge mutation', async () => {
    let merges = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      env: { FORGE_ACTOR: 'release-actor' },
      mergePr: async () => { merges += 1; return { merged: true }; },
    }));
    expect(out.success).toBe(false);
    expect(out.merged).toBe(false);
    expect(out.error).toMatch(/exact session/i);
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

  test('merge recovery reads one exact retired PR linkage from the durable trace', async () => {
    let traceTarget;
    const result = await mergeCmd.defaultVerifyPrIssueBinding({
      issueId: ISSUE,
      pr: '42',
      projectRoot: process.cwd(),
      prContext: context({ state: 'MERGED', repository: undefined }),
      allowRetired: true,
      buildBroker: async () => ({
        gitCommonDir: '/repo/.git',
        broker: {
          readTrace: async (target) => {
            traceTarget = target;
            return ({
            gaps: [],
            pull_requests: [{
              id: 'pr-current', repo: 'acme/forge', number: 42, issue_id: ISSUE, state: 'closed',
              branch: 'feature/merge', git_common_dir: '/repo/.git', url: 'https://example/pr/42',
              iterations: [{
                id: 'merged-event', type: 'pr.merged', at: '2026-08-01T12:00:00.000Z',
                issue_id: ISSUE, issue_revision: 7, head_sha: HEAD,
                work_packet_hash: 'a'.repeat(64), run_receipt_hash: 'b'.repeat(64),
              }],
            }, {
              id: 'pr-foreign', repo: 'acme/forge', number: 42, issue_id: ISSUE, state: 'closed',
              branch: 'other/merge', git_common_dir: '/other/.git', iterations: [],
            }],
            });
          },
        },
        driver: { close() {} },
      }),
    });

    expect(result).toMatchObject({
      bound: true, issueId: ISSUE, repository: 'acme/forge',
      branch: 'feature/merge', gitCommonDir: '/repo/.git',
      terminalEvidence: {
        occurredAt: '2026-08-01T12:00:00.000Z', receiptHash: 'b'.repeat(64),
      },
    });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(result.terminalEvidence.decisionId).toMatch(uuid);
    expect(result.terminalEvidence.receiptId).toMatch(uuid);
    expect(traceTarget).toEqual({ issue_id: ISSUE, pr_number: 42, git_common_dir: '/repo/.git' });
  });

  test('retired binding errors report a wrong issue without claiming the row must be open', async () => {
    const result = await mergeCmd.defaultVerifyPrIssueBinding({
      issueId: ISSUE,
      pr: '42',
      projectRoot: process.cwd(),
      prContext: context({ state: 'MERGED' }),
      allowRetired: true,
      buildBroker: async () => ({
        gitCommonDir: '/repo/.git',
        broker: { readTrace: async () => ({ gaps: [], pull_requests: [{
          repo: 'acme/forge', number: 42, issue_id: 'wrong-issue', state: 'closed',
          git_common_dir: '/repo/.git', iterations: [],
        }] }) },
        driver: { close() {} },
      }),
    });

    expect(result.bound).toBe(false);
    expect(result.error).toMatch(/different issue/i);
    expect(result.error).not.toMatch(/not open/i);
  });

  test('merge recovery rejects a malformed expected head before matching terminal trace evidence', async () => {
    const result = await mergeCmd.defaultVerifyPrIssueBinding({
      issueId: ISSUE,
      pr: '42',
      projectRoot: process.cwd(),
      prContext: context({ state: 'MERGED', headSha: null }),
      allowRetired: true,
      buildBroker: async () => ({
        gitCommonDir: '/repo/.git',
        broker: {
          readTrace: async () => ({
            gaps: [],
            pull_requests: [{
              repo: 'acme/forge', number: 42, issue_id: ISSUE, state: 'closed',
              git_common_dir: '/repo/.git',
              iterations: [{
                type: 'pr.merged', at: '2026-08-01T12:00:00.000Z', issue_id: ISSUE,
                issue_revision: 7, head_sha: null,
                work_packet_hash: 'a'.repeat(64), run_receipt_hash: 'b'.repeat(64),
              }],
            }],
          }),
        },
        driver: { close() {} },
      }),
    });

    expect(result.bound).toBe(false);
    expect(result.error).toMatch(/incomplete|head/i);
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
          ? { owner: { login: 'acme' }, name: 'forge', isFork: false, parent: null }
          : { owner: { login: 'evil' }, name: 'other', isFork: false, parent: null });
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
