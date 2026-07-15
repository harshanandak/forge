'use strict';

/**
 * Unit tests for the control-plane taxonomy (B6 / 7dc59af2 + 724356ea).
 *
 * The module is the single source of truth for the guarantee matrix at
 * docs/reference/control-plane-guarantees.md: it classifies each surface,
 * derives the tri-state label, names the enforcement-locus, renders the read
 * badge, and resolves a `forge control` write-intent into the ONE
 * resolver-enforced field (workflow.gates.<id>.enabled) — refusing surfaces
 * Forge cannot actually deny at run time.
 */

const { describe, test, expect } = require('bun:test');

const {
  HUMAN_GATE_IDS,
  classifySurface,
  isControllable,
  enforcementLocus,
  badgeFor,
  deriveState,
  describeControl,
  planControl,
} = require('../lib/control-plane');

describe('classifySurface', () => {
  test('human gates are distinguished from ordinary gates', () => {
    expect(classifySurface('gate.intent')).toBe('human-gate');
    expect(classifySurface('gate.plan-approval')).toBe('human-gate');
    expect(classifySurface('gate.merge')).toBe('human-gate');
  });

  test('ordinary stage gates + issue_verify are gates', () => {
    expect(classifySurface('gate.plan-exit')).toBe('gate');
    expect(classifySurface('gate.issue_verify')).toBe('gate');
  });

  test('rails, mcp, rules, skills, and unknowns', () => {
    expect(classifySurface('rail.kernel_tracking')).toBe('rail');
    expect(classifySurface('mcp.context7')).toBe('mcp');
    expect(classifySurface('rule.tdd')).toBe('rule');
    expect(classifySurface('skill.plan')).toBe('skill');
    expect(classifySurface('nonsense')).toBe('unknown');
  });

  test('HUMAN_GATE_IDS is the closed human-gate set', () => {
    expect([...HUMAN_GATE_IDS].sort()).toEqual(
      ['gate.intent', 'gate.merge', 'gate.plan-approval'],
    );
  });
});

describe('isControllable — only gates/rails have a real run-time deny', () => {
  test('gates and rails are controllable', () => {
    expect(isControllable('gate.plan-exit')).toBe(true);
    expect(isControllable('gate.merge')).toBe(true);
    expect(isControllable('rail.kernel_tracking')).toBe(true);
  });
  test('mcp/rules/skills/unknown are NOT controllable (presence-only)', () => {
    expect(isControllable('mcp.context7')).toBe(false);
    expect(isControllable('rule.tdd')).toBe(false);
    expect(isControllable('skill.plan')).toBe(false);
    expect(isControllable('nonsense')).toBe(false);
  });
});

describe('enforcementLocus', () => {
  test('maps each surface to its honest locus string', () => {
    expect(enforcementLocus('gate')).toBe('run-time-deny (gate)');
    expect(enforcementLocus('rail')).toBe('run-time-deny (rail)');
    expect(enforcementLocus('human-gate')).toBe('run-time-deny (permission)');
    expect(enforcementLocus('mcp')).toBe('render-time presence-only');
    expect(enforcementLocus('rule')).toBe('render-time presence-only');
    expect(enforcementLocus('skill')).toBe('render-time presence-only');
  });
});

describe('deriveState — label read back from (enabled, locked, surface)', () => {
  test('non-human gate/rail', () => {
    expect(deriveState({ id: 'gate.plan-exit', enabled: true })).toBe('mandatory');
    expect(deriveState({ id: 'gate.plan-exit', enabled: false })).toBe('optional');
    expect(deriveState({ id: 'rail.kernel_tracking', enabled: true })).toBe('mandatory');
  });
  test('human gate', () => {
    expect(deriveState({ id: 'gate.merge', enabled: true })).toBe('permission');
    expect(deriveState({ id: 'gate.merge', enabled: false })).toBe('optional');
  });
  test('advisory surfaces have no state', () => {
    expect(deriveState({ id: 'mcp.context7', enabled: true })).toBe(null);
  });
});

describe('badgeFor — the read-view badge reflects locus + current state', () => {
  test('enabled gate/rail render ENFORCED', () => {
    expect(badgeFor({ id: 'gate.plan-exit', enabled: true })).toBe('ENFORCED (gate)');
    expect(badgeFor({ id: 'rail.kernel_tracking', enabled: true })).toBe('ENFORCED (rail)');
  });
  test('enabled human gate renders PERMISSION', () => {
    expect(badgeFor({ id: 'gate.merge', enabled: true })).toBe('PERMISSION (human approval)');
  });
  test('disabled controllable renders OFF', () => {
    expect(badgeFor({ id: 'gate.plan-exit', enabled: false })).toBe('OFF (optional)');
    expect(badgeFor({ id: 'gate.merge', enabled: false })).toBe('OFF (optional)');
  });
  test('advisory surfaces render PRESENT (advisory)', () => {
    expect(badgeFor({ id: 'mcp.context7', enabled: true })).toBe('PRESENT (advisory)');
    expect(badgeFor({ id: 'skill.plan' })).toBe('PRESENT (advisory)');
  });
  test('locked adds a LOCKED marker', () => {
    expect(badgeFor({ id: 'rail.locked_example', enabled: true, locked: true }))
      .toBe('ENFORCED (rail) · LOCKED');
  });
});

describe('describeControl — the full read record for a primitive', () => {
  test('shapes a gate record', () => {
    const rec = describeControl({ id: 'gate.plan-exit', enabled: true, locked: false });
    expect(rec).toMatchObject({
      id: 'gate.plan-exit',
      surface: 'gate',
      controllable: true,
      state: 'mandatory',
      locus: 'run-time-deny (gate)',
      badge: 'ENFORCED (gate)',
      locked: false,
    });
  });
  test('shapes an advisory record with no state and controllable=false', () => {
    const rec = describeControl({ id: 'mcp.context7', enabled: true });
    expect(rec.surface).toBe('mcp');
    expect(rec.controllable).toBe(false);
    expect(rec.state).toBe(null);
    expect(rec.badge).toBe('PRESENT (advisory)');
  });
});

describe('planControl — resolve a tri-state write-intent to enabled, honestly', () => {
  test('mandatory on a gate/rail -> enabled=true', () => {
    expect(planControl({ id: 'gate.plan-exit', locked: false }, 'mandatory'))
      .toMatchObject({ ok: true, enabled: true });
    expect(planControl({ id: 'rail.kernel_tracking', locked: false }, 'mandatory'))
      .toMatchObject({ ok: true, enabled: true });
  });

  test('optional on an unlocked controllable -> enabled=false', () => {
    expect(planControl({ id: 'gate.plan-exit', locked: false }, 'optional'))
      .toMatchObject({ ok: true, enabled: false });
  });

  test('permission on a human gate -> enabled=true', () => {
    expect(planControl({ id: 'gate.merge', locked: false }, 'permission'))
      .toMatchObject({ ok: true, enabled: true });
  });

  test('permission on a NON-human gate/rail is refused', () => {
    const r = planControl({ id: 'gate.plan-exit', locked: false }, 'permission');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/permission/i);
    expect(r.error).toMatch(/human gate/i);
  });

  test('mandatory on a human gate is refused (directs to permission)', () => {
    const r = planControl({ id: 'gate.merge', locked: false }, 'mandatory');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/permission/i);
  });

  test('optional on a LOCKED primitive is refused', () => {
    const r = planControl({ id: 'rail.kernel_tracking', locked: true }, 'optional');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/locked/i);
  });

  test('any advisory surface is refused with the guarantee-matrix pointer', () => {
    for (const id of ['mcp.context7', 'rule.tdd', 'skill.plan']) {
      const r = planControl({ id }, 'mandatory');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/presence-only/i);
      expect(r.error).toMatch(/not enforceable/i);
      expect(r.error).toMatch(/control-plane-guarantees\.md/);
    }
  });

  test('an unknown tri-state value is refused', () => {
    const r = planControl({ id: 'gate.plan-exit', locked: false }, 'sometimes');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mandatory|optional|permission/);
  });
});
