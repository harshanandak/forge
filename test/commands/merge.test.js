'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, test, expect } = require('bun:test');

const YAML = require('yaml');

const mergeCmd = require('../../lib/commands/merge');
const { validateCommand } = require('../../lib/commands/_registry');

const tempRoots = [];
const HEAD = 'a'.repeat(40);
const ISSUE = '36230258-7b64-4de0-8683-fd8b8eabab51';

function mergeArgs(pr) {
  return [String(pr), '--auto', '--expect-head', HEAD, '--issue', ISSUE];
}

function authorizedContext(overrides = {}) {
  const now = overrides.now ?? Date.parse('2026-08-01T12:00:00Z');
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
    reviewEvidenceReadable: true,
    reviews: [],
    comments: [],
    lastActivityAt: now - 60 * 60_000,
    now,
    ...overrides,
  };
}

const AUTHORITY_DEPS = {
  env: { FORGE_ACTOR: 'release-actor' },
  verifyIssueOwnership: async () => ({ owned: true, actor: 'release-actor', claimedBy: 'release-actor', expired: false }),
  verifyPrIssueBinding: async () => ({ bound: true }),
  verifyMergeGate: async () => true,
  prepareMergeDecision: async () => ({ decisionId: 'decision-1' }),
  recordMergeDecision: async () => ({ receiptId: 'receipt-1' }),
};

/** Create an isolated temp project; when `configObj` is given, write it to `.forge/config.yaml`. */
function makeProject(configObj) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-merge-cmd-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  if (configObj !== undefined) {
    fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), YAML.stringify(configObj));
  }
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('merge command — opt-in conditional auto-merge', () => {
  test('default fetch marks review evidence unreadable when repository identity is unavailable', async () => {
    const gh = (args) => {
      const joined = args.join(' ');
      if (joined.startsWith('pr view')) {
        return JSON.stringify({
          number: 42,
          headRefOid: HEAD,
          baseRefName: 'master',
          state: 'OPEN',
          isDraft: false,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [],
          comments: [],
          updatedAt: '2026-08-02T12:00:00Z',
        });
      }
      if (joined.startsWith('repo view')) return JSON.stringify({});
      return '';
    };

    const context = await mergeCmd.defaultFetchPrContext({ pr: '42', gh });
    expect(context.reviews).toEqual([]);
    expect(context.reviewEvidenceReadable).toBe(false);
  });

  test('satisfies the _registry { name, description, handler } contract', () => {
    expect(validateCommand(mergeCmd)).toEqual({ valid: true });
    expect(mergeCmd.name).toBe('merge');
    expect(typeof mergeCmd.handler).toBe('function');
  });

  test('NO-OP when .forge/config.yaml is absent (invariant: auto-merge is OFF by default)', async () => {
    const root = makeProject(undefined);
    let mergeCalled = false;
    const out = await mergeCmd.handler(['123', '--auto'], {}, root, {
      fetchPrContext: async () => { throw new Error('must not fetch when disabled'); },
      mergePr: async () => { mergeCalled = true; },
    });
    expect(out.success).toBe(true);
    expect(out.merged).toBe(false);
    expect(out.enabled).toBe(false);
    expect(mergeCalled).toBe(false);
  });

  test('NO-OP when merge.auto.enabled is false', async () => {
    const root = makeProject({ merge: { auto: { enabled: false, rules: ['checks_green'] } } });
    let mergeCalled = false;
    const out = await mergeCmd.handler(['7', '--auto'], {}, root, {
      fetchPrContext: async () => { throw new Error('must not fetch when disabled'); },
      mergePr: async () => { mergeCalled = true; },
    });
    expect(out.merged).toBe(false);
    expect(out.enabled).toBe(false);
    expect(mergeCalled).toBe(false);
  });

  test('does NOTHING (no merge) when a configured rule is unmet', async () => {
    const root = makeProject({ merge: { auto: { enabled: true, rules: ['settle_min:20'] } } });
    let mergeCalled = false;
    const out = await mergeCmd.handler(mergeArgs('9'), {}, root, {
      ...AUTHORITY_DEPS,
      fetchPrContext: async () => authorizedContext({
        comments: [{ author: 'x', at: '2026-07-04T11:49:00Z' }], // mandatory 10m passes; configured 20m fails
        now: Date.parse('2026-07-04T12:00:00Z'),
      }),
      mergePr: async () => { mergeCalled = true; },
    });
    expect(out.merged).toBe(false);
    expect(out.allowed).toBe(false);
    expect(mergeCalled).toBe(false);
    expect(out.unmet[0].rule).toContain('settle_min');
  });

  test('MERGES when enabled and every rule passes', async () => {
    const root = makeProject({ merge: { auto: { enabled: true, rules: ['checks_green', 'threads_resolved'] } } });
    let mergedPr = null;
    const out = await mergeCmd.handler(mergeArgs('42'), {}, root, {
      ...AUTHORITY_DEPS,
      fetchPrContext: async () => authorizedContext(),
      mergePr: async ({ pr }) => { mergedPr = pr; return { merged: true }; },
    });
    expect(out.success).toBe(true);
    expect(out.merged).toBe(true);
    expect(out.allowed).toBe(true);
    expect(mergedPr).toBe('42');
  });

  test('allows exact-name ignored NEUTRAL and SKIPPED optional checks', async () => {
    const root = makeProject({
      merge: { auto: { enabled: true, rules: [{ checks_green: { ignore: ['forge/pr-monitor', 'docs-only'] } }] } },
    });
    let mergeCalled = false;
    const out = await mergeCmd.handler(mergeArgs('42'), {}, root, {
      ...AUTHORITY_DEPS,
      fetchPrContext: async () => authorizedContext({
        checks: [
          { name: 'ci', appId: 123, status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'forge/pr-monitor', appId: 456, status: 'COMPLETED', conclusion: 'NEUTRAL' },
          { name: 'docs-only', appId: 457, status: 'COMPLETED', conclusion: 'SKIPPED' },
        ],
        providerObservations: [
          { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'forge/pr-monitor', status: 'COMPLETED', conclusion: 'NEUTRAL' },
          { name: 'docs-only', status: 'COMPLETED', conclusion: 'SKIPPED' },
        ],
      }),
      mergePr: async () => { mergeCalled = true; return { merged: true }; },
    });

    expect(out.merged).toBe(true);
    expect(mergeCalled).toBe(true);
  });

  test('bare checks_green still refuses optional NEUTRAL and SKIPPED checks', async () => {
    const root = makeProject({ merge: { auto: { enabled: true, rules: ['checks_green'] } } });
    let mergeCalled = false;
    const out = await mergeCmd.handler(mergeArgs('42'), {}, root, {
      ...AUTHORITY_DEPS,
      fetchPrContext: async () => authorizedContext({
        checks: [
          { name: 'ci', appId: 123, status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'forge/pr-monitor', appId: 456, status: 'COMPLETED', conclusion: 'NEUTRAL' },
          { name: 'docs-only', appId: 457, status: 'COMPLETED', conclusion: 'SKIPPED' },
        ],
      }),
      mergePr: async () => { mergeCalled = true; },
    });

    expect(out.merged).toBe(false);
    expect(out.allowed).toBe(false);
    expect(out.unmet[0].rule).toBe('checks_green');
    expect(mergeCalled).toBe(false);
  });

  test('ignored FAILURE remains a mandatory preflight refusal', async () => {
    const root = makeProject({
      merge: { auto: { enabled: true, rules: [{ checks_green: { ignore: ['forge/pr-monitor'] } }] } },
    });
    let mergeCalled = false;
    const out = await mergeCmd.handler(mergeArgs('42'), {}, root, {
      ...AUTHORITY_DEPS,
      fetchPrContext: async () => authorizedContext({
        checks: [
          { name: 'ci', appId: 123, status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'forge/pr-monitor', appId: 456, status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
      }),
      mergePr: async () => { mergeCalled = true; },
    });

    expect(out.success).toBe(false);
    expect(out.merged).toBe(false);
    expect(out.error).toMatch(/safe terminal conclusion.*SUCCESS.*NEUTRAL.*SKIPPED/i);
    expect(mergeCalled).toBe(false);
  });

  test('protected required checks must be SUCCESS even when configured ignored', async () => {
    const root = makeProject({
      merge: { auto: { enabled: true, rules: [{ checks_green: { ignore: ['forge/pr-monitor'] } }] } },
    });
    let mergeCalled = false;
    const out = await mergeCmd.handler(mergeArgs('42'), {}, root, {
      ...AUTHORITY_DEPS,
      fetchPrContext: async () => authorizedContext({
        checks: [
          { name: 'ci', appId: 123, status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'forge/pr-monitor', appId: 456, status: 'COMPLETED', conclusion: 'NEUTRAL' },
        ],
        requiredChecks: [
          { context: 'ci', appId: null },
          { context: 'forge/pr-monitor', appId: 456 },
        ],
      }),
      mergePr: async () => { mergeCalled = true; },
    });

    expect(out.success).toBe(false);
    expect(out.merged).toBe(false);
    expect(out.error).toMatch(/Protected required checks.*not successful/i);
    expect(mergeCalled).toBe(false);
  });

  test('refuses (fail-closed) when opted in with an empty ruleset', async () => {
    const root = makeProject({ merge: { auto: { enabled: true, rules: [] } } });
    let mergeCalled = false;
    const out = await mergeCmd.handler(['5', '--auto'], {}, root, {
      fetchPrContext: async () => ({}),
      mergePr: async () => { mergeCalled = true; },
    });
    expect(out.success).toBe(false);
    expect(out.merged).toBe(false);
    expect(mergeCalled).toBe(false);
  });

  test('requires the --auto flag and a PR number', async () => {
    const root = makeProject({ merge: { auto: { enabled: true, rules: ['checks_green'] } } });
    expect((await mergeCmd.handler(['1'], {}, root, {})).success).toBe(false);
    expect((await mergeCmd.handler(['--auto'], {}, root, {})).success).toBe(false);
  });

  test('pre-flight NO-OP (idempotent) when the PR is already MERGED', async () => {
    const root = makeProject({ merge: { auto: { enabled: true, rules: ['checks_green'] } } });
    let mergeCalled = false;
    const out = await mergeCmd.handler(mergeArgs('42'), {}, root, {
      ...AUTHORITY_DEPS,
      fetchPrContext: async () => ({ state: 'MERGED' }),
      mergePr: async () => { mergeCalled = true; },
    });
    expect(out.success).toBe(true);
    expect(out.merged).toBe(false);
    expect(out.state).toBe('MERGED');
    expect(mergeCalled).toBe(false);
  });

  test('TOCTOU: aborts the merge when the live re-check fails (state changed after first pass)', async () => {
    const root = makeProject({ merge: { auto: { enabled: true, rules: ['no_conflicts'] } } });
    let mergeCalled = false;
    let call = 0;
    const out = await mergeCmd.handler(mergeArgs('77'), {}, root, {
      ...AUTHORITY_DEPS,
      // 1st fetch: allowed (no conflicts). 2nd (pre-merge) fetch: now conflicting.
      fetchPrContext: async () => {
        call += 1;
        return call === 1
          ? authorizedContext({ conflicting: false })
          : authorizedContext({ conflicting: true });
      },
      mergePr: async () => { mergeCalled = true; return { merged: true }; },
    });
    expect(call).toBe(2);
    expect(out.success).toBe(false);
    expect(out.merged).toBe(false);
    expect(mergeCalled).toBe(false);
    expect(out.error).toMatch(/conflict/i);
  });

  test('TOCTOU: re-check refuses an ignored optional check that later fails', async () => {
    const root = makeProject({
      merge: { auto: { enabled: true, rules: [{ checks_green: { ignore: ['forge/pr-monitor'] } }] } },
    });
    let mergeCalled = false;
    let call = 0;
    const out = await mergeCmd.handler(mergeArgs('77'), {}, root, {
      ...AUTHORITY_DEPS,
      fetchPrContext: async () => {
        call += 1;
        return authorizedContext({
          checks: [
            { name: 'ci', appId: 123, status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'forge/pr-monitor', appId: 456, status: 'COMPLETED', conclusion: call === 1 ? 'NEUTRAL' : 'FAILURE' },
          ],
        });
      },
      mergePr: async () => { mergeCalled = true; },
    });

    expect(call).toBe(2);
    expect(out.success).toBe(false);
    expect(out.merged).toBe(false);
    expect(out.error).toMatch(/check-run|successful/i);
    expect(mergeCalled).toBe(false);
  });
});
