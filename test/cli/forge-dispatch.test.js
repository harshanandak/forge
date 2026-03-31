/**
 * Structural test: verify bin/forge.js does NOT contain hard-coded dispatch
 * blocks for commands that should be handled exclusively by the registry.
 *
 * Task 3 of CLI Maturity epic — removing hard-coded recommend/team dispatch.
 * Task 12 — removing remaining hard-coded docs/reset/reinstall dispatch.
 */
const fs = require('fs');
const path = require('path');
const { describe, test, expect } = require('bun:test');

const forgePath = path.resolve(__dirname, '../../bin/forge.js');
const forgeSource = fs.readFileSync(forgePath, 'utf8');

describe('forge.js dispatch — no hard-coded registry commands', () => {
  test('should NOT contain hard-coded recommend dispatch', () => {
    // Match patterns like: command === 'recommend' or command === "recommend"
    // These indicate a hard-coded dispatch block bypassing the registry.
    const hasHardcodedRecommend = /command\s*===\s*['"]recommend['"]/.test(forgeSource);
    expect(hasHardcodedRecommend).toBe(false);
  });

  test('should NOT contain hard-coded team dispatch', () => {
    // Match patterns like: command === 'team' or command === "team"
    const hasHardcodedTeam = /command\s*===\s*['"]team['"]/.test(forgeSource);
    expect(hasHardcodedTeam).toBe(false);
  });

  test('should NOT contain hard-coded docs dispatch', () => {
    const hasHardcodedDocs = /command\s*===\s*['"]docs['"]/.test(forgeSource);
    expect(hasHardcodedDocs).toBe(false);
  });

  test('should NOT contain hard-coded reset dispatch', () => {
    const hasHardcodedReset = /command\s*===\s*['"]reset['"]/.test(forgeSource);
    expect(hasHardcodedReset).toBe(false);
  });

  test('should NOT contain hard-coded reinstall dispatch', () => {
    const hasHardcodedReinstall = /command\s*===\s*['"]reinstall['"]/.test(forgeSource);
    expect(hasHardcodedReinstall).toBe(false);
  });

  test('should still contain registry dispatch block', () => {
    // The registry dispatch must remain — it handles all auto-discovered commands.
    const hasRegistryDispatch = /registry\.commands\.has\(command\)/.test(forgeSource);
    expect(hasRegistryDispatch).toBe(true);
  });

  test('bin/forge.js should be under 500 lines', () => {
    const lineCount = forgeSource.split('\n').length;
    expect(lineCount).toBeLessThan(500);
  });
});

describe('registry command modules exist for docs, reset, reinstall', () => {
  test('lib/commands/docs.js exists and exports registry interface', () => {
    const mod = require('../../lib/commands/docs');
    expect(mod.name).toBe('docs');
    expect(typeof mod.description).toBe('string');
    expect(typeof mod.handler).toBe('function');
  });

  test('lib/commands/reset.js exists and exports registry interface', () => {
    const mod = require('../../lib/commands/reset');
    expect(mod.name).toBe('reset');
    expect(typeof mod.description).toBe('string');
    expect(typeof mod.handler).toBe('function');
  });

  test('lib/commands/reinstall.js exists and exports registry interface', () => {
    const mod = require('../../lib/commands/reinstall');
    expect(mod.name).toBe('reinstall');
    expect(typeof mod.description).toBe('string');
    expect(typeof mod.handler).toBe('function');
  });
});
