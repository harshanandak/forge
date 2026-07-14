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
});
