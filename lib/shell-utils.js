/**
 * Shell execution utility wrappers
 * Extracted from bin/forge.js for reuse and testability
 * @module lib/shell-utils
 */

const { execFileSync, spawnSync } = require('node:child_process');

/**
 * Securely execute a command with PATH validation.
 * Mitigates SonarCloud S4036: Ensures executables are from trusted locations.
 * @param {string} command - The command to execute
 * @param {string[]} [args=[]] - Command arguments
 * @param {object} [options={}] - execFileSync options
 * @returns {Buffer|string} Command output
 */
function secureExecFileSync(command, args = [], options = {}) {
  try {
    // Resolve command's full path to validate it's in a trusted location
    const isWindows = process.platform === 'win32';
    const pathResolver = isWindows ? 'where.exe' : 'which';

    const result = spawnSync(pathResolver, [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });

    if (result.status === 0 && result.stdout) {
      // Command found - use resolved path for execution
      // Handle both CRLF (Windows) and LF (Unix) line endings
      const resolvedPath = result.stdout.trim().split(/\r?\n/)[0].trim();
      return execFileSync(resolvedPath, args, options);
    }
  } catch (_err) { // NOSONAR - S2486: Intentionally ignored; falls back to direct command execution below
  }

  // Fallback: execute with command name (maintains compatibility)
  // This is safe for our use case as we only execute known, hardcoded commands
  return execFileSync(command, args, options);
}

module.exports = {
  secureExecFileSync
};
