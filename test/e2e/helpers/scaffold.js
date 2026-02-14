const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Create a temporary project directory for E2E testing
 * @param {string} projectName - Name of the test project
 * @returns {Promise<string>} - Path to the created temp directory
 */
async function createTempProject(projectName) {
  const tempDir = path.join(os.tmpdir(), `forge-e2e-${projectName}-${Date.now()}`);

  // Create directory
  fs.mkdirSync(tempDir, { recursive: true });

  // Create minimal package.json
  const packageJson = {
    name: projectName,
    version: '1.0.0',
    private: true,
    description: `E2E test project for ${projectName}`,
  };

  fs.writeFileSync(
    path.join(tempDir, 'package.json'),
    JSON.stringify(packageJson, null, 2),
    'utf-8'
  );

  return tempDir;
}

/**
 * Copy a fixture directory to the temp project
 * @param {string} fixtureName - Name of the fixture (e.g., 'empty-project')
 * @param {string} targetDir - Target directory to copy to
 * @returns {Promise<void>}
 */
async function copyFixture(fixtureName, targetDir) {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  const fixturePath = path.join(fixturesDir, fixtureName);

  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${fixtureName}`);
  }

  // Copy fixture contents to target directory
  copyRecursive(fixturePath, targetDir);
}

/**
 * Recursively copy directory contents
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 */
function copyRecursive(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

module.exports = {
  createTempProject,
  copyFixture,
};
