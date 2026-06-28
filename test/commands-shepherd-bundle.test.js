'use strict';

const { describe, test, expect } = require('bun:test');

const shepherdCmd = require('../lib/commands/shepherd');
const { gatherPrBundle } = require('../lib/pr-bundle');

// A minimal valid pr-state adapter (satisfies validatePrStateAdapter) wired with
// canned reads so the --bundle handler path runs without touching gh/git.
function makeAdapter(spec = {}) {
  const calls = [];
  return {
    calls,
    adapter: {
      id: 'fake', kind: 'pr-state',
      async readState() {
        return {
          headSha: 'sha-1', state: 'OPEN', mergeable: 'MERGEABLE',
          mergeStateStatus: 'BLOCKED', checks: spec.checks || [], threads: [],
        };
      },
      async readRequiredChecks(args) { calls.push({ method: 'readRequiredChecks', ...args }); return spec.required || []; },
      async readDivergence() { return { behind: 0, ahead: 1 }; },
      async rerunFailedChecks() {},
      async replyToThread() {},
      async readComments() { return spec.threads || []; },
      async detectConflicts() { return { supported: true, conflicted: false, files: [] }; },
    },
  };
}

// Fixed context so the handler never shells out to defaultBuildContext.
const buildContext = async () => ({
  pr: '123', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master', cwd: '/wt',
});

describe('forge shepherd --bundle handler path', () => {
  test('--bundle returns the gathered bundle and never runs a pass', async () => {
    const { adapter } = makeAdapter({
      required: ['unit'],
      checks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
    let passRan = false;
    const result = await shepherdCmd.handler(
      ['123', '--bundle', '--json'], {}, '/wt',
      { adapter, buildContext, gatherBundle: gatherPrBundle, runPass: async () => { passRan = true; return {}; } },
    );

    expect(result.success).toBe(true);
    expect(passRan).toBe(false);
    expect(result.bundle).toBeDefined();
    expect(result.bundle.mergeState.mergeable).toBe('MERGEABLE');
    expect(result.bundle.ci.checks[0].required).toBe(true);
    // no decision/state machine fields leak into the bundle result
    expect(result.state).toBeUndefined();
  });

  test('--bundle forwards the base branch name to required-check lookup', async () => {
    const { adapter, calls } = makeAdapter({ required: [] });
    await shepherdCmd.handler(
      ['123', '--bundle', '--json'], {}, '/wt',
      { adapter, buildContext, gatherBundle: gatherPrBundle },
    );
    const reqCall = calls.find((c) => c.method === 'readRequiredChecks');
    expect(reqCall.base).toBe('master');
  });

  test('the injected gatherBundle is used (wiring is overridable for tests)', async () => {
    const { adapter } = makeAdapter();
    const sentinel = { sentinel: true };
    const result = await shepherdCmd.handler(
      ['123', '--bundle', '--json'], {}, '/wt',
      { adapter, buildContext, gatherBundle: async () => sentinel },
    );
    expect(result.bundle).toBe(sentinel);
  });

  test('without --bundle the pass path is unchanged (no bundle field)', async () => {
    const { adapter } = makeAdapter({ required: [] });
    const result = await shepherdCmd.handler(
      ['123'], {}, '/wt',
      {
        adapter,
        buildContext,
        runPass: async () => ({ state: 'PENDING', actions: [], reason: 'waiting' }),
      },
    );
    expect(result.bundle).toBeUndefined();
    expect(result.state).toBe('PENDING');
  });
});
