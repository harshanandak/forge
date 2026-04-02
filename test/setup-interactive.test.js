/**
 * Tests for interactive setup flow in lib/commands/setup.js.
 *
 * Validates that the interactive path uses loadAndSetupCanonicalCommands
 * and delegates to extracted helpers.
 */

const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const setupPath = path.resolve(__dirname, '..', 'lib', 'commands', 'setup.js');
const source = fs.readFileSync(setupPath, 'utf8');

describe('interactive setup', () => {
  test('interactiveSetupWithFlags calls loadAndSetupCanonicalCommands', () => {
    // Find the interactiveSetupWithFlags function
    const funcStart = source.indexOf('async function interactiveSetupWithFlags(');
    expect(funcStart).toBeGreaterThan(-1);
    const funcBody = source.substring(funcStart, funcStart + 5000);
    expect(funcBody).toContain('loadAndSetupCanonicalCommands');
  });

  test('interactiveSetupWithFlags delegates to extracted helpers', () => {
    const funcStart = source.indexOf('async function interactiveSetupWithFlags(');
    expect(funcStart).toBeGreaterThan(-1);
    const funcBody = source.substring(funcStart, funcStart + 5000);
    expect(funcBody).toContain('setupSelectedAgents');
    expect(funcBody).toContain('handleExternalServicesStep');
  });

  test('function detectConfiguredAgents exists in source', () => {
    expect(source).toContain('function detectConfiguredAgents(');
  });

  test('function parseSetupFlags exists in source', () => {
    expect(source).toContain('function parseSetupFlags(');
  });

  test('function removeAgentFiles exists in source', () => {
    expect(source).toContain('function removeAgentFiles(');
  });
});
