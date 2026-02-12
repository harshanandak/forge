const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

// Module under test
const { saveSetupState, loadSetupState, isSetupComplete, getNextStep, markStepComplete } = require('../lib/setup');

describe('Setup resumability', () => {
  let tempDir;
  let forgeDir;
  let setupStatePath;

  beforeEach(async () => {
    // Create temporary directory for testing
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-test-'));
    forgeDir = path.join(tempDir, '.forge');
    setupStatePath = path.join(forgeDir, 'setup-state.json');
  });

  afterEach(async () => {
    // Cleanup temporary directory
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('saveSetupState', () => {
    test('should create .forge/setup-state.json file', async () => {
      const state = {
        version: '1.6.0',
        completed_steps: ['detect_project'],
        pending_steps: ['create_agents_md', 'setup_lefthook'],
        last_run: new Date().toISOString()
      };

      await saveSetupState(tempDir, state);

      const exists = await fs.promises.access(setupStatePath).then(() => true).catch(() => false);
      assert.ok(exists, '.forge/setup-state.json should be created');
    });

    test('should save state as valid JSON', async () => {
      const state = {
        version: '1.6.0',
        completed_steps: ['detect_project', 'create_agents_md'],
        pending_steps: ['setup_lefthook'],
        last_run: new Date().toISOString()
      };

      await saveSetupState(tempDir, state);

      const content = await fs.promises.readFile(setupStatePath, 'utf-8');
      const parsed = JSON.parse(content);

      assert.deepStrictEqual(parsed, state);
    });

    test('should create .forge directory if it does not exist', async () => {
      // Ensure .forge doesn't exist
      const forgeDirExists = fs.existsSync(forgeDir);
      assert.ok(!forgeDirExists, '.forge should not exist initially');

      const state = { version: '1.6.0', completed_steps: [], pending_steps: [] };
      await saveSetupState(tempDir, state);

      // Check .forge was created
      assert.ok(fs.existsSync(forgeDir), '.forge directory should be created');
    });

    test('should overwrite existing state', async () => {
      // Create initial state
      const initialState = {
        version: '1.6.0',
        completed_steps: ['detect_project'],
        pending_steps: ['create_agents_md', 'setup_lefthook']
      };
      await saveSetupState(tempDir, initialState);

      // Update state
      const updatedState = {
        version: '1.6.0',
        completed_steps: ['detect_project', 'create_agents_md'],
        pending_steps: ['setup_lefthook']
      };
      await saveSetupState(tempDir, updatedState);

      const content = await fs.promises.readFile(setupStatePath, 'utf-8');
      const parsed = JSON.parse(content);

      assert.strictEqual(parsed.completed_steps.length, 2);
      assert.strictEqual(parsed.pending_steps.length, 1);
    });
  });

  describe('loadSetupState', () => {
    test('should load existing setup state', async () => {
      const state = {
        version: '1.6.0',
        completed_steps: ['detect_project', 'create_agents_md'],
        pending_steps: ['setup_lefthook'],
        last_run: new Date().toISOString()
      };

      // Create state file
      await fs.promises.mkdir(forgeDir, { recursive: true });
      await fs.promises.writeFile(setupStatePath, JSON.stringify(state, null, 2));

      const loaded = await loadSetupState(tempDir);

      assert.deepStrictEqual(loaded, state);
    });

    test('should return null if setup state does not exist', async () => {
      const loaded = await loadSetupState(tempDir);

      assert.strictEqual(loaded, null);
    });

    test('should return null if setup state is invalid JSON', async () => {
      // Create invalid JSON
      await fs.promises.mkdir(forgeDir, { recursive: true });
      await fs.promises.writeFile(setupStatePath, 'invalid json {]');

      const loaded = await loadSetupState(tempDir);

      assert.strictEqual(loaded, null);
    });

    test('should handle missing .forge directory gracefully', async () => {
      // Ensure .forge doesn't exist
      const forgeDirExists = fs.existsSync(forgeDir);
      assert.ok(!forgeDirExists, '.forge should not exist');

      const loaded = await loadSetupState(tempDir);

      assert.strictEqual(loaded, null);
    });
  });

  describe('isSetupComplete', () => {
    test('should return true when all steps completed', async () => {
      const state = {
        version: '1.6.0',
        completed_steps: [
          'detect_project',
          'create_agents_md',
          'setup_lefthook',
          'configure_mcp',
          'setup_branch_protection'
        ],
        pending_steps: []
      };

      await saveSetupState(tempDir, state);

      const complete = await isSetupComplete(tempDir);

      assert.strictEqual(complete, true);
    });

    test('should return false when pending steps remain', async () => {
      const state = {
        version: '1.6.0',
        completed_steps: ['detect_project', 'create_agents_md'],
        pending_steps: ['setup_lefthook', 'configure_mcp']
      };

      await saveSetupState(tempDir, state);

      const complete = await isSetupComplete(tempDir);

      assert.strictEqual(complete, false);
    });

    test('should return false when no state exists', async () => {
      const complete = await isSetupComplete(tempDir);

      assert.strictEqual(complete, false);
    });

    test('should return true when pending_steps is empty array', async () => {
      const state = {
        version: '1.6.0',
        completed_steps: ['detect_project', 'create_agents_md', 'setup_lefthook'],
        pending_steps: []
      };

      await saveSetupState(tempDir, state);

      const complete = await isSetupComplete(tempDir);

      assert.strictEqual(complete, true);
    });
  });

  describe('getNextStep', () => {
    test('should return first pending step', async () => {
      const state = {
        version: '1.6.0',
        completed_steps: ['detect_project'],
        pending_steps: ['create_agents_md', 'setup_lefthook', 'configure_mcp']
      };

      await saveSetupState(tempDir, state);

      const nextStep = await getNextStep(tempDir);

      assert.strictEqual(nextStep, 'create_agents_md');
    });

    test('should return null when no pending steps', async () => {
      const state = {
        version: '1.6.0',
        completed_steps: ['detect_project', 'create_agents_md', 'setup_lefthook'],
        pending_steps: []
      };

      await saveSetupState(tempDir, state);

      const nextStep = await getNextStep(tempDir);

      assert.strictEqual(nextStep, null);
    });

    test('should return null when no state exists', async () => {
      const nextStep = await getNextStep(tempDir);

      assert.strictEqual(nextStep, null);
    });

    test('should handle empty pending_steps array', async () => {
      const state = {
        version: '1.6.0',
        completed_steps: ['detect_project'],
        pending_steps: []
      };

      await saveSetupState(tempDir, state);

      const nextStep = await getNextStep(tempDir);

      assert.strictEqual(nextStep, null);
    });
  });

  describe('markStepComplete', () => {
    test('should move step from pending to completed', async () => {
      const initialState = {
        version: '1.6.0',
        completed_steps: ['detect_project'],
        pending_steps: ['create_agents_md', 'setup_lefthook', 'configure_mcp']
      };

      await saveSetupState(tempDir, initialState);

      await markStepComplete(tempDir, 'create_agents_md');

      const updatedState = await loadSetupState(tempDir);

      assert.ok(updatedState.completed_steps.includes('create_agents_md'));
      assert.ok(!updatedState.pending_steps.includes('create_agents_md'));
      assert.strictEqual(updatedState.completed_steps.length, 2);
      assert.strictEqual(updatedState.pending_steps.length, 2);
    });

    test('should update last_run timestamp', async () => {
      const initialState = {
        version: '1.6.0',
        completed_steps: ['detect_project'],
        pending_steps: ['create_agents_md'],
        last_run: '2025-01-01T00:00:00.000Z'
      };

      await saveSetupState(tempDir, initialState);

      // Wait a bit to ensure timestamp changes
      await new Promise(resolve => setTimeout(resolve, 10));

      await markStepComplete(tempDir, 'create_agents_md');

      const updatedState = await loadSetupState(tempDir);

      assert.notStrictEqual(updatedState.last_run, initialState.last_run);
    });

    test('should handle marking step that is not in pending', async () => {
      const initialState = {
        version: '1.6.0',
        completed_steps: ['detect_project'],
        pending_steps: ['setup_lefthook']
      };

      await saveSetupState(tempDir, initialState);

      // Mark a step that's not in pending
      await markStepComplete(tempDir, 'nonexistent_step');

      const updatedState = await loadSetupState(tempDir);

      // Should add to completed even if not in pending
      assert.ok(updatedState.completed_steps.includes('nonexistent_step'));
    });

    test('should not duplicate step in completed', async () => {
      const initialState = {
        version: '1.6.0',
        completed_steps: ['detect_project'],
        pending_steps: ['create_agents_md']
      };

      await saveSetupState(tempDir, initialState);

      // Mark same step twice
      await markStepComplete(tempDir, 'create_agents_md');
      await markStepComplete(tempDir, 'create_agents_md');

      const updatedState = await loadSetupState(tempDir);

      // Should only appear once in completed
      const count = updatedState.completed_steps.filter(s => s === 'create_agents_md').length;
      assert.strictEqual(count, 1);
    });

    test('should create state file if it does not exist', async () => {
      // No state exists initially
      const exists = fs.existsSync(setupStatePath);
      assert.ok(!exists);

      await markStepComplete(tempDir, 'detect_project');

      const updatedState = await loadSetupState(tempDir);

      assert.ok(updatedState.completed_steps.includes('detect_project'));
    });
  });

  describe('State persistence across operations', () => {
    test('should maintain state across multiple operations', async () => {
      // Step 1: Initialize
      const initialState = {
        version: '1.6.0',
        completed_steps: [],
        pending_steps: ['detect_project', 'create_agents_md', 'setup_lefthook']
      };
      await saveSetupState(tempDir, initialState);

      // Step 2: Mark first step complete
      await markStepComplete(tempDir, 'detect_project');

      // Step 3: Verify state
      let state = await loadSetupState(tempDir);
      assert.strictEqual(state.completed_steps.length, 1);
      assert.strictEqual(state.pending_steps.length, 2);

      // Step 4: Mark second step complete
      await markStepComplete(tempDir, 'create_agents_md');

      // Step 5: Verify final state
      state = await loadSetupState(tempDir);
      assert.strictEqual(state.completed_steps.length, 2);
      assert.strictEqual(state.pending_steps.length, 1);
      assert.ok(!await isSetupComplete(tempDir));

      // Step 6: Complete last step
      await markStepComplete(tempDir, 'setup_lefthook');

      // Step 7: Verify complete
      assert.ok(await isSetupComplete(tempDir));
    });
  });
});
