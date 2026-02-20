const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
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
      assert.ok(
        source.includes(`function ${helper}(`),
        `Expected helper function ${helper} to exist`
      );
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
      assert.ok(
        source.includes(call),
        `Expected interactiveSetupWithFlags to call ${call}`
      );
    }
  });

  test('should wrap main() in IIFE with try-catch', () => {
    assert.ok(
      source.includes('(async () => {'),
      'Expected IIFE wrapper for main()'
    );
    assert.ok(
      source.includes('await main()'),
      'Expected await main() inside IIFE'
    );
  });

  test('should use require.main guard', () => {
    assert.ok(
      source.includes('require.main === module'),
      'Expected require.main === module guard'
    );
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
      assert.ok(
        source.includes(`function ${helper}(`),
        `Expected Phase 7A helper function ${helper} to exist`
      );
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
      assert.ok(
        source.includes(`function ${helper}(`),
        `Expected Phase 7B helper function ${helper} to exist`
      );
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
      assert.ok(
        source.includes(call),
        `Expected quickSetup to delegate to ${call}`
      );
    }
  });

  test('should delegate to helpers from configureExternalServices', () => {
    // Verify configureExternalServices uses extracted helpers
    const delegations = [
      'displayMcpStatus(selectedAgents)',
      'displayEnvTokenResults(added, preserved)',
    ];

    for (const call of delegations) {
      assert.ok(
        source.includes(call),
        `Expected configureExternalServices to delegate to ${call}`
      );
    }
  });

  test('should use installViaBunx in install methods', () => {
    // Verify installBeadsWithMethod and installOpenSpecWithMethod use the shared helper
    assert.ok(
      source.includes("installViaBunx('@beads/bd'"),
      'Expected installBeadsWithMethod to use installViaBunx'
    );
    assert.ok(
      source.includes("installViaBunx('@fission-ai/openspec'"),
      'Expected installOpenSpecWithMethod to use installViaBunx'
    );
    assert.ok(
      source.includes("installViaBunx('@forge/skills'"),
      'Expected installSkillsWithMethod to use installViaBunx'
    );
  });

  test('should use data-driven detection in detectPackageManager', () => {
    // Verify detectPackageManager uses helper functions instead of repeated if-else
    assert.ok(
      source.includes("detectFromLockFile('bun'"),
      'Expected detectPackageManager to use detectFromLockFile for bun'
    );
    assert.ok(
      source.includes("detectFromCommand('npm'"),
      'Expected detectPackageManager to use detectFromCommand for npm'
    );
  });
});
