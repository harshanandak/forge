const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('plan.md integration', () => {
  const planMdPath = path.join(__dirname, '..', '..', '.claude', 'commands', 'plan.md');

  test('Phase 1 includes dep-guard ripple check step', () => {
    const content = fs.readFileSync(planMdPath, 'utf-8');
    expect(content).toContain('dep-guard.sh check-ripple');
    expect(content).toContain('Dependency ripple check');
    const rippleIdx = content.indexOf('Dependency ripple check');
    const step1Idx = content.indexOf('Step 1: Explore project context');
    expect(rippleIdx).toBeLessThan(step1Idx);
    expect(rippleIdx).toBeGreaterThan(0);
  });

  test('Phase 3 includes contract extraction and storage steps', () => {
    const content = fs.readFileSync(planMdPath, 'utf-8');
    expect(content).toContain('dep-guard.sh extract-contracts');
    expect(content).toContain('dep-guard.sh store-contracts');
    const step5bIdx = content.indexOf('Step 5b: Beads context');
    const step5cIdx = content.indexOf('Step 5c: Contract extraction');
    expect(step5cIdx).toBeGreaterThan(step5bIdx);
  });

  test('Phase 3 HARD-GATE includes dep-guard store-contracts check', () => {
    const content = fs.readFileSync(planMdPath, 'utf-8');
    const hardGateIdx = content.indexOf('HARD-GATE: /plan exit');
    const afterHardGate = content.substring(hardGateIdx);
    expect(afterHardGate).toContain('dep-guard');
  });

  test('plan.md contains Ripple Analyst agent prompt section', () => {
    const content = fs.readFileSync(planMdPath, 'utf-8');
    expect(content).toContain('Ripple Analyst');
    expect(content).toContain('break scenarios');
    expect(content).toContain('NONE');
    expect(content).toContain('CRITICAL');
    expect(content).toContain('default to HIGH');
    expect(content).toContain('Recommendation');
  });

  test('plan.md documents the Beads-aware Phase 3 approval flow', () => {
    const content = fs.readFileSync(planMdPath, 'utf-8');
    expect(content).toContain('bd worktree create');
    expect(content).toContain('logic-level analysis');
    expect(content).toContain('user approval');
    expect(content).toContain('bd dep cycles');
  });
});
