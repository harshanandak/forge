/**
 * Lefthook prerequisite check — verifies both package.json entry and binary existence.
 * @module lib/lefthook-check
 */

const fs = require('fs');
const path = require('path');

/**
 * Check whether lefthook is declared in package.json AND whether the binary
 * is actually available in node_modules/.bin.
 *
 * @param {string} projectRoot - Absolute path to the project root directory.
 * @returns {{ installed: boolean, binaryAvailable: boolean, message: string }}
 *   - installed: true if lefthook appears in dependencies or devDependencies
 *   - binaryAvailable: true if the lefthook binary exists in node_modules/.bin
 *   - message: actionable guidance when something is missing, empty string when OK
 */
function checkLefthookStatus(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');

  // No package.json — nothing to report
  if (!fs.existsSync(pkgPath)) {
    return { installed: false, binaryAvailable: false, message: '' };
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (_err) {
    // Malformed package.json — treat as absent
    return { installed: false, binaryAvailable: false, message: '' };
  }

  const installed = Boolean(
    pkg.devDependencies?.lefthook || pkg.dependencies?.lefthook
  );

  if (!installed) {
    return {
      installed: false,
      binaryAvailable: false,
      message: 'lefthook not found. Run: bun add -D lefthook && bun install',
    };
  }

  // Check for the binary in node_modules/.bin
  const binDir = path.join(projectRoot, 'node_modules', '.bin');
  const binaryAvailable =
    fs.existsSync(path.join(binDir, 'lefthook')) ||
    fs.existsSync(path.join(binDir, 'lefthook.cmd'));

  if (!binaryAvailable) {
    return {
      installed: true,
      binaryAvailable: false,
      message:
        'lefthook is in package.json but not installed. Run: bun install',
    };
  }

  return { installed: true, binaryAvailable: true, message: '' };
}

module.exports = { checkLefthookStatus };
