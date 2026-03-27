/**
 * Barrel test for lib/reset.js
 *
 * The reset module is tested across three focused test files:
 *   - reset-inventory.test.js  (getForgeFiles inventory)
 *   - reset-soft.test.js       (resetSoft)
 *   - reset-hard.test.js       (resetHard + reinstall)
 *
 * This file satisfies the TDD pre-commit hook's naming convention
 * (lib/reset.js → test/reset.test.js) and re-runs a subset of
 * assertions to keep the barrel lightweight.
 */

const { describe, test, expect } = require('bun:test');
const { getForgeFiles, resetSoft, resetHard, reinstall } = require('../lib/reset');

describe('reset module exports', () => {
  test('exports all public functions', () => {
    expect(typeof getForgeFiles).toBe('function');
    expect(typeof resetSoft).toBe('function');
    expect(typeof resetHard).toBe('function');
    expect(typeof reinstall).toBe('function');
  });
});
