'use strict';

const { describe, test, expect } = require('bun:test');

const { maybeStartPrWatcher, autoShepherdRailEnabled } = require('../../lib/commands/ship');
const { getDefaultRuntimeGraph } = require('../../lib/core/runtime-graph');

// rail.auto_shepherd (issue cf8361bc / epic c2d398e5): the default-ON, UNLOCKED
// rail that governs whether `forge ship` auto-starts the detached
// `forge shepherd watch <pr>` monitor. Toggle via `forge gate disable
// rail.auto_shepherd`. These tests pin: (1) the rail is registered default-ON +
// unlocked; (2) the resolver-backed check is fail-OPEN (default-ON on any error);
// (3) maybeStartPrWatcher honors the rail while never failing ship.

describe('rail.auto_shepherd registration', () => {
  test('is a default-ON, unlocked rail in the runtime graph', () => {
    const graph = getDefaultRuntimeGraph();
    const rail = graph.rails.find((r) => r.id === 'rail.auto_shepherd');
    expect(rail).toBeDefined();
    expect(rail.key).toBe('auto_shepherd');
    expect(rail.enabled).toBe(true);
    expect(rail.locked).toBe(false);
  });
});

describe('autoShepherdRailEnabled — fail-open resolver check', () => {
  const railEntry = (enabled) => ({ rails: [{ id: 'rail.auto_shepherd', enabled }], gates: [] });

  test('true when the resolved rail is enabled', () => {
    expect(autoShepherdRailEnabled('/root', () => railEntry(true))).toBe(true);
  });

  test('false ONLY when the resolved rail is explicitly disabled', () => {
    expect(autoShepherdRailEnabled('/root', () => railEntry(false))).toBe(false);
  });

  test('true (default-ON) when the rail is absent from the resolved graph', () => {
    expect(autoShepherdRailEnabled('/root', () => ({ rails: [], gates: [] }))).toBe(true);
  });

  test('true (fail-open) when resolving the graph throws — never blocks ship', () => {
    expect(autoShepherdRailEnabled('/root', () => { throw new Error('config unreadable'); })).toBe(true);
  });
});

describe('maybeStartPrWatcher — rail gating', () => {
  test('starts the watcher when the rail is enabled and a PR exists', () => {
    const calls = [];
    const res = maybeStartPrWatcher({
      dryRun: false, prNumber: 42,
      startWatcher: (opts) => { calls.push(opts); return { started: true, pid: 7 }; },
      railEnabled: () => true,
    });
    expect(res.started).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].prNumber).toBe(42);
  });

  test('does NOT start when the rail is disabled', () => {
    let called = false;
    const res = maybeStartPrWatcher({
      dryRun: false, prNumber: 42,
      startWatcher: () => { called = true; return { started: true }; },
      railEnabled: () => false,
    });
    expect(called).toBe(false);
    expect(res.started).toBe(false);
    expect(res.reason).toMatch(/rail\.auto_shepherd/);
  });

  test('rail is not even consulted on a dry run / missing PR (skip wins first)', () => {
    let railChecked = false;
    const res = maybeStartPrWatcher({
      dryRun: true, prNumber: 5,
      startWatcher: () => ({ started: true }),
      railEnabled: () => { railChecked = true; return true; },
    });
    expect(res.started).toBe(false);
    expect(railChecked).toBe(false);
  });

  test('never fails ship even if the rail check throws', () => {
    const res = maybeStartPrWatcher({
      dryRun: false, prNumber: 9,
      startWatcher: () => ({ started: true }),
      railEnabled: () => { throw new Error('boom'); },
    });
    expect(res.started).toBe(false);
    expect(res.reason).toMatch(/boom/);
  });
});
