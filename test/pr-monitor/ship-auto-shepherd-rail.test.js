'use strict';

const { describe, test, expect } = require('bun:test');

const { maybeTriggerShepherdAfterShip, autoShepherdRailEnabled } = require('../../lib/commands/ship');
const { getDefaultRuntimeGraph } = require('../../lib/core/runtime-graph');

// rail.auto_shepherd (issue cf8361bc / epic c2d398e5): the default-ON, UNLOCKED
// rail that governs whether the shared singleton trigger launches. Toggle via `forge gate disable
// rail.auto_shepherd`. These tests pin: (1) the rail is registered default-ON +
// unlocked; (2) the resolver-backed check is fail-OPEN (default-ON on any error);
// (3) the ship seam delegates to the shared trigger without failing ship.

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

describe('maybeTriggerShepherdAfterShip — rail gating', () => {
  test('delegates rail gating to the shared singleton trigger', () => {
    const calls = [];
    const res = maybeTriggerShepherdAfterShip({
      dryRun: false, projectRoot: '/root',
      fireAndForget: (opts) => calls.push(opts),
    });
    expect(res.started).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ projectRoot: '/root', dryRun: false });
  });

  test('does not duplicate the rail check outside the shared trigger', () => {
    let called = false;
    const res = maybeTriggerShepherdAfterShip({
      dryRun: false, projectRoot: '/root',
      fireAndForget: () => { called = true; },
    });
    expect(called).toBe(true);
    expect(res.started).toBe(true);
  });

  test('dry-run skips before the shared trigger is called', () => {
    let called = false;
    const res = maybeTriggerShepherdAfterShip({
      dryRun: true, projectRoot: '/root',
      fireAndForget: () => { called = true; },
    });
    expect(res.started).toBe(false);
    expect(called).toBe(false);
  });

  test('never fails ship even if the shared trigger throws', () => {
    const res = maybeTriggerShepherdAfterShip({
      dryRun: false, projectRoot: '/root',
      fireAndForget: () => { throw new Error('boom'); },
    });
    expect(res.started).toBe(false);
    expect(res.reason).toMatch(/boom/);
  });
});
