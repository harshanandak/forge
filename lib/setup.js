const fs = require('node:fs');
const path = require('node:path');

/**
 * Save setup state to .forge/setup-state.json
 * @param {string} projectPath - Path to the project root
 * @param {Object} state - Setup state object
 * @param {string} state.version - Forge version
 * @param {string[]} state.completed_steps - List of completed steps
 * @param {string[]} state.pending_steps - List of pending steps
 * @param {string} [state.last_run] - ISO timestamp of last run
 * @returns {Promise<void>}
 */
async function saveSetupState(projectPath, state) {
  const forgeDir = path.join(projectPath, '.forge');
  const setupStatePath = path.join(forgeDir, 'setup-state.json');

  // Ensure .forge directory exists
  await fs.promises.mkdir(forgeDir, { recursive: true });

  // Add last_run timestamp if not provided
  if (!state.last_run) {
    state.last_run = new Date().toISOString();
  }

  // Write state as JSON
  await fs.promises.writeFile(setupStatePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Load setup state from .forge/setup-state.json
 * @param {string} projectPath - Path to the project root
 * @returns {Promise<Object|null>} Setup state object, or null if not found or invalid
 */
async function loadSetupState(projectPath) {
  const setupStatePath = path.join(projectPath, '.forge', 'setup-state.json');

  try {
    const content = await fs.promises.readFile(setupStatePath, 'utf-8');
    return JSON.parse(content);
  } catch (_error) {
    // File doesn't exist or invalid JSON
    return null;
  }
}

/**
 * Check if setup is complete (no pending steps)
 * @param {string} projectPath - Path to the project root
 * @returns {Promise<boolean>} True if setup complete, false otherwise
 */
async function isSetupComplete(projectPath) {
  const state = await loadSetupState(projectPath);

  if (!state) {
    return false;
  }

  // Setup is complete if pending_steps is empty
  return state.pending_steps.length === 0;
}

/**
 * Get the next pending step
 * @param {string} projectPath - Path to the project root
 * @returns {Promise<string|null>} Next step name, or null if none
 */
async function getNextStep(projectPath) {
  const state = await loadSetupState(projectPath);

  if (!state || !state.pending_steps || state.pending_steps.length === 0) {
    return null;
  }

  // Return first pending step
  return state.pending_steps[0];
}

/**
 * Mark a step as complete (move from pending to completed)
 * @param {string} projectPath - Path to the project root
 * @param {string} stepName - Name of the step to mark complete
 * @returns {Promise<void>}
 */
async function markStepComplete(projectPath, stepName) {
  let state = await loadSetupState(projectPath);

  // If no state exists, create initial state
  if (!state) {
    state = {
      version: '1.6.0',
      completed_steps: [],
      pending_steps: []
    };
  }

  // Remove from pending_steps if present
  state.pending_steps = state.pending_steps.filter(step => step !== stepName);

  // Add to completed_steps if not already there
  if (!state.completed_steps.includes(stepName)) {
    state.completed_steps.push(stepName);
  }

  // Update last_run timestamp
  state.last_run = new Date().toISOString();

  // Save updated state
  await saveSetupState(projectPath, state);
}

module.exports = {
  saveSetupState,
  loadSetupState,
  isSetupComplete,
  getNextStep,
  markStepComplete
};
