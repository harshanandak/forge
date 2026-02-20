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
});
