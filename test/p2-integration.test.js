/**
 * P2 Integration Tests
 *
 * End-to-end verification that all 4 P2 bug fixes work together:
 * - forge-8u6q: Remove dead code review tool constants
 * - forge-zs2u: Replace npx --yes with package manager detection in lint.js
 * - forge-iv1p: Remove postinstall, add runtime setup guard
 * - forge-cpnj: Wire executeSetup with loadAndSetupClaudeCommands
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Read a file relative to the project root.
 * @param {string} relPath - Relative path from project root
 * @returns {string} File contents
 */
function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('P2 bug fixes integration', () => {
  /** @type {string} */
  let forgeSource;
  /** @type {string} */
  let lintSource;
  /** @type {object} */
  let packageJsonScripts;

  beforeAll(() => {
    forgeSource = readFile('bin/forge.js');
    lintSource = readFile('scripts/lint.js');
    const pkg = JSON.parse(readFile('package.json'));
    packageJsonScripts = pkg.scripts || {};
  });

  // forge-8u6q: dead code removal
  test('bin/forge.js has no _CODE_REVIEW_TOOLS constant', () => {
    expect(forgeSource).not.toMatch(/_CODE_REVIEW_TOOLS/);
  });

  test('bin/forge.js has no _CODE_QUALITY_TOOLS constant', () => {
    expect(forgeSource).not.toMatch(/_CODE_QUALITY_TOOLS/);
  });

  // forge-zs2u: lint.js uses package manager detection instead of npx --yes
  test('scripts/lint.js does not use npx --yes', () => {
    expect(lintSource).not.toMatch(/npx --yes/);
  });

  test('scripts/lint.js contains detectPackageManager function', () => {
    expect(lintSource).toMatch(/function detectPackageManager/);
  });

  // forge-iv1p: no postinstall, runtime setup guard instead
  test('package.json has no postinstall script', () => {
    expect(packageJsonScripts).not.toHaveProperty('postinstall');
  });

  test('bin/forge.js contains FORGE_SETUP_REQUIRED guard', () => {
    expect(forgeSource).toMatch(/FORGE_SETUP_REQUIRED/);
  });

  test('bin/forge.js contains --yes flag handling', () => {
    expect(forgeSource).toMatch(/--yes/);
  });

  // forge-cpnj: executeSetup wired with loadAndSetupClaudeCommands
  test('bin/forge.js contains executeSetup function', () => {
    expect(forgeSource).toMatch(/function executeSetup/);
  });

  test('bin/forge.js uses loadAndSetupClaudeCommands in executeSetup context', () => {
    // Extract the executeSetup function body and verify it references loadAndSetupClaudeCommands
    const execSetupMatch = forgeSource.match(
      /function executeSetup[\s\S]*?(?=\n(?:async )?function |module\.exports|\n\/\*\*\n)/
    );
    expect(execSetupMatch).not.toBeNull();
    expect(execSetupMatch[0]).toMatch(/loadAndSetupClaudeCommands/);
  });
});
