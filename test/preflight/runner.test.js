'use strict';

const { describe, test, expect } = require('bun:test');
const { runGates } = require('../../lib/preflight/runner');

const passGate = (name) => ({ name, run: async () => ({ ok: true, summary: `${name} ok` }) });
const failGate = (name) => ({ name, run: async () => ({ ok: false, summary: `${name} boom` }) });

describe('runGates — fast-fail gate runner', () => {
  test('all gates pass → ok:true with one result per gate', async () => {
    const { ok, results } = await runGates([passGate('a'), passGate('b')]);
    expect(ok).toBe(true);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok && !r.skipped)).toBe(true);
  });

  test('stops at first failure and marks later gates skipped (fast-fail)', async () => {
    let ran3 = false;
    const gate3 = { name: 'c', run: async () => { ran3 = true; return { ok: true }; } };
    const { ok, results, failedIndex } = await runGates([passGate('a'), failGate('b'), gate3]);
    expect(ok).toBe(false);
    expect(failedIndex).toBe(1);
    expect(ran3).toBe(false); // third gate never executed
    expect(results[0]).toMatchObject({ name: 'a', ok: true, skipped: false });
    expect(results[1]).toMatchObject({ name: 'b', ok: false, skipped: false });
    expect(results[2]).toMatchObject({ name: 'c', skipped: true });
  });

  test('a throwing gate is caught and treated as a failure', async () => {
    const boom = { name: 'x', run: async () => { throw new Error('kaboom'); } };
    const { ok, results } = await runGates([boom]);
    expect(ok).toBe(false);
    expect(results[0].ok).toBe(false);
    expect(results[0].summary).toContain('kaboom');
  });

  test('runs gates strictly in order', async () => {
    const order = [];
    const g = (n) => ({ name: n, run: async () => { order.push(n); return { ok: true }; } });
    await runGates([g('1'), g('2'), g('3')]);
    expect(order).toEqual(['1', '2', '3']);
  });

  test('logs a line per executed gate', async () => {
    const lines = [];
    await runGates([passGate('a'), failGate('b')], { log: (m) => lines.push(m) });
    expect(lines.some((l) => l.includes('a'))).toBe(true);
    expect(lines.some((l) => l.includes('b'))).toBe(true);
  });
});

// B2 (N1): a gate may report skipped (e.g. not applicable in a consumer repo).
// Skipped must NOT count as a failure and must not short-circuit later gates.
describe('runGates — skipped outcome honored (B2)', () => {
  test('a skipped gate passes through and later gates still run', async () => {
    const ran = [];
    const gates = [
      { name: 'a', run: async () => ({ ok: true, skipped: true, summary: 'not applicable' }) },
      { name: 'b', run: async () => { ran.push('b'); return { ok: true, summary: 'ok' }; } },
    ];
    const { ok, results } = await runGates(gates);
    expect(ok).toBe(true);
    expect(results[0].skipped).toBe(true);
    expect(ran).toContain('b');
  });

  test('live per-gate log labels a skipped gate SKIP, never PASS', async () => {
    const lines = [];
    const gates = [
      { name: 'structural', run: async () => ({ ok: true, skipped: true, summary: 'not applicable' }) },
    ];
    await runGates(gates, { log: (m) => lines.push(m) });
    const line = lines.find((l) => l.includes('structural')) || '';
    expect(line.startsWith('SKIP')).toBe(true);
    expect(line.startsWith('PASS')).toBe(false);
  });
});

// 4b73b6bf: `ok: skipped ? true : ...` coerced {ok:false, skipped:true} to a pass,
// so a gate that reported BOTH skipped AND failed was silently treated green.
// A skip must never mask an explicit failure.
describe('runGates — skip must not mask an explicit ok:false (4b73b6bf)', () => {
  test('{ok:false, skipped:true} stays a FAILURE (not coerced to pass)', async () => {
    const gates = [
      { name: 'x', run: async () => ({ ok: false, skipped: true, summary: 'boom' }) },
    ];
    const { ok, results } = await runGates(gates);
    expect(ok).toBe(false);
    expect(results[0].ok).toBe(false);
  });

  test('a failed-but-skipped gate still short-circuits later gates', async () => {
    const ran = [];
    const gates = [
      { name: 'a', run: async () => ({ ok: false, skipped: true, summary: 'masked fail' }) },
      { name: 'b', run: async () => { ran.push('b'); return { ok: true }; } },
    ];
    const { ok, results } = await runGates(gates);
    expect(ok).toBe(false);
    expect(ran).not.toContain('b');
    expect(results[1].skipped).toBe(true);
  });

  test('a genuine skip (ok undefined) still passes through and does not short-circuit', async () => {
    const ran = [];
    const gates = [
      { name: 'a', run: async () => ({ skipped: true, summary: 'n/a' }) },
      { name: 'b', run: async () => { ran.push('b'); return { ok: true }; } },
    ];
    const { ok } = await runGates(gates);
    expect(ok).toBe(true);
    expect(ran).toContain('b');
  });
});
