// Env Validator Helper
// Validates .env.local file format and preservation

const fs = require('node:fs');

/**
 * Validate a .env file format
 * @param {string} filePath - Path to .env file
 * @returns {{passed: boolean, failures: Array, coverage: number}}
 */
function validateEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      passed: false,
      failures: [{ path: filePath, reason: 'File does not exist' }],
      coverage: 0
    };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const _parsed = parseEnvFile(content);

  const failures = [];
  let totalLines = 0;
  let validLines = 0;

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines and comments
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    totalLines++;

    // Check if line has valid KEY=VALUE format
    if (!line.includes('=')) {
      failures.push({
        path: filePath,
        reason: `Line ${i + 1}: Invalid format (missing '='): ${line}`
      });
    } else {
      const [key] = line.split('=');
      if (!key.trim()) {
        failures.push({
          path: filePath,
          reason: `Line ${i + 1}: Empty key before '='`
        });
      } else {
        validLines++;
      }
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    coverage: totalLines > 0 ? validLines / totalLines : 1
  };
}

/**
 * Parse .env file content
 * @param {string} content - File content
 * @returns {{variables: object, comments: string[], raw: string}}
 */
function parseEnvFile(content) {
  const variables = {};
  const comments = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (trimmed === '') {
      continue;
    }

    // Collect comments
    if (trimmed.startsWith('#')) {
      comments.push(trimmed);
      continue;
    }

    // Parse KEY=VALUE
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex > 0) {
      const key = trimmed.substring(0, equalsIndex).trim();
      let value = trimmed.substring(equalsIndex + 1).trim();

      // Strip quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      variables[key] = value;
    }
  }

  return {
    variables,
    comments,
    raw: content
  };
}

/**
 * Check if old variables are preserved in new content
 * @param {string} oldContent - Original content
 * @param {string} newContent - New content
 * @returns {{passed: boolean, failures: Array, coverage: number}}
 */
function checkPreservation(oldContent, newContent) {
  const oldParsed = parseEnvFile(oldContent);
  const newParsed = parseEnvFile(newContent);

  const failures = [];
  let checksPerformed = 0;
  let checksPassed = 0;

  // Check each old variable
  for (const [key, oldValue] of Object.entries(oldParsed.variables)) {
    checksPerformed++;

    if (!(key in newParsed.variables)) {
      // Variable was removed
      failures.push({
        path: key,
        reason: `Variable '${key}' was removed`
      });
    } else if (newParsed.variables[key] !== oldValue) {
      // Variable value changed
      failures.push({
        path: key,
        reason: `Variable '${key}' value changed from '${oldValue}' to '${newParsed.variables[key]}'`
      });
    } else {
      checksPassed++;
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    coverage: checksPerformed > 0 ? checksPassed / checksPerformed : 1
  };
}

module.exports = {
  validateEnvFile,
  parseEnvFile,
  checkPreservation
};
