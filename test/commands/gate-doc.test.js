'use strict';

/**
 * `forge gate doc` — the doc-update gate folded under the existing `gate` noun
 * (P2, kernel issue 6ab3f30c). `doc-gate` is NOT a `pr` concern; it belongs to
 * the gate surface. `gate doc <sub>` delegates to the standalone doc-gate handler
 * (same code), and bare `forge doc-gate` stays registered as a back-compat alias.
 */

const { describe, test, expect } = require('bun:test');

const gate = require('../../lib/commands/gate');
const docGate = require('../../lib/commands/doc-gate');

async function withSpy(mod, fn) {
  const calls = [];
  const original = mod.handler;
  mod.handler = async (...args) => {
    calls.push(args);
    return { success: true, output: 'spy-ok' };
  };
  try {
    await fn(calls);
  } finally {
    mod.handler = original;
  }
  return calls;
}

describe('forge gate doc (6ab3f30c)', () => {
  test('gate doc forwards the remaining args + flags + root + opts to the doc-gate handler', async () => {
    const calls = await withSpy(docGate, async () => {
      await gate.handler(['doc', 'check', '--base', 'main', '--head', 'HEAD'], { json: true }, '/root', { env: {} });
    });
    expect(calls).toHaveLength(1);
    // 'doc' token consumed; everything after forwarded untouched.
    expect(calls[0][0]).toEqual(['check', '--base', 'main', '--head', 'HEAD']);
    expect(calls[0][1]).toEqual({ json: true });
    expect(calls[0][2]).toBe('/root');
    expect(calls[0][3]).toEqual({ env: {} });
  });

  test('bare gate doc (no doc subcommand) still delegates — doc-gate defaults to detect', async () => {
    const calls = await withSpy(docGate, async () => {
      await gate.handler(['doc'], {}, '/root');
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual([]);
  });

  test('gate still routes its own actions (enable/status) — doc does not shadow them', async () => {
    // A non-doc action must NOT reach doc-gate; the gate toggle/event families win.
    const calls = await withSpy(docGate, async () => {
      const result = await gate.handler(['bogus-action'], {}, '/root');
      expect(result.success).toBe(false);
      expect(result.error).toContain('enable');
    });
    expect(calls).toHaveLength(0);
  });
});
