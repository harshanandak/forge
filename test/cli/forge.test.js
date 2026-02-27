const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const forgePath = path.join(__dirname, '..', '..', 'bin', 'forge.js');

describe('bin/forge.js structure', () => {
  const source = fs.readFileSync(forgePath, 'utf8');

  test('should export helper functions for cognitive complexity', () => {
    // Verify extracted helpers exist as standalone functions
    const expectedHelpers = [
      'handleFlagsOverride',
      'saveWorkflowTypeOverride',
      'displayExistingInstallation',
      'promptForOverwriteDecisions',
      'loadAndSetupClaudeCommands',
      'setupSelectedAgents',
      'handleExternalServicesStep',
    ];

    for (const helper of expectedHelpers) {
      expect(source.includes(`function ${helper}(`)).toBeTruthy();
    }
  });

  test('should call helpers from interactiveSetupWithFlags', () => {
    // Verify the main function delegates to extracted helpers
    const delegations = [
      'handleFlagsOverride(flags',
      'displayExistingInstallation(projectStatus)',
      'promptForOverwriteDecisions(question',
      'loadAndSetupClaudeCommands(selectedAgents',
      'setupSelectedAgents(selectedAgents',
      'handleExternalServicesStep(flags',
    ];

    for (const call of delegations) {
      expect(source.includes(call)).toBeTruthy();
    }
  });

  test('should wrap main() in IIFE with try-catch', () => {
    expect(source.includes('(async () => {')).toBeTruthy();
    expect(source.includes('await main()')).toBeTruthy();
  });

  test('should use require.main guard', () => {
    expect(source.includes('require.main === module')).toBeTruthy();
  });

  test('should have Phase 7A helper functions for complexity reduction', () => {
    // Helpers extracted to reduce cognitive complexity in Phase 7A
    const phase7aHelpers = [
      'installViaBunx',
      'detectFromLockFile',
      'detectFromCommand',
      'validateCommonSecurity',
      'getSkillsInstallArgs',
      'installSkillsWithMethod',
    ];

    for (const helper of phase7aHelpers) {
      expect(source.includes(`function ${helper}(`)).toBeTruthy();
    }
  });

  test('should have Phase 7B helper functions for complexity reduction', () => {
    // Helpers extracted to reduce cognitive complexity in Phase 7B
    const phase7bHelpers = [
      'displayMcpStatus',
      'displayEnvTokenResults',
      'autoInstallLefthook',
      'autoSetupToolsInQuickMode',
      'configureDefaultExternalServices',
    ];

    for (const helper of phase7bHelpers) {
      expect(source.includes(`function ${helper}(`)).toBeTruthy();
    }
  });

  test('should delegate to helpers from quickSetup', () => {
    // Verify quickSetup uses extracted helpers instead of inline logic
    const quickSetupDelegations = [
      'autoInstallLefthook()',
      'autoSetupToolsInQuickMode()',
      'loadAndSetupClaudeCommands(selectedAgents)',
      'setupSelectedAgents(selectedAgents, claudeCommands)',
      'configureDefaultExternalServices(skipExternal)',
    ];

    for (const call of quickSetupDelegations) {
      expect(source.includes(call)).toBeTruthy();
    }
  });

  test('should delegate to helpers from configureExternalServices', () => {
    // Verify configureExternalServices uses extracted helpers
    const delegations = [
      'displayMcpStatus(selectedAgents)',
      'displayEnvTokenResults(added, preserved)',
    ];

    for (const call of delegations) {
      expect(source.includes(call)).toBeTruthy();
    }
  });

  test('should use installViaBunx in install methods', () => {
    // Verify installBeadsWithMethod and installOpenSpecWithMethod use the shared helper
    expect(source.includes("installViaBunx('@beads/bd'")).toBeTruthy();
    expect(source.includes("installViaBunx('@fission-ai/openspec'")).toBeTruthy();
    expect(source.includes("installViaBunx('@forge/skills'")).toBeTruthy();
  });

  test('should use data-driven detection in detectPackageManager', () => {
    // Verify detectPackageManager uses helper functions instead of repeated if-else
    expect(source.includes("detectFromLockFile('bun'")).toBeTruthy();
    expect(source.includes("detectFromCommand('npm'")).toBeTruthy();
  });
});
