'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanupDeprecatedSyncFiles } = require('./deprecated-sync-cleanup');

const DEFAULT_BEADS_VERSION = '1.0.0';

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
    // Expected: symbolic-ref fails when origin/HEAD is not set — fall through to strategy 2
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
    // Expected: 'git remote show origin' fails when no remote is configured — fall through to fallback
  }

  // Strategy 3: fallback
  return 'main';
}

/**
 * Detect the installed Beads version.
 *
 * Strategy (in order):
 *   1. `bd --version` -> parse version string (e.g. "beads version 0.52.0" -> "0.52.0")
 *   2. Fall back to the current repo baseline release
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
    const match = text.match(/(\d{1,4}\.\d{1,4}\.\d{1,4})/);
    if (match) {
      return match[1];
    }
  } catch (_e) {
    // Expected: 'bd --version' fails when bd CLI is not installed — fall through to default version
  }

  return DEFAULT_BEADS_VERSION;
}

/**
 * Template workflow YAML files by replacing the default branch and Beads version.
 *
 * Templates only forge-created workflow files by replacing the default branch
 * and Beads version. Skips user-owned workflows to avoid overwriting legitimate
 * branch targets.
 *
 * @param {string} workflowDir - Absolute path to the directory containing YAML files.
 * @param {string} branch - The default branch name to substitute.
 * @param {string} beadsVersion - The Beads version to substitute.
 * @param {string[]} [createdFiles=[]] - List of file paths created by scaffoldBeadsSync. Only these are templated.
 */
function templateWorkflows(workflowDir, branch, beadsVersion, createdFiles = []) {
  if (!fs.existsSync(workflowDir)) return;

  const targetNames = new Set(createdFiles.map(f => path.basename(f)));

  const entries = fs.readdirSync(workflowDir);

  for (const entry of entries) {
    // Only template forge-created files; skip user-owned workflows
    if (targetNames.size > 0 && !targetNames.has(entry)) continue;

    const ext = path.extname(entry).toLowerCase();
    if (ext !== '.yml' && ext !== '.yaml') {
      continue;
    }

    const filePath = path.join(workflowDir, entry);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      continue;
    }

    const original = fs.readFileSync(filePath, 'utf8');
    let content = original;
    content = content.replaceAll(
      /branches:\s*\[master\]/g,
      `branches: [${branch}]`
    );
    for (const version of ['0.49.1', DEFAULT_BEADS_VERSION, '__FORGE_BEADS_VERSION__']) {
      content = content.replaceAll(
        `BD_VERSION="${version}"`,
        `BD_VERSION="${beadsVersion}"`
      );
    }
    // Only write if content actually changed
    if (content !== original) {
      fs.writeFileSync(filePath, content);
    }
  }
}

function cleanupDeprecatedBeadsSync(projectRoot, options = {}) {
  return cleanupDeprecatedSyncFiles(projectRoot, options);
}

/**
 * @typedef {Object} ScaffoldResult
 * @property {string[]} filesCreated - Relative paths of files written (new or overwritten)
 * @property {string[]} filesSkipped - Relative paths of files that already existed and were preserved
 */

/**
 * Scaffold Beads sync workflows and scripts to the user's project.
 *
 * Copies workflow templates, sync modules, config, and mapping stub into
 * the project's `.github/` tree from the forge package source.
 *
 * @param {string} projectRoot - Absolute path to the user's project root
 * @param {string} packageDir - Absolute path to the forge package install location
 * @param {Object} [_options={}] - Reserved for future options
 * @returns {ScaffoldResult}
 */
function scaffoldBeadsSync(projectRoot, packageDir, _options = {}) {
  const cleanup = cleanupDeprecatedBeadsSync(projectRoot, { packageDir });

  return {
    filesCreated: [],
    filesSkipped: [],
    filesRemoved: cleanup.removed,
    deprecated: true,
    message: 'Beads GitHub sync scaffolding is deprecated; future GitHub issue sync must use Forge Kernel/server authority.'
  };
}

module.exports = {
  DEFAULT_BEADS_VERSION,
  detectDefaultBranch,
  detectBeadsVersion,
  templateWorkflows,
  cleanupDeprecatedBeadsSync,
  scaffoldBeadsSync,
};
