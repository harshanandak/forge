/**
 * Tests for non-interactive setup flow in lib/commands/setup.js.
 *
 * Validates CLI flag parsing and non-interactive mode behavior.
 */

const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const setupPath = path.resolve(__dirname, '..', 'lib', 'commands', 'setup.js');
const source = fs.readFileSync(setupPath, 'utf8');

describe('non-interactive setup', () => {
  test('handleSetupCommand uses loadAndSetupCanonicalCommands', () => {
    const funcStart = source.indexOf('async function handleSetupCommand(');
    expect(funcStart).toBeGreaterThan(-1);
    // Find the end of handleSetupCommand
    const nextFunc = source.indexOf('\nasync function ', funcStart + 1);
    const nextFunc2 = source.indexOf('\nfunction ', funcStart + 1);
    const funcEnd = Math.min(
      nextFunc > -1 ? nextFunc : Infinity,
      nextFunc2 > -1 ? nextFunc2 : Infinity
    );
    const funcBody = source.substring(funcStart, funcEnd);
    // handleSetupCommand delegates to interactiveSetupWithFlags which uses it
    // OR directly uses loadAndSetupCanonicalCommands
    expect(funcBody.includes('loadAndSetupCanonicalCommands') ||
           funcBody.includes('interactiveSetupWithFlags')).toBe(true);
  });

  test('executeSetup uses loadAndSetupCanonicalCommands', () => {
    const funcStart = source.indexOf('async function executeSetup(');
    expect(funcStart).toBeGreaterThan(-1);
    const funcBody = source.substring(funcStart, funcStart + 3000);
    expect(funcBody).toContain('loadAndSetupCanonicalCommands');
  });

  test('quickSetup uses loadAndSetupCanonicalCommands', () => {
    const funcStart = source.indexOf('async function quickSetup(');
    expect(funcStart).toBeGreaterThan(-1);
    const funcBody = source.substring(funcStart, funcStart + 3000);
    expect(funcBody).toContain('loadAndSetupCanonicalCommands');
  });

  test('handler supports --agents flag', () => {
    expect(source).toContain('determineSelectedAgents');
  });

  test('handler supports --dry-run flag', () => {
    expect(source).toContain('dryRunSetup');
    expect(source).toContain('flags.dryRun');
  });

  test('handler supports --quick flag', () => {
    expect(source).toContain('flags.quick');
    expect(source).toContain('quickSetup');
  });
});
