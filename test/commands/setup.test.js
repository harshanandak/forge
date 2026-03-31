/**
 * Setup Command — Registry Compliance & Shape Tests
 *
 * Verifies lib/commands/setup.js exports the correct registry shape
 * and that key setup functions are accessible.
 *
 * @module test/commands/setup
 */

const { describe, it, expect } = require('bun:test');

describe('setup command', () => {
  const mod = require('../../lib/commands/setup');

  describe('registry shape', () => {
    it('exports name === "setup"', () => {
      expect(mod.name).toBe('setup');
    });

    it('exports a description string', () => {
      expect(typeof mod.description).toBe('string');
      expect(mod.description.length).toBeGreaterThan(0);
    });

    it('exports a handler function', () => {
      expect(typeof mod.handler).toBe('function');
    });
  });

  describe('exported internals', () => {
    it('exports checkPrerequisites function', () => {
      expect(typeof mod.checkPrerequisites).toBe('function');
    });

    it('exports setupCoreDocs function', () => {
      expect(typeof mod.setupCoreDocs).toBe('function');
    });

    it('exports displaySetupSummary function', () => {
      expect(typeof mod.displaySetupSummary).toBe('function');
    });

    it('exports setupAgent function', () => {
      expect(typeof mod.setupAgent).toBe('function');
    });

    it('exports quickSetup function', () => {
      expect(typeof mod.quickSetup).toBe('function');
    });

    it('exports interactiveSetupWithFlags function', () => {
      expect(typeof mod.interactiveSetupWithFlags).toBe('function');
    });

    it('exports dryRunSetup function', () => {
      expect(typeof mod.dryRunSetup).toBe('function');
    });

    it('exports handleSetupCommand function', () => {
      expect(typeof mod.handleSetupCommand).toBe('function');
    });

    it('exports executeSetup function', () => {
      expect(typeof mod.executeSetup).toBe('function');
    });

    it('exports handleExternalServices function', () => {
      expect(typeof mod.handleExternalServices).toBe('function');
    });
  });
});
