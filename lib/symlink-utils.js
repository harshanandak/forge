/**
 * Symlink utilities for Forge setup.
 *
 * Creates CLAUDE.md (or other agent link files) as a symlink to AGENTS.md,
 * with an automatic fallback to copy when symlinks are not available
 * (e.g., Windows without admin privileges).
 *
 * @module symlink-utils
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Header comment prepended to copies when symlink creation fails.
 * Alerts users that the file is a copy and how to create a proper symlink.
 */
const HEADER_COMMENT =
  '<!-- This file is a copy of AGENTS.md. Keep in sync manually or use: bunx forge setup --symlink -->';

/**
 * Create a symlink from `linkPath` pointing to `target`.
 * If symlink creation fails (e.g., EPERM on Windows without admin),
 * falls back to a file copy with a header comment.
 *
 * @param {string} target   - Absolute path to the source file (e.g., AGENTS.md)
 * @param {string} linkPath - Absolute path for the symlink/copy (e.g., CLAUDE.md)
 * @returns {'linked'|'copied'|''} Result indicator
 */
function createSymlinkOrCopy(target, linkPath) {
  try {
    // Ensure target exists
    if (!fs.existsSync(target)) {
      console.error(`  ✗ Source file does not exist: ${target}`);
      return '';
    }

    // Remove existing file/symlink at linkPath
    if (fs.existsSync(linkPath)) {
      const stat = fs.lstatSync(linkPath);
      if (stat.isDirectory()) {
        console.warn(
          `  ⚠ Skipped ${linkPath} (a directory exists at this path). Remove it manually and re-run setup.`
        );
        return '';
      }
      fs.unlinkSync(linkPath);
    }

    // Ensure parent directory exists
    const linkDir = path.dirname(linkPath);
    if (!fs.existsSync(linkDir)) {
      fs.mkdirSync(linkDir, { recursive: true });
    }

    // Attempt symlink (relative path for portability)
    try {
      const relPath = path.relative(linkDir, target);
      fs.symlinkSync(relPath, linkPath);
      return 'linked';
    } catch (_symlinkErr) {
      // Symlink failed (EPERM on Windows, etc.) — fall back to copy with header
      const content = fs.readFileSync(target, 'utf-8');
      fs.writeFileSync(linkPath, HEADER_COMMENT + '\n' + content, 'utf-8');
      return 'copied';
    }
  } catch (err) {
    console.error(`  ✗ Failed to link/copy ${target} -> ${linkPath}: ${err.message}`);
    return '';
  }
}

module.exports = { createSymlinkOrCopy, HEADER_COMMENT };
