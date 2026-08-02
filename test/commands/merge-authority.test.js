'use strict';

const { describe, test, expect } = require('bun:test');

const mergeCmd = require('../../lib/commands/merge');

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const ISSUE = '36230258-7b64-4de0-8683-fd8b8eabab51';
const ENABLED = { merge: { auto: { enabled: true, rules: ['checks_green'] } } };

function args(head = HEAD) {
  return ['42', '--auto', '--expect-head', head, '--issue', ISSUE];
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
    checks: [{ name: 'ci', appId: 123, status: 'COMPLETED', conclusion: 'SUCCESS' }],
    requiredChecks: [{ context: 'ci', appId: null }],
    requiredCheckSource: 'protection',
    requiredChecksKnown: true,
    comments: [],
    now: Date.parse('2026-08-01T12:00:00Z'),
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

describe('merge command — mandatory release authority', () => {
  test('requires one full expected head and issue before ownership or provider I/O', async () => {
    for (const argv of [
      ['42', '--auto', '--issue', ISSUE],
      ['42', '--auto', '--expect-head', 'abc', '--issue', ISSUE],
      ['42', '--auto', '--expect-head', HEAD, '--expect-head', HEAD, '--issue', ISSUE],
      ['42', '--auto', '--expect-head', HEAD],
      ['42', '--auto', '--expect-head', HEAD, '--issue'],
    ]) {
      let ownershipCalls = 0;
      let fetchCalls = 0;
      const out = await mergeCmd.handler(argv, {}, process.cwd(), deps({
        verifyIssueOwnership: async () => { ownershipCalls += 1; return { owned: true }; },
        fetchPrContext: async () => { fetchCalls += 1; return context(); },
      }));
      expect(out.success).toBe(false);
      expect(out.merged).toBe(false);
      expect(ownershipCalls).toBe(0);
      expect(fetchCalls).toBe(0);
    }
  });

  test('requires an active Kernel claim owned by the resolved lane actor', async () => {
    let fetchCalls = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      verifyIssueOwnership: async () => ({
        owned: false,
        claimedBy: 'another-actor',
        expired: false,
      }),
      fetchPrContext: async () => { fetchCalls += 1; return context(); },
    }));
    expect(out.success).toBe(false);
    expect(out.merged).toBe(false);
    expect(out.error).toMatch(/ownership|claim/i);
    expect(fetchCalls).toBe(0);
  });

  test('aborts when the first observed head does not match the caller lease', async () => {
    let mergeCalls = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => context({ headSha: OTHER_HEAD }),
      mergePr: async () => { mergeCalls += 1; return { merged: true }; },
    }));
    expect(out.success).toBe(false);
    expect(out.merged).toBe(false);
    expect(out.error).toMatch(/head/i);
    expect(mergeCalls).toBe(0);
  });

  test('aborts when the second observed head changes after the first pass', async () => {
    let fetchCalls = 0;
    let mergeCalls = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      fetchPrContext: async () => {
        fetchCalls += 1;
        return context({ headSha: fetchCalls === 1 ? HEAD : OTHER_HEAD });
      },
      mergePr: async () => { mergeCalls += 1; return { merged: true }; },
    }));
    expect(fetchCalls).toBe(2);
    expect(out.success).toBe(false);
    expect(out.merged).toBe(false);
    expect(out.error).toMatch(/head/i);
    expect(mergeCalls).toBe(0);
  });

  test('blocks when protected required-check policy is unreadable or non-authoritative', async () => {
    for (const requiredCheckSource of [null, 'rollup']) {
      let mergeCalls = 0;
      const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
        fetchPrContext: async () => context({ requiredChecks: [], requiredCheckSource }),
        mergePr: async () => { mergeCalls += 1; return { merged: true }; },
      }));
      expect(out.success).toBe(false);
      expect(out.merged).toBe(false);
      expect(out.error).toMatch(/required.check|protection|policy/i);
      expect(mergeCalls).toBe(0);
    }
  });

  test('blocks missing, pending, failed, and skipped required checks', async () => {
    for (const checks of [
      [],
      [{ name: 'ci', appId: 123, status: 'IN_PROGRESS', conclusion: null }],
      [{ name: 'ci', appId: 123, status: 'COMPLETED', conclusion: 'FAILURE' }],
      [{ name: 'ci', appId: 123, status: 'COMPLETED', conclusion: 'SKIPPED' }],
      [{ name: 'ci', appId: 123, status: 'COMPLETED', conclusion: 'NEUTRAL' }],
    ]) {
      let mergeCalls = 0;
      const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
        fetchPrContext: async () => context({ checks }),
        mergePr: async () => { mergeCalls += 1; return { merged: true }; },
      }));
      expect(out.success).toBe(false);
      expect(out.merged).toBe(false);
      expect(out.error).toMatch(/required check|observation/i);
      expect(mergeCalls).toBe(0);
    }
  });

  test('re-proves ownership immediately before mutation and blocks lease loss', async () => {
    let ownershipCalls = 0;
    let mergeCalls = 0;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      verifyIssueOwnership: async () => {
        ownershipCalls += 1;
        return ownershipCalls === 1
          ? { owned: true, actor: 'release-actor', claimedBy: 'release-actor', expired: false }
          : { owned: false, actor: 'other', claimedBy: 'other', expired: false };
      },
      mergePr: async () => { mergeCalls += 1; return { merged: true }; },
    }));
    expect(ownershipCalls).toBe(2);
    expect(out.success).toBe(false);
    expect(out.merged).toBe(false);
    expect(out.error).toMatch(/ownership|expired/i);
    expect(mergeCalls).toBe(0);
  });

  test('enforces draft, conflict, and unresolved-thread gates independently of config rules', async () => {
    for (const override of [
      { isDraft: true },
      { isDraft: undefined },
      { conflicting: true },
      { conflicting: undefined },
      { unresolvedThreads: 1 },
      { unresolvedThreads: undefined },
    ]) {
      let mergeCalls = 0;
      const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
        fetchPrContext: async () => context(override),
        mergePr: async () => { mergeCalls += 1; return { merged: true }; },
      }));
      expect(out.success).toBe(false);
      expect(out.merged).toBe(false);
      expect(mergeCalls).toBe(0);
    }
  });

  test('passes the immutable head and issue through the injected merge seam', async () => {
    let mutation;
    const out = await mergeCmd.handler(args(), {}, process.cwd(), deps({
      mergePr: async (input) => { mutation = input; return { merged: true }; },
    }));
    expect(out.success).toBe(true);
    expect(out.merged).toBe(true);
    expect(mutation.expectedHead).toBe(HEAD);
    expect(mutation.repository).toBe('acme/forge');
    expect(mutation.issueId).toBe(ISSUE);
  });

  test('default merge action uses GitHub server-side expected-head lease', () => {
    let observed;
    const out = mergeCmd.defaultMergePr({
      pr: '42',
      expectedHead: HEAD,
      repository: 'acme/forge',
      gh: (argv) => { observed = argv; return ''; },
    });
    expect(out.merged).toBe(true);
    expect(observed).toEqual([
      'pr', 'merge', '42', '--repo', 'acme/forge', '--squash', '--match-head-commit', HEAD,
    ]);
  });

  test('default ownership verifier requires explicit identity and matching unexpired Kernel data', async () => {
    let calls = 0;
    const runIssue = async (_operation, _args, _root, { env }) => {
      calls += 1;
      return {
        ok: true,
        data: {
          owned: true,
          actor: env.FORGE_ACTOR,
          claimed_by: env.FORGE_ACTOR,
          expired: false,
        },
      };
    };

    const missing = await mergeCmd.defaultVerifyIssueOwnership({
      issueId: ISSUE, projectRoot: process.cwd(), env: {}, runIssue,
    });
    expect(missing.owned).toBe(false);
    expect(calls).toBe(0);

    const matching = await mergeCmd.defaultVerifyIssueOwnership({
      issueId: ISSUE,
      projectRoot: process.cwd(),
      env: { FORGE_ACTOR: 'release-actor' },
      runIssue,
    });
    expect(matching.owned).toBe(true);
    expect(calls).toBe(1);

    const foreign = await mergeCmd.defaultVerifyIssueOwnership({
      issueId: ISSUE,
      projectRoot: process.cwd(),
      env: { FORGE_ACTOR: 'release-actor' },
      runIssue: async () => ({
        ok: true,
        data: { owned: true, actor: 'release-actor', claimed_by: 'other', expired: false },
      }),
    });
    expect(foreign.owned).toBe(false);
  });

  test('default fetch exposes exact head and only authoritative protection requirements', async () => {
    const seen = [];
    const gh = (argv) => {
      seen.push(argv);
      if (argv[0] === 'pr' && argv[1] === 'view') {
        return JSON.stringify({
          number: 42,
          headRefOid: HEAD,
          baseRefName: 'master',
          state: 'OPEN',
          isDraft: false,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [{
            __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS',
          }],
          reviews: [],
          comments: [],
          updatedAt: '2026-08-01T00:00:00Z',
        });
      }
      if (argv[0] === 'repo' && argv[1] === 'view') {
        return JSON.stringify({ owner: { login: 'acme' }, name: 'forge' });
      }
      if (argv[0] === 'api' && argv[1] === 'repos/acme/forge/branches/master/protection/required_status_checks') {
        return JSON.stringify({
          contexts: ['ci'],
          checks: [{ context: 'ci', app_id: 123 }],
        });
      }
      if (argv[0] === 'api' && argv.includes(`repos/acme/forge/commits/${HEAD}/check-runs?filter=latest&per_page=100`)) {
        return JSON.stringify([{ total_count: 2, check_runs: [{
          id: 1,
          name: 'ci',
          head_sha: HEAD,
          status: 'completed',
          conclusion: 'success',
          app: { id: 123 },
        }] }, { total_count: 2, check_runs: [{
          id: 2,
          name: 'optional',
          head_sha: HEAD,
          status: 'completed',
          conclusion: 'success',
          app: { id: 999 },
        }] }]);
      }
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        const queryArg = argv.find((arg) => String(arg).startsWith('query=')) || '';
        if (queryArg.includes('reviews(first')) {
          return JSON.stringify({
            data: { repository: { pullRequest: { reviews: {
              nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
            } } } },
          });
        }
        return JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: {
            nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
          } } } },
        });
      }
      throw new Error(`unexpected gh call: ${argv.join(' ')}`);
    };

    const out = await mergeCmd.defaultFetchPrContext({ pr: '42', gh });
    expect(out.headSha).toBe(HEAD);
    expect(out.requiredChecks).toEqual([{ context: 'ci', appId: 123 }]);
    expect(out.checks).toEqual([
      { id: 1, name: 'ci', appId: 123, status: 'COMPLETED', conclusion: 'SUCCESS' },
      { id: 2, name: 'optional', appId: 999, status: 'COMPLETED', conclusion: 'SUCCESS' },
    ]);
    expect(out.requiredCheckSource).toBe('protection');
    expect(seen[0].join(' ')).toContain('headRefOid');
  });
});
