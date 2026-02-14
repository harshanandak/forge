const fs = require('node:fs');

/**
 * Clean up a temporary project directory after E2E testing
 * @param {string} tempDir - Path to the temp directory to remove
 * @returns {Promise<void>}
 */
async function cleanupTempProject(tempDir) {
  if (!tempDir) {
    return;
  }

  // Safety check: only clean up directories in system temp
  if (!tempDir.includes('forge-e2e-') && !tempDir.includes('forge-test-') && !tempDir.includes('non-existent-')) {
    throw new Error(`Refusing to delete directory that doesn't look like a temp project: ${tempDir}`);
  }

  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    // Ignore errors (directory might already be deleted or locked)
    console.warn(`Warning: Failed to clean up ${tempDir}:`, error.message);
  }
}

module.exports = {
  cleanupTempProject,
};
