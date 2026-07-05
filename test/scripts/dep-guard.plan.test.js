const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('plan.md integration', () => {
  const planDir = path.join(__dirname, '..', '..', 'skills', 'plan');

  // The plan skill body is kept whole (its HARD-GATEs and stage-transition contracts
  // must load on every trigger), so all documented steps live in SKILL.md. These tests
  // assert the skill DOCUMENTS each dep-guard step by reading SKILL.md directly — asserted
  // to exist so a missing/renamed skill file fails fast instead of reading empty content.
  function readPlanSkill() {
    const skillFile = path.join(planDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      throw new Error(`Missing plan skill file: ${skillFile}`);
    }
    return fs.readFileSync(skillFile, 'utf-8');
  }

  test('Phase 1 includes dep-guard ripple check step', () => {
    const content = readPlanSkill();
    expect(content).toContain('dep-guard.sh check-ripple');
    expect(content).toContain('Dependency ripple check');
    const rippleIdx = content.indexOf('Dependency ripple check');
    const step1Idx = content.indexOf('Step 1: Explore project context');
    expect(rippleIdx).toBeLessThan(step1Idx);
    expect(rippleIdx).toBeGreaterThan(0);
  });

  test('Phase 3 includes contract extraction and storage steps', () => {
    const content = readPlanSkill();
    expect(content).toContain('dep-guard.sh extract-contracts');
    expect(content).toContain('dep-guard.sh store-contracts');
    const step5bIdx = content.indexOf('Step 5b: Beads context');
    const step5cIdx = content.indexOf('Step 5c: Contract extraction');
    expect(step5cIdx).toBeGreaterThan(step5bIdx);
  });

  test('Phase 3 HARD-GATE includes dep-guard store-contracts check', () => {
    const content = readPlanSkill();
    const hardGateIdx = content.indexOf('HARD-GATE: /plan exit');
    expect(hardGateIdx).toBeGreaterThanOrEqual(0);
    const afterHardGate = content.substring(hardGateIdx);
    expect(afterHardGate).toContain('dep-guard');
  });

  test('plan.md contains Ripple Analyst agent prompt section', () => {
    const content = readPlanSkill();
    expect(content).toContain('Ripple Analyst');
    expect(content).toContain('break scenarios');
    expect(content).toContain('NONE');
    expect(content).toContain('CRITICAL');
    expect(content).toContain('default to HIGH');
    expect(content).toContain('Recommendation');
  });

  test('plan skill documents the Phase 3 dependency approval flow', () => {
    const content = readPlanSkill();
    expect(content).toContain('forge worktree create');
    expect(content).toContain('logic-level dependency review');
    expect(content).toContain('user approval');
    expect(content).toContain('forge issue blocked');
  });
});
