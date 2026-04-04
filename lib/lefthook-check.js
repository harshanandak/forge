/**
 * Lefthook prerequisite check — verifies both package.json entry and binary existence.
 * @module lib/lefthook-check
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Check whether lefthook is declared in package.json AND whether the binary
 * is actually available in node_modules/.bin.
 *
 * @param {string} projectRoot - Absolute path to the project root directory.
 * @returns {{ installed: boolean, binaryAvailable: boolean, state: string, message: string }}
 *   - installed: true if lefthook appears in dependencies or devDependencies
 *   - binaryAvailable: true if the lefthook binary exists in node_modules/.bin
 *   - state: explicit installation state for runtime health checks
 *   - message: actionable guidance when something is missing, empty string when OK
 */
function checkLefthookStatus(projectRoot) {
  const root = typeof projectRoot === 'string' && projectRoot.trim()
    ? projectRoot
    : process.cwd();
  const pkgPath = path.join(root, 'package.json');

  // No package.json — nothing to report
  if (!fs.existsSync(pkgPath)) {
    return {
      installed: false,
      binaryAvailable: false,
      state: 'missing-package',
      message: ''
    };
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (_err) {
    // Expected: package.json may contain invalid JSON — treat as absent
    return {
      installed: false,
      binaryAvailable: false,
      state: 'missing-package',
      message: ''
    };
  }

  const installed = Boolean(
    pkg.devDependencies?.lefthook || pkg.dependencies?.lefthook
  );

  if (!installed) {
    return {
      installed: false,
      binaryAvailable: false,
      state: 'missing-dependency',
      message: 'lefthook not found. Run: bun add -D lefthook && bun install',
    };
  }

  // Check for the binary in node_modules/.bin
  const binDir = path.join(root, 'node_modules', '.bin');
  const binaryAvailable =
    fs.existsSync(path.join(binDir, 'lefthook')) ||
    fs.existsSync(path.join(binDir, 'lefthook.cmd'));

  if (!binaryAvailable) {
    return {
      installed: true,
      binaryAvailable: false,
      state: 'missing-binary',
      message:
        'lefthook is in package.json but not installed. Run: bun install',
    };
  }

  return {
    installed: true,
    binaryAvailable: true,
    state: 'installed',
    message: ''
  };
}

module.exports = { checkLefthookStatus };
