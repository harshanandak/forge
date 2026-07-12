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
