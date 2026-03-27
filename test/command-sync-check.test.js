const { describe, test, expect } = require('bun:test');
const { execSync } = require('child_process');
const path = require('path');

/**
 * Verify command files are synced to all agent directories.
 *
 * Note: execSync runs a fixed script path with --check flag.
 * No user input — safe from injection.
 */
describe('Command sync check', () => {
  test('sync-commands.js --check exits 0 (all commands synced)', () => {
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'sync-commands.js');
    let exitCode = 0;
    try {
      execSync(`node "${scriptPath}" --check`, {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        timeout: 30000,
      });
    } catch (err) {
      exitCode = err.status;
    }
    expect(exitCode).toBe(0);
  });
});
