'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, test, expect } = require('bun:test');

const YAML = require('yaml');

const mergeCmd = require('../../lib/commands/merge');
const { validateCommand } = require('../../lib/commands/_registry');

const tempRoots = [];

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
    const root = makeProject({ merge: { auto: { enabled: true, rules: ['settle_min:10'] } } });
    let mergeCalled = false;
    const out = await mergeCmd.handler(['9', '--auto'], {}, root, {
      fetchPrContext: async () => ({
        comments: [{ author: 'x', at: '2026-07-04T11:58:00Z' }], // 2 min before `now`
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
    const out = await mergeCmd.handler(['42', '--auto'], {}, root, {
      fetchPrContext: async () => ({
        checks: [{ name: 'ci', conclusion: 'SUCCESS' }],
        requiredChecksKnown: true,
        unresolvedThreads: 0,
      }),
      mergePr: async ({ pr }) => { mergedPr = pr; return { merged: true }; },
    });
    expect(out.success).toBe(true);
    expect(out.merged).toBe(true);
    expect(out.allowed).toBe(true);
    expect(mergedPr).toBe('42');
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
});
