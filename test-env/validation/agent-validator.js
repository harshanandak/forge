// Agent Validator Helper
// Validates agent configurations for all 11 supported agents

const path = require('node:path');
const { validateFile } = require('./file-checker.js');

// Import PluginManager to get agent definitions
const PluginManager = require('../../lib/plugin-manager.js');

/**
 * Validate an agent installation
 * @param {string} agent - Agent ID (e.g., 'claude', 'cursor')
 * @param {string} directory - Directory to validate
 * @returns {{passed: boolean, failures: Array, coverage: number}}
 */
function validateAgent(agent, directory) {
  const expectedFiles = getExpectedFiles(agent);

  if (expectedFiles.length === 0) {
    return {
      passed: false,
      failures: [{ path: agent, reason: 'Unknown agent or no expected files defined' }],
      coverage: 0
    };
  }

  const failures = [];
  let checksPerformed = 0;
  let checksPassed = 0;

  for (const fileSpec of expectedFiles) {
    checksPerformed++;
    const filePath = path.join(directory, fileSpec.path);

    // Use file-checker's validateFile function
    const result = validateFile(filePath, fileSpec.checks || { mustExist: true });

    if (!result.passed) {
      failures.push(...result.failures);
    } else {
      checksPassed++;
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    coverage: checksPerformed > 0 ? checksPassed / checksPerformed : 0
  };
}

/**
 * Get expected files for an agent based on plugin definition
 * @param {string} agentId - Agent ID
 * @returns {Array<{path: string, checks: object}>}
 */
function getExpectedFiles(agentId) {
  try {
    const pluginManager = new PluginManager();
    const plugin = pluginManager.getPlugin(agentId);

    if (!plugin) {
      return [];
    }

    const files = [];

    // Add root config file (e.g., CLAUDE.md, CURSOR.md)
    if (plugin.files && plugin.files.rootConfig) {
      files.push({
        path: plugin.files.rootConfig,
        checks: { mustExist: true, notEmpty: true }
      });
    }

    // Add agent-specific directory files (e.g., .claude/commands/)
    if (plugin.directories && typeof plugin.directories === 'object') {
      for (const [dirType, dirPath] of Object.entries(plugin.directories)) {
        // Check if directory exists
        files.push({
          path: dirPath,
          checks: { mustExist: true }
        });
      }
    }

    return files;
  } catch (error) {
    // If PluginManager fails, return empty array
    console.warn(`Failed to load plugin for ${agentId}:`, error.message);
    return [];
  }
}

module.exports = {
  validateAgent,
  getExpectedFiles
};
