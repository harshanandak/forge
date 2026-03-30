/**
 * Structural test: verify bin/forge.js does NOT contain hard-coded dispatch
 * blocks for commands that should be handled exclusively by the registry.
 *
 * Task 3 of CLI Maturity epic — removing hard-coded recommend/team dispatch.
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

  test('should still contain registry dispatch block', () => {
    // The registry dispatch must remain — it handles all auto-discovered commands.
    const hasRegistryDispatch = /registry\.commands\.has\(command\)/.test(forgeSource);
    expect(hasRegistryDispatch).toBe(true);
  });
});
