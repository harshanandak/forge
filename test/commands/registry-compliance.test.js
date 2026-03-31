/**
 * Registry Compliance Tests
 *
 * Verifies that all command modules export the correct shape
 * required by the forge command registry:
 *   - name: string matching the command name
 *   - handler: function (async allowed)
 *
 * @module test/commands/registry-compliance
 */

const { describe, it, expect } = require('bun:test');

describe('Registry compliance', () => {
  describe('dev', () => {
    const mod = require('../../lib/commands/dev');

    it('exports name === "dev"', () => {
      expect(mod.name).toBe('dev');
    });

    it('exports a handler function', () => {
      expect(typeof mod.handler).toBe('function');
    });
  });

  describe('status', () => {
    const mod = require('../../lib/commands/status');

    it('exports name === "status"', () => {
      expect(mod.name).toBe('status');
    });

    it('exports a handler function', () => {
      expect(typeof mod.handler).toBe('function');
    });
  });

  describe('recommend', () => {
    const mod = require('../../lib/commands/recommend');

    it('exports name === "recommend"', () => {
      expect(mod.name).toBe('recommend');
    });

    it('exports a handler function', () => {
      expect(typeof mod.handler).toBe('function');
    });
  });

  describe('team', () => {
    const mod = require('../../lib/commands/team');

    it('exports name === "team"', () => {
      expect(mod.name).toBe('team');
    });

    it('exports a handler function', () => {
      expect(typeof mod.handler).toBe('function');
    });
  });
});
