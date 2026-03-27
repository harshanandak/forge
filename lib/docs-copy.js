const fs = require('node:fs');
const path = require('node:path');

/**
 * Essential docs to copy from package's docs/ to consumer's docs/forge/
 */
const ESSENTIAL_DOCS = ['TOOLCHAIN.md', 'VALIDATION.md'];

/**
 * Copy essential documentation files from the Forge package to the consumer project.
 * Creates docs/forge/ if missing. Skips files that already exist (idempotent).
 *
 * @param {string} projectRoot - Target project root directory
 * @param {string} packageDir - Forge package directory (source of docs)
 * @returns {{ created: string[], skipped: string[] }}
 */
function copyEssentialDocs(projectRoot, packageDir) {
  const created = [];
  const skipped = [];

  const targetDir = path.join(projectRoot, 'docs', 'forge');

  for (const docFile of ESSENTIAL_DOCS) {
    const srcPath = path.join(packageDir, 'docs', docFile);
    const destPath = path.join(targetDir, docFile);
    const relPath = ['docs', 'forge', docFile].join('/');

    // Skip if source doesn't exist
    if (!fs.existsSync(srcPath)) {
      continue;
    }

    // Skip if destination already exists (preserve user customizations)
    if (fs.existsSync(destPath)) {
      skipped.push(relPath);
      continue;
    }

    // Ensure target directory exists
    fs.mkdirSync(targetDir, { recursive: true });

    // Copy file
    fs.copyFileSync(srcPath, destPath);
    created.push(relPath);
  }

  return { created, skipped };
}

module.exports = { copyEssentialDocs, ESSENTIAL_DOCS };
