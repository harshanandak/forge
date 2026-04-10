'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
    content = content.replaceAll(
      /BD_VERSION="(\d{1,4}\.\d{1,4}\.\d{1,4})"/g,
      `BD_VERSION="${beadsVersion}"`
    );
    // Only write if content actually changed
    if (content !== original) {
      fs.writeFileSync(filePath, content);
    }
  }
}

/**
 * @typedef {Object} ScaffoldResult
 * @property {string[]} filesCreated - Relative paths of files written (new or overwritten)
 * @property {string[]} filesSkipped - Relative paths of files that already existed and were preserved
 */

/**
 * Copy a single file from src to dest, creating parent directories as needed.
 *
 * @param {string} src - Absolute source path
 * @param {string} dest - Absolute destination path
 * @returns {void}
 */
function copyFileWithDirs(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

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
  /** @type {string[]} */
  const filesCreated = [];
  /** @type {string[]} */
  const filesSkipped = [];

  const githubDir = path.join(projectRoot, '.github');

  // --- Step a: Copy workflow templates ---
  const workflowNames = ['github-to-beads.yml', 'beads-to-github.yml'];
  const srcWorkflowsDir = path.join(packageDir, '.github', 'workflows');

  for (const name of workflowNames) {
    const src = path.join(srcWorkflowsDir, name);
    const relPath = `.github/workflows/${name}`;
    const dest = path.join(projectRoot, '.github', 'workflows', name);

    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) {
      filesSkipped.push(relPath);
    } else {
      copyFileWithDirs(src, dest);
      filesCreated.push(relPath);
    }
  }

  // --- Step b: Copy sync modules ---
  const srcSyncDir = path.join(packageDir, 'scripts', 'github-beads-sync');
  const destSyncDir = path.join(githubDir, 'scripts', 'beads-sync');

  if (fs.existsSync(srcSyncDir)) {
    const entries = fs.readdirSync(srcSyncDir);
    for (const entry of entries) {
      const srcFile = path.join(srcSyncDir, entry);
      const stat = fs.statSync(srcFile);
      if (stat.isFile()) {
        const relPath = `.github/scripts/beads-sync/${entry}`;
        const dest = path.join(destSyncDir, entry);
        if (fs.existsSync(dest)) {
          filesSkipped.push(relPath);
        } else {
          copyFileWithDirs(srcFile, dest);
          filesCreated.push(relPath);
        }
      }
    }
  }

  // --- Step c: Create beads-sync-config.json ---
  const configRelPath = '.github/beads-sync-config.json';
  const configDest = path.join(githubDir, 'beads-sync-config.json');
  const srcConfig = path.join(packageDir, 'scripts', 'github-beads-sync.config.json');

  if (fs.existsSync(configDest)) {
    filesSkipped.push(configRelPath);
  } else if (fs.existsSync(srcConfig)) {
    copyFileWithDirs(srcConfig, configDest);
    filesCreated.push(configRelPath);
  } else {
    // Create a sensible default config
    const defaultConfig = {
      defaultType: 'task',
      defaultPriority: 2,
      mapAssignee: true,
      publicRepoGate: 'none'
    };
    fs.mkdirSync(path.dirname(configDest), { recursive: true });
    fs.writeFileSync(configDest, JSON.stringify(defaultConfig, null, 2) + '\n');
    filesCreated.push(configRelPath);
  }

  // --- Step d: Create beads-mapping.json if not exists ---
  const mappingRelPath = '.github/beads-mapping.json';
  const mappingDest = path.join(githubDir, 'beads-mapping.json');

  if (fs.existsSync(mappingDest)) {
    filesSkipped.push(mappingRelPath);
  } else {
    fs.mkdirSync(path.dirname(mappingDest), { recursive: true });
    fs.writeFileSync(mappingDest, '{}');
    filesCreated.push(mappingRelPath);
  }

  return { filesCreated, filesSkipped };
}

module.exports = {
  detectDefaultBranch,
  detectBeadsVersion,
  templateWorkflows,
  scaffoldBeadsSync,
};
