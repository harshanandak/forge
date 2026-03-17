const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, test, expect } = require('bun:test');

/**
 * Tests for scripts/dep-guard.sh
 *
 * The script provides dependency-guard subcommands:
 *   find-consumers, check-ripple, store-contracts, extract-contracts
 *
 * Task 1 tests the scaffold: existence, usage, unknown subcommand,
 * and stub behavior for each subcommand with no args.
 */

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'dep-guard.sh');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

/**
 * Run the dep-guard script with given arguments.
 * @param {string[]} args - CLI arguments
 * @param {object} env - Additional environment variables
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runDepGuard(args = [], env = {}) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 15000,
    env: {
      ...process.env,
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

describe('scripts/dep-guard.sh', () => {
  describe('file structure', () => {
    test('script exists at scripts/dep-guard.sh', () => {
      expect(fs.existsSync(SCRIPT)).toBe(true);
    });
  });

  describe('usage and unknown subcommand', () => {
    test('no args prints usage containing "Usage:" and exits 1', () => {
      const result = runDepGuard([]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage:');
    });

    test('unknown subcommand prints error and exits 1', () => {
      const result = runDepGuard(['bogus-command']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Error: Unknown subcommand');
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
