'use strict';

const { describe, test, expect } = require('bun:test');
const preflight = require('../../lib/commands/preflight');

describe('forge preflight command — contract', () => {
  test('exports a valid registry command interface', () => {
    expect(preflight.name).toBe('preflight');
    expect(typeof preflight.description).toBe('string');
    expect(typeof preflight.handler).toBe('function');
  });

  test('returns success:true when all gates pass', async () => {
    const lines = [];
    const res = await preflight.handler([], {}, '/x', {
      log: (m) => lines.push(m),
      resolveChangedFiles: () => ['lib/a.js'],
      buildGates: () => [{ name: 'g', run: async () => ({ ok: true, summary: 'ok' }) }],
    });
    expect(res.success).toBe(true);
    expect(lines.join('\n')).toContain('preflight passed');
  });

  test('returns success:false and reports FAIL when a gate fails', async () => {
    const lines = [];
    const res = await preflight.handler([], {}, '/x', {
      log: (m) => lines.push(m),
      resolveChangedFiles: () => ['lib/a.js'],
      buildGates: () => [{ name: 'broken', run: async () => ({ ok: false, summary: 'nope' }) }],
    });
    expect(res.success).toBe(false);
    expect(lines.join('\n')).toContain('[FAIL] broken');
    expect(lines.join('\n')).toContain('preflight FAILED');
  });

  test('--all flag forces whole-tree scope through to buildGates', async () => {
    let received;
    await preflight.handler([], { '--all': true }, '/x', {
      log: () => {},
      resolveChangedFiles: () => [],
      buildGates: (opts) => { received = opts; return []; },
    });
    expect(received.runAll).toBe(true);
  });
});

// B2 (N1): an unresolvable base branch must FAIL with a remedy, never pass
// vacuously by manufacturing "0 changed files".
describe('forge preflight — base resolvability (B2)', () => {
  test('unresolvable base => FAIL with remedy, gates never built', async () => {
    const lines = [];
    let built = false;
    const res = await preflight.handler([], {}, '/x', {
      log: (m) => lines.push(m),
      resolveChangeSet: () => ({ resolved: false, reason: 'could not resolve a base branch' }),
      buildGates: () => { built = true; return []; },
    });
    expect(res.success).toBe(false);
    expect(res.baseUnresolved).toBe(true);
    expect(built).toBe(false);
    const out = lines.join('\n');
    expect(out).toContain('preflight FAILED');
    expect(out).toMatch(/base branch/i);
    expect(out).toMatch(/--all|upstream|remedy/i);
  });

  test('fail-CLOSED when resolved is omitted entirely (no fail-open)', async () => {
    const lines = [];
    let built = false;
    const res = await preflight.handler([], {}, '/x', {
      log: (m) => lines.push(m),
      // A future override that forgets `resolved` must NOT pass through.
      resolveChangeSet: () => ({ changedFiles: [] }),
      buildGates: () => { built = true; return []; },
    });
    expect(res.success).toBe(false);
    expect(res.baseUnresolved).toBe(true);
    expect(built).toBe(false);
    expect(lines.join('\n')).toContain('preflight FAILED');
  });

  test('resolved base with 0 changed files still runs gates (legit no-op)', async () => {
    const res = await preflight.handler([], {}, '/x', {
      log: () => {},
      resolveChangeSet: () => ({ resolved: true, changedFiles: [] }),
      buildGates: () => [{ name: 'g', run: async () => ({ ok: true, summary: 'ok' }) }],
    });
    expect(res.success).toBe(true);
  });

  test('--all bypasses the base requirement', async () => {
    const res = await preflight.handler([], { '--all': true }, '/x', {
      log: () => {},
      resolveChangeSet: ({ runAll }) => ({ resolved: !!runAll, changedFiles: [] }),
      buildGates: () => [{ name: 'g', run: async () => ({ ok: true }) }],
    });
    expect(res.success).toBe(true);
  });
});

describe('resolveChangeSet — strict base detection (B2)', () => {
  const { resolveChangeSet } = require('../../lib/commands/preflight');

  test('fresh repo (no origin/HEAD, no upstream, no main/master ref) => unresolved', () => {
    const exec = () => { throw new Error('fatal: not a valid object name'); };
    const cs = resolveChangeSet(exec, {});
    expect(cs.resolved).toBe(false);
    expect(cs.reason).toMatch(/base branch/i);
  });

  test('runAll short-circuits to resolved regardless of git state', () => {
    const cs = resolveChangeSet(() => { throw new Error('x'); }, { runAll: true });
    expect(cs.resolved).toBe(true);
  });

  test('diffs against the SAME resolved base (does not re-resolve a different one)', () => {
    // Fake git: origin/HEAD -> main; merge-base HEAD main -> abc123; diff on that base.
    const calls = [];
    const exec = (_cmd, args) => {
      calls.push(args.join(' '));
      const a = args.join(' ');
      if (a.includes('origin/HEAD')) return 'main\n';
      if (a.startsWith('merge-base HEAD main')) return 'abc123\n';
      if (a.startsWith('diff --name-only abc123...HEAD')) return 'lib/x.js\nlib/y.js\n';
      throw new Error(`unexpected git: ${a}`);
    };
    const cs = resolveChangeSet(exec, {});
    expect(cs.resolved).toBe(true);
    expect(cs.baseRef).toBe('main');
    expect(cs.changedFiles).toEqual(['lib/x.js', 'lib/y.js']);
    // The diff must use the merge-base of the resolved base, not a re-resolved ref.
    expect(calls.some((c) => c.startsWith('diff --name-only abc123...HEAD'))).toBe(true);
  });
});

// 45a63715: a fully-pushed feature branch's own @{upstream} points AT HEAD, so
// diffing against it yields 0 changed files and every gate passes vacuously.
// resolveBaseRef must reject an upstream equal to our own HEAD and demand a real
// integration base (origin/main, etc.) — or FAIL when none exists.
describe('resolveBaseRef — reject own-upstream-at-HEAD (45a63715)', () => {
  const { resolveBaseRef } = require('../../lib/commands/preflight');

  // No origin/HEAD; @{upstream} = origin/feature which resolves to the SAME sha
  // as HEAD (branch fully pushed). A real base (origin/main) exists.
  function makeExec({ mainExists = true, headSha = 'deadbeef', upstreamSha = 'deadbeef' } = {}) {
    return (_cmd, args) => {
      const a = args.join(' ');
      if (a.includes('origin/HEAD')) throw new Error('origin/HEAD not set');
      if (a.includes('@{upstream}')) return 'origin/feature\n';
      if (a.includes('origin/feature') && a.includes('rev-parse')) return `${upstreamSha}\n`;
      if (a.startsWith('rev-parse') && a.includes('HEAD')) return `${headSha}\n`;
      // rev-parse --verify --quiet <ref> for the fallback candidate list
      if (a.includes('--verify') && a.includes('origin/main')) {
        if (mainExists) return 'main-sha\n';
        throw new Error('bad ref');
      }
      if (a.includes('--verify')) throw new Error('bad ref');
      return '';
    };
  }

  test('own upstream at HEAD is skipped in favor of a real integration base', () => {
    const base = resolveBaseRef(makeExec({ mainExists: true }));
    expect(base).not.toBe('origin/feature');
    expect(base).toBe('origin/main');
  });

  test('own upstream at HEAD with NO real base resolves to null (fail-closed)', () => {
    const base = resolveBaseRef(makeExec({ mainExists: false }));
    expect(base).toBeNull();
  });

  test('an upstream AHEAD of HEAD (unpushed commits) is still a usable base', () => {
    // upstream sha differs from HEAD → diffing it yields a real change set.
    const base = resolveBaseRef(makeExec({ headSha: 'aaa', upstreamSha: 'bbb' }));
    expect(base).toBe('origin/feature');
  });
});
