/**
 * Registry Compliance Tests — Wave 1b
 *
 * Verifies that plan, ship, and validate command modules export
 * the correct shape required by the forge command registry:
 *   - name: string matching the command name
 *   - handler: function (async allowed)
 *   - description: non-empty string
 *
 * Also verifies that existing utility exports are preserved (no regressions).
 *
 * @module test/commands/registry-compliance-wave1b
 */

const { describe, it, expect } = require('bun:test');

describe('Registry compliance — wave 1b', () => {
  describe('plan', () => {
    const mod = require('../../lib/commands/plan');

    it('exports name === "plan"', () => {
      expect(mod.name).toBe('plan');
    });

    it('exports a handler function', () => {
      expect(typeof mod.handler).toBe('function');
    });

    it('exports a non-empty description', () => {
      expect(typeof mod.description).toBe('string');
      expect(mod.description.length).toBeGreaterThan(0);
    });

    it('preserves existing utility exports', () => {
      expect(typeof mod.readResearchDoc).toBe('function');
      expect(typeof mod.detectScope).toBe('function');
      expect(typeof mod.createBeadsIssue).toBe('function');
      expect(typeof mod.createFeatureBranch).toBe('function');
      expect(typeof mod.extractDesignDecisions).toBe('function');
      expect(typeof mod.extractTasksFromResearch).toBe('function');
      expect(typeof mod.detectDRYViolation).toBe('function');
      expect(typeof mod.applyYAGNIFilter).toBe('function');
      expect(typeof mod.executePlan).toBe('function');
    });
  });

  describe('ship', () => {
    const mod = require('../../lib/commands/ship');

    it('exports name === "ship"', () => {
      expect(mod.name).toBe('ship');
    });

    it('exports a handler function', () => {
      expect(typeof mod.handler).toBe('function');
    });

    it('exports a non-empty description', () => {
      expect(typeof mod.description).toBe('string');
      expect(mod.description.length).toBeGreaterThan(0);
    });

    it('preserves existing utility exports', () => {
      expect(typeof mod.extractKeyDecisions).toBe('function');
      expect(typeof mod.extractTestScenarios).toBe('function');
      expect(typeof mod.getTestCoverage).toBe('function');
      expect(typeof mod.generatePRBody).toBe('function');
      expect(typeof mod.validatePRTitle).toBe('function');
      expect(typeof mod.createPR).toBe('function');
      expect(typeof mod.executeShip).toBe('function');
    });
  });

  describe('validate', () => {
    const mod = require('../../lib/commands/validate');

    it('exports name === "validate"', () => {
      expect(mod.name).toBe('validate');
    });

    it('exports a handler function', () => {
      expect(typeof mod.handler).toBe('function');
    });

    it('exports a non-empty description', () => {
      expect(typeof mod.description).toBe('string');
      expect(mod.description.length).toBeGreaterThan(0);
    });

    it('preserves existing utility exports', () => {
      expect(typeof mod.runTypeCheck).toBe('function');
      expect(typeof mod.runLint).toBe('function');
      expect(typeof mod.runSecurityScan).toBe('function');
      expect(typeof mod.runAllTests).toBe('function');
      expect(typeof mod.executeValidate).toBe('function');
      expect(typeof mod.executeDebugMode).toBe('function');
    });
  });
});
