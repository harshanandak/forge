'use strict';

const { describe, test, expect } = require('bun:test');

const shepherdCmd = require('../lib/commands/shepherd');

// Minimal valid pr-state adapter so the --pull path runs without touching gh/git.
function makeAdapter(spec = {}) {
  return {
    id: 'fake', kind: 'pr-state',
    async readState() {
      return {
        headSha: 'sha-1', state: 'OPEN', mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED', checks: spec.checks || [], threads: [],
      };
    },
    async readRequiredChecks() { return spec.required || []; },
    async readDivergence() { return { behind: 0, ahead: 1 }; },
    async rerunFailedChecks() {},
    async replyToThread() {},
    async readComments() { return spec.threads || []; },
    async detectConflicts() { return { supported: true, conflicted: false, files: [] }; },
  };
}

const buildContext = async () => ({
  pr: '123', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master', cwd: '/wt',
});

describe('forge shepherd --pull handler path', () => {
  test('--pull returns the pull payload and never runs the plain pass banner path', async () => {
    const { adapter } = { adapter: makeAdapter() };
    const sentinel = { state: 'ESCALATE', summary: 's', failures: [], reviewThreads: [], truncated: {} };
    let gathered = null;
    const result = await shepherdCmd.handler(
      ['123', '--pull'], {}, '/wt',
      {
        adapter,
        buildContext,
        gatherPull: async (args) => { gathered = args; return sentinel; },
      },
    );
    expect(result.success).toBe(true);
    expect(result.pull).toBe(sentinel);
    // pull path never emits a bundle
    expect(result.bundle).toBeUndefined();
    // the gather received the adapter and an injected gh runner
    expect(typeof gathered.runGh).toBe('function');
    expect(gathered.adapter).toBe(adapter);
  });

  test('--pull injects a gh runner that shells the real gh binary through deps.gh', async () => {
    const adapter = makeAdapter();
    const ghArgs = [];
    const gh = (cmd, args) => { ghArgs.push([cmd, ...args].join(' ')); return ''; };
    let seenRunGh;
    await shepherdCmd.handler(
      ['123', '--pull'], {}, '/wt',
      { adapter, buildContext, gh, gatherPull: async (a) => { seenRunGh = a.runGh; return {}; } },
    );
    seenRunGh(['run', 'view', '--job', '9', '--log-failed']);
    expect(ghArgs.some((c) => c === 'gh run view --job 9 --log-failed')).toBe(true);
  });

  test('--pull does NOT run the --bundle gather', async () => {
    const adapter = makeAdapter();
    let bundleRan = false;
    const result = await shepherdCmd.handler(
      ['123', '--pull'], {}, '/wt',
      {
        adapter, buildContext,
        gatherBundle: async () => { bundleRan = true; return {}; },
        gatherPull: async () => ({ state: 'PENDING', summary: 's', failures: [], reviewThreads: [] }),
      },
    );
    expect(bundleRan).toBe(false);
    expect(result.pull).toBeDefined();
  });
});
