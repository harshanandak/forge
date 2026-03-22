'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Detect the default branch of the repository.
 *
 * Strategy (in order):
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` -> parse branch name
 *   2. `git remote show origin` -> parse "HEAD branch:" line
 *   3. Fall back to `'main'`
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @param {object} [options] - Options object.
 * @param {Function} [options._exec] - Injected execFileSync for testing.
 * @returns {string} The default branch name.
 */
function detectDefaultBranch(projectRoot, options = {}) {
  const exec = options._exec || execFileSync;

  // Strategy 1: symbolic-ref
  try {
    const out = exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const ref = out.toString().trim();
    // refs/remotes/origin/main -> main
    const parts = ref.split('/');
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  } catch (_e) {
    // fall through to strategy 2
  }

  // Strategy 2: remote show origin
  try {
    const out = exec('git', ['remote', 'show', 'origin'], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const text = out.toString();
    const match = text.match(/HEAD branch:\s*(.+)/);
    if (match) {
      return match[1].trim();
    }
  } catch (_e) {
    // fall through to fallback
  }

  // Strategy 3: fallback
  return 'main';
}

/**
 * Detect the installed Beads version.
 *
 * Strategy (in order):
 *   1. `bd --version` -> parse version string (e.g. "beads version 0.52.0" -> "0.52.0")
 *   2. Fall back to known-good default `'0.49.1'`
 *
 * @param {object} [options] - Options object.
 * @param {Function} [options._exec] - Injected execFileSync for testing.
 * @returns {string} The Beads version string.
 */
function detectBeadsVersion(options = {}) {
  const exec = options._exec || execFileSync;

  try {
    const out = exec('bd', ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const text = out.toString().trim();
    // "beads version 0.52.0" -> "0.52.0"
    const match = text.match(/(\d+\.\d+\.\d+)/);
    if (match) {
      return match[1];
    }
  } catch (_e) {
    // fall through to fallback
  }

  return '0.49.1';
}

/**
 * Template workflow YAML files by replacing the default branch and Beads version.
 *
 * Reads all `.yml` and `.yaml` files in `workflowDir`, replaces:
 *   - `branches: [master]` with `branches: [<branch>]`
 *   - `BD_VERSION="0.49.1"` with `BD_VERSION="<beadsVersion>"`
 * and writes them back.
 *
 * @param {string} workflowDir - Absolute path to the directory containing YAML files.
 * @param {string} branch - The default branch name to substitute.
 * @param {string} beadsVersion - The Beads version to substitute.
 */
function templateWorkflows(workflowDir, branch, beadsVersion) {
  const entries = fs.readdirSync(workflowDir);

  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (ext !== '.yml' && ext !== '.yaml') {
      continue;
    }

    const filePath = path.join(workflowDir, entry);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      continue;
    }

    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(
      /branches:\s*\[master\]/g,
      `branches: [${branch}]`
    );
    content = content.replace(
      /BD_VERSION="0\.49\.1"/g,
      `BD_VERSION="${beadsVersion}"`
    );
    fs.writeFileSync(filePath, content);
  }
}

module.exports = {
  detectDefaultBranch,
  detectBeadsVersion,
  templateWorkflows,
};
