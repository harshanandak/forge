const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('executeSetup shared helper (forge-cpnj)', () => {
  const setupPath = path.join(__dirname, '..', 'lib', 'commands', 'setup.js');
  const content = fs.readFileSync(setupPath, 'utf-8');

  test('executeSetup function exists', () => {
    expect(content).toContain('async function executeSetup(');
  });

  test('handleSetupCommand calls executeSetup', () => {
    // Extract handleSetupCommand function body
    const funcStart = content.indexOf('async function handleSetupCommand(');
    expect(funcStart).toBeGreaterThan(-1);
    const funcBody = content.substring(funcStart, funcStart + 2000);
    expect(funcBody).toContain('executeSetup(');
  });

  test('the old claude-skipping guard is removed from handleSetupCommand', () => {
    // The old bug: agentKey !== 'claude' inside handleSetupCommand
    const funcStart = content.indexOf('async function handleSetupCommand(');
    expect(funcStart).toBeGreaterThan(-1);
    // Find the end of handleSetupCommand (next top-level function or end)
    const nextFunc = content.indexOf('\nasync function ', funcStart + 1);
    const nextFunc2 = content.indexOf('\nfunction ', funcStart + 1);
    const funcEnd = Math.min(
      nextFunc > -1 ? nextFunc : Infinity,
      nextFunc2 > -1 ? nextFunc2 : Infinity
    );
    const funcBody = content.substring(funcStart, funcEnd);
    expect(funcBody).not.toContain("agentKey !== 'claude'");
  });

  test('executeSetup uses loadAndSetupClaudeCommands when claude is in agents', () => {
    const funcStart = content.indexOf('async function executeSetup(');
    expect(funcStart).toBeGreaterThan(-1);
    const funcBody = content.substring(funcStart, funcStart + 3000);
    expect(funcBody).toContain('loadAndSetupClaudeCommands');
  });

  test('executeSetup calls setupAgent for all agents without claude exclusion', () => {
    const funcStart = content.indexOf('async function executeSetup(');
    expect(funcStart).toBeGreaterThan(-1);
    // Find end of executeSetup
    const nextFunc = content.indexOf('\nasync function ', funcStart + 1);
    const nextFunc2 = content.indexOf('\nfunction ', funcStart + 1);
    const funcEnd = Math.min(
      nextFunc > -1 ? nextFunc : Infinity,
      nextFunc2 > -1 ? nextFunc2 : Infinity
    );
    const funcBody = content.substring(funcStart, funcEnd);
    // Should call setupSelectedAgents for consistent progress output
    expect(funcBody).toContain('setupSelectedAgents(');
    // Should NOT have the bare claude exclusion guard
    expect(funcBody).not.toContain("agentKey !== 'claude'");
  });

  test('executeSetup calls setupCoreDocs', () => {
    const funcStart = content.indexOf('async function executeSetup(');
    expect(funcStart).toBeGreaterThan(-1);
    const funcBody = content.substring(funcStart, funcStart + 3000);
    expect(funcBody).toContain('setupCoreDocs()');
  });

  test('executeSetup installs git hooks', () => {
    const funcStart = content.indexOf('async function executeSetup(');
    expect(funcStart).toBeGreaterThan(-1);
    const funcBody = content.substring(funcStart, funcStart + 3000);
    expect(funcBody).toContain('installGitHooks()');
  });

  test('executeSetup handles external services', () => {
    const funcStart = content.indexOf('async function executeSetup(');
    expect(funcStart).toBeGreaterThan(-1);
    const funcBody = content.substring(funcStart, funcStart + 3000);
    expect(funcBody).toContain('handleExternalServices');
  });

  test('executeSetup accepts config object with agents and skipExternal properties', () => {
    const funcStart = content.indexOf('async function executeSetup(');
    expect(funcStart).toBeGreaterThan(-1);
    const funcBody = content.substring(funcStart, funcStart + 200);
    expect(funcBody).toContain('config');
  });
});
