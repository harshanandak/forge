const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('plan.md integration', () => {
  const planDir = path.join(__dirname, '..', '..', 'skills', 'plan');

  // The plan skill uses progressive disclosure: SKILL.md is a table-of-contents and
  // the per-phase detail lives in references/. These tests assert the skill DOCUMENTS
  // each step, so they read the combined content (SKILL.md + the phase references, in
  // phase order) rather than SKILL.md alone.
  function readPlanSkill() {
    const files = [
      path.join(planDir, 'SKILL.md'),
      path.join(planDir, 'references', 'phase1-design.md'),
      path.join(planDir, 'references', 'phase2-research.md'),
      path.join(planDir, 'references', 'phase3-setup.md'),
    ];
    return files.filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf-8')).join('\n');
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
