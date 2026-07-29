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

const SYMLINK_FALLBACK_ERRORS = new Set(['EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM']);

function inspectExistingDestination(target, linkPath) {
  let stat;
  try {
    stat = fs.lstatSync(linkPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  if (stat.isSymbolicLink()) {
    let linkedTarget;
    try {
      linkedTarget = fs.readlinkSync(linkPath);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    if (path.resolve(path.dirname(linkPath), linkedTarget) === path.resolve(target)) {
      return 'linked';
    }
  }
  if (stat.isDirectory()) {
    console.warn(`  Warning: Skipped ${linkPath} because it is a directory. Remove it manually and re-run setup.`);
    return '';
  }
  if (stat.isFile() && fs.readFileSync(linkPath, 'utf8').trim() === '@AGENTS.md') {
    return 'existing-import';
  }
  console.warn(`  Warning: Skipped ${linkPath} because an existing destination must be preserved.`);
  return '';
}

/**
 * Create a symlink from `linkPath` pointing to `target`.
 * If symlink creation fails (e.g., EPERM on Windows without admin),
 * falls back to a file copy with a header comment — unless `symlinkOnly`
 * is true, in which case it reports the error and returns ''.
 *
 * @param {string} target   - Absolute path to the source file (e.g., AGENTS.md)
 * @param {string} linkPath - Absolute path for the symlink/copy (e.g., CLAUDE.md)
 * @param {Object} [options={}] - Options
 * @param {boolean} [options.symlinkOnly=false] - When true, skip copy fallback (--symlink flag)
 * @returns {'linked'|'copied'|'existing-import'|''} Result indicator
 */
function createSymlinkOrCopy(target, linkPath, options = {}) {
  try {
    // Ensure target exists
    if (!fs.existsSync(target)) {
      console.error(`  ✗ Source file does not exist: ${target}`);
      return '';
    }

    // Existing agent files belong to the user. lstat also sees dangling links.
    const existing = inspectExistingDestination(target, linkPath);
    if (existing !== null) return existing;

    // Ensure parent directory exists
    const linkDir = path.dirname(linkPath);
    if (!fs.existsSync(linkDir)) {
      fs.mkdirSync(linkDir, { recursive: true });
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Attempt symlink (relative path for portability)
      try {
        const relPath = path.relative(linkDir, target);
        fs.symlinkSync(relPath, linkPath);
        return 'linked';
      } catch (symlinkErr) {
        if (symlinkErr.code === 'EEXIST') {
          const racedExisting = inspectExistingDestination(target, linkPath);
          if (racedExisting !== null) return racedExisting;
          continue;
        }
        if (!SYMLINK_FALLBACK_ERRORS.has(symlinkErr.code)) {
          throw symlinkErr;
        }
        if (options.symlinkOnly) {
          console.warn(`  ⚠ Symlink failed for ${linkPath} (--symlink requires symlink support)`);
          return '';
        }
        const content = fs.readFileSync(target, 'utf-8');
        try {
          fs.writeFileSync(linkPath, HEADER_COMMENT + '\n' + content, {
            encoding: 'utf8',
            flag: 'wx',
          });
          return 'copied';
        } catch (copyErr) {
          if (copyErr.code === 'EEXIST') {
            const racedExisting = inspectExistingDestination(target, linkPath);
            if (racedExisting !== null) return racedExisting;
            continue;
          }
          throw copyErr;
        }
      }
    }
    console.warn(`  ⚠ Could not create ${linkPath} after repeated conflicts; please re-run setup.`);
    return '';
  } catch (err) {
    console.error(`  ✗ Failed to link/copy ${target} -> ${linkPath}: ${err.message}`);
    return '';
  }
}

module.exports = { createSymlinkOrCopy, HEADER_COMMENT };
