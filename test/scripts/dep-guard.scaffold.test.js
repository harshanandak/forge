const fs = require('node:fs');
const { describe, test, expect } = require('bun:test');
const { runDepGuard, SCRIPT } = require('./dep-guard.helpers');

describe('scripts/dep-guard.sh', () => {
  describe('file structure', () => {
    test('script exists at scripts/dep-guard.sh', () => {
      expect(fs.existsSync(SCRIPT)).toBeTruthy();
    });
  });

  describe('usage and unknown subcommand', () => {
    test('no args prints usage containing "Usage:" and exits 1', () => {
      const result = runDepGuard([]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage:');
    });

    test('unknown subcommand prints error and exits 1', () => {
      const result = runDepGuard(['unknown-subcommand']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unknown subcommand');
    });
  });

  describe('stub subcommands exit 1 with no args', () => {
    test('find-consumers with no args exits 1', () => {
      const result = runDepGuard(['find-consumers']);
      expect(result.status).toBe(1);
    });

    test('check-ripple with no args exits 1', () => {
      const result = runDepGuard(['check-ripple']);
      expect(result.status).toBe(1);
    });

    test('store-contracts with no args exits 1', () => {
      const result = runDepGuard(['store-contracts']);
      expect(result.status).toBe(1);
    });

    test('extract-contracts with no args exits 1', () => {
      const result = runDepGuard(['extract-contracts']);
      expect(result.status).toBe(1);
    });
  });
});
