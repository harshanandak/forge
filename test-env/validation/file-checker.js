// File Checker Validation Helper
// Validates file existence, content, and symlinks

const fs = require('node:fs');
const path = require('node:path');

/**
 * Validate a single file against checks
 * @param {string} filePath - Path to file
 * @param {Object} checks - Validation checks { mustExist, notEmpty, minSize }
 * @returns {Object} { passed, failures, coverage }
 */
function validateFile(filePath, checks = {}) {
  const failures = [];
  let totalChecks = 0;
  let passedChecks = 0;

  // Check: File must exist
  if (checks.mustExist) {
    totalChecks++;
    if (!fs.existsSync(filePath)) {
      failures.push({
        path: filePath,
        reason: `File does not exist: ${filePath}`
      });
    } else {
      passedChecks++;
    }
  }

  // Only run further checks if file exists
  if (fs.existsSync(filePath)) {
    // Check: File must not be empty
    if (checks.notEmpty) {
      totalChecks++;
      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        failures.push({
          path: filePath,
          reason: `File is empty: ${filePath}`
        });
      } else {
        passedChecks++;
      }
    }

    // Check: File must meet minimum size
    if (checks.minSize) {
      totalChecks++;
      const stats = fs.statSync(filePath);
      if (stats.size < checks.minSize) {
        failures.push({
          path: filePath,
          reason: `File is smaller than minimum size (${stats.size} < ${checks.minSize}): ${filePath}`
        });
      } else {
        passedChecks++;
      }
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    coverage: totalChecks > 0 ? passedChecks / totalChecks : 0
  };
}

/**
 * Check if symlink exists and points to correct target
 * @param {string} linkPath - Path to symlink
 * @param {string} expectedTarget - Expected target path
 * @returns {Object} { passed, failures, coverage }
 */
function checkSymlink(linkPath, expectedTarget) {
  const failures = [];

  // Check if symlink exists
  if (!fs.existsSync(linkPath)) {
    return {
      passed: false,
      failures: [{
        path: linkPath,
        reason: `Symlink does not exist: ${linkPath}`
      }],
      coverage: 0
    };
  }

  // Check if it's actually a symlink (or at least a file)
  try {
    const stats = fs.lstatSync(linkPath);

    if (stats.isSymbolicLink()) {
      // Verify symlink target
      const actualTarget = fs.readlinkSync(linkPath);
      const resolvedExpected = path.resolve(path.dirname(linkPath), expectedTarget);
      const resolvedActual = path.resolve(path.dirname(linkPath), actualTarget);

      if (resolvedActual !== resolvedExpected) {
        failures.push({
          path: linkPath,
          reason: `Symlink points to wrong target. Expected: ${resolvedExpected}, Actual: ${resolvedActual}`
        });
      }
    } else {
      // On Windows, symlinks might be copies instead
      // Accept this as valid if the file exists
      if (!fs.existsSync(linkPath)) {
        failures.push({
          path: linkPath,
          reason: `File exists but is not a symlink and target doesn't exist`
        });
      }
    }
  } catch (err) {
    failures.push({
      path: linkPath,
      reason: `Error checking symlink: ${err.message}`
    });
  }

  return {
    passed: failures.length === 0,
    failures,
    coverage: failures.length === 0 ? 1 : 0
  };
}

/**
 * Get expected files for an agent
 * @param {string} agent - Agent ID (claude, cursor, etc.)
 * @returns {Array} List of expected file paths with checks
 */
function getExpectedFiles(agent) {
  // Load plugin definitions to get expected files
  const PluginManager = require('../../lib/plugin-manager.js');
  const pluginManager = new PluginManager();
  const plugin = pluginManager.getPlugin(agent);

  if (!plugin) {
    return [];
  }

  const expectedFiles = [];

  // Common files for all agents
  expectedFiles.push({
    path: 'AGENTS.md',
    checks: { mustExist: true, notEmpty: true, minSize: 10 }
  });

  // Agent-specific files based on plugin configuration
  if (plugin.files?.rootConfig) {
    expectedFiles.push({
      path: plugin.files.rootConfig,
      checks: { mustExist: true }
    });
  }

  // Command files (if agent supports commands)
  if (plugin.capabilities?.commands || plugin.setup?.copyCommands) {
    const commandsDir = Object.values(plugin.directories).find(dir => dir.includes('commands'));
    if (commandsDir) {
      const commands = ['status', 'plan', 'dev'];
      commands.forEach(cmd => {
        expectedFiles.push({
          path: path.join(commandsDir, `${cmd}.md`),
          checks: { mustExist: true, notEmpty: true }
        });
      });
    }
  }

  return expectedFiles;
}

/**
 * Validate complete agent installation
 * @param {string} agent - Agent ID (claude, cursor, etc.)
 * @param {string} directory - Directory to check
 * @returns {Object} { passed, failures, coverage }
 */
function validateInstallation(agent, directory) {
  const expectedFiles = getExpectedFiles(agent);
  const failures = [];
  let totalFiles = expectedFiles.length;
  let validatedFiles = 0;

  if (totalFiles === 0) {
    // Unknown agent or no expected files
    return {
      passed: false,
      failures: [{
        file: agent,
        reason: `Unknown agent or no expected files defined: ${agent}`
      }],
      coverage: 0
    };
  }

  for (const fileSpec of expectedFiles) {
    const filePath = path.join(directory, fileSpec.path);
    const result = validateFile(filePath, fileSpec.checks);

    if (!result.passed) {
      failures.push(...result.failures);
    } else {
      validatedFiles++;
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    coverage: totalFiles > 0 ? validatedFiles / totalFiles : 0
  };
}

module.exports = {
  validateFile,
  checkSymlink,
  validateInstallation
};
