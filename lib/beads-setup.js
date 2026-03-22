/**
 * Utilities for configuring Beads during `forge setup`.
 *
 * Handles prefix sanitization, config/gitignore generation,
 * initialization detection, and issues.jsonl pre-seeding.
 *
 * @module beads-setup
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Resolve a command to its full path to avoid relying on inherited PATH.
 * Falls back to the command name if resolution fails.
 * @param {string} command
 * @returns {string}
 */
function resolveCommand(command) {
  const resolver = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = spawnSync(resolver, [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim().split(/\r?\n/)[0].trim();
    }
  } catch (_e) {
    // Expected: command resolution may fail if 'which'/'where.exe' is unavailable — fall back to bare command name
  }
  return command;
}

/**
 * Sanitize a repository name into a valid Beads issue prefix.
 *
 * Lowercases, replaces non-alphanumeric characters (except hyphens) with
 * hyphens, collapses consecutive hyphens, and trims leading/trailing hyphens.
 *
 * @param {string} repoName - Raw repository or project name
 * @returns {string} Sanitized prefix suitable for `issue-prefix`
 *
 * @example
 * sanitizePrefix('My-Project_v2!') // => 'my-project-v2'
 * sanitizePrefix('  Spaces  ')     // => 'spaces'
 */
function sanitizePrefix(repoName) {
  return repoName
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '');
}

/**
 * Write `.beads/config.yaml` with the given options.
 *
 * Creates the `.beads/` directory if it doesn't already exist.
 * The prefix is sanitized before writing.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {object} options - Configuration options
 * @param {string} options.prefix - Project prefix (will be sanitized)
 */
function writeBeadsConfig(projectRoot, options) {
  const beadsDir = path.join(projectRoot, '.beads');
  fs.mkdirSync(beadsDir, { recursive: true });

  const prefix = sanitizePrefix(options.prefix);
  const configContent = [
    `issue-prefix: ${prefix}`,
    '',
    'database:',
    '  backend: dolt',
    ''
  ].join('\n');

  fs.writeFileSync(path.join(beadsDir, 'config.yaml'), configContent, 'utf8');
}

/**
 * Write `.beads/.gitignore` with entries for Dolt binary files.
 *
 * Creates the `.beads/` directory if it doesn't already exist.
 *
 * @param {string} projectRoot - Absolute path to the project root
 */
function writeBeadsGitignore(projectRoot) {
  const beadsDir = path.join(projectRoot, '.beads');
  fs.mkdirSync(beadsDir, { recursive: true });

  const gitignoreContent = [
    '# Dolt database files (binary, not suitable for git)',
    'dolt/',
    '*.db',
    '*.lock',
    ''
  ].join('\n');

  fs.writeFileSync(
    path.join(beadsDir, '.gitignore'),
    gitignoreContent,
    'utf8'
  );
}

/**
 * Check whether Beads is properly initialized in a project.
 *
 * Returns `true` only when all of the following are present:
 * - `.beads/` directory exists
 * - `.beads/config.yaml` exists and contains an `issue-prefix` key
 * - `.beads/issues.jsonl` exists
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {boolean} `true` if Beads is fully initialized
 */
function isBeadsInitialized(projectRoot) {
  const beadsDir = path.join(projectRoot, '.beads');
  const configPath = path.join(beadsDir, 'config.yaml');
  const jsonlPath = path.join(beadsDir, 'issues.jsonl');

  if (!fs.existsSync(beadsDir)) return false;
  if (!fs.existsSync(configPath)) return false;
  if (!fs.existsSync(jsonlPath)) return false;

  const configContent = fs.readFileSync(configPath, 'utf8');
  if (!configContent.includes('issue-prefix:')) return false;

  return true;
}

/**
 * Ensure `issues.jsonl` exists inside `.beads/`.
 *
 * Creates the `.beads/` directory and an empty `issues.jsonl` if either
 * is missing. Leaves an existing `issues.jsonl` untouched.
 *
 * @param {string} projectRoot - Absolute path to the project root
 */
function preSeedJsonl(projectRoot) {
  const beadsDir = path.join(projectRoot, '.beads');
  fs.mkdirSync(beadsDir, { recursive: true });

  const jsonlPath = path.join(beadsDir, 'issues.jsonl');
  if (!fs.existsSync(jsonlPath)) {
    fs.writeFileSync(jsonlPath, '', 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Task 11: Defensive bd init wrapper
// ---------------------------------------------------------------------------

/**
 * Snapshot all files in a directory — returns a Map of filename to content (Buffer).
 * Returns an empty Map if the directory does not exist.
 *
 * @param {string} dirPath - Absolute path to the directory to snapshot
 * @returns {Map<string, Buffer>} Map of filename to raw file contents
 */
function snapshotDirectory(dirPath) {
  const snapshot = new Map();

  if (!fs.existsSync(dirPath)) {
    return snapshot;
  }

  const entries = fs.readdirSync(dirPath);
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        snapshot.set(entry, fs.readFileSync(fullPath));
      }
    } catch (_err) {
      // Expected: file may be locked or permission-denied — skip unreadable files during snapshot
    }
  }

  return snapshot;
}

/**
 * Restore a directory to exactly match a snapshot — overwrite changed files,
 * remove files not in the snapshot, recreate deleted files.
 *
 * @param {string} dirPath - Absolute path to the directory to restore
 * @param {Map<string, Buffer>} snapshot - Snapshot from snapshotDirectory()
 */
function restoreDirectory(dirPath, snapshot) {
  fs.mkdirSync(dirPath, { recursive: true });

  // Remove files that were not in the original snapshot
  const currentFiles = fs.readdirSync(dirPath);
  for (const file of currentFiles) {
    const fullPath = path.join(dirPath, file);
    try {
      if (fs.statSync(fullPath).isFile() && !snapshot.has(file)) {
        fs.unlinkSync(fullPath);
      }
    } catch (_err) {
      // Expected: file may be locked or already removed — skip files we cannot stat or remove during restore
    }
  }

  // Write all files from the snapshot
  for (const [name, content] of snapshot) {
    fs.writeFileSync(path.join(dirPath, name), content, { mode: 0o755 });
  }
}

/**
 * Default bd init executor — calls `execFileSync('bd', ['init'])`.
 *
 * @param {string} projectRoot - Absolute path to the project root
 */
function defaultExecBdInit(projectRoot) {
  const { execFileSync } = require('node:child_process');
  execFileSync(resolveCommand('bd'), ['init'], {
    cwd: projectRoot,
    stdio: 'pipe'
  });
}

/**
 * Defensive wrapper for `bd init` — orchestrates Beads initialization
 * with hook snapshot/restore to prevent bd from overwriting git hooks.
 *
 * Flow:
 *   a. Check if already initialized (idempotent skip)
 *   b. Write config.yaml with correct prefix
 *   c. Write .beads/.gitignore for Dolt files
 *   d. Snapshot .git/hooks/
 *   e. Run bd init (via execBdInit callback or default execFileSync)
 *   f. Restore .git/hooks/ from snapshot
 *   g. Restore lefthook hooks if callback provided
 *   h. Pre-seed issues.jsonl
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {Object} [options={}] - Configuration options
 * @param {string} [options.prefix] - Issue prefix (repo name), sanitized before use
 * @param {Function} [options.execBdInit] - Custom bd init executor. Receives (projectRoot).
 *   Defaults to calling execFileSync('bd', ['init']).
 * @param {Function} [options.restoreLefthook] - Optional callback to restore lefthook hooks
 *   (e.g., running `npx lefthook install`). Non-fatal if it throws.
 * @returns {{ success: boolean, skipped: boolean, reason?: string, warnings: string[], errors: string[] }}
 */
function safeBeadsInit(projectRoot, options = {}) {
  const warnings = [];
  const errors = [];

  // (a) Check if already initialized — idempotent skip
  if (isBeadsInitialized(projectRoot)) {
    return {
      success: true,
      skipped: true,
      reason: 'already initialized',
      warnings,
      errors
    };
  }

  // (b) Write config.yaml with correct prefix
  const prefix = options.prefix || '';
  try {
    writeBeadsConfig(projectRoot, { prefix });
  } catch (err) {
    warnings.push(`Failed to write config.yaml: ${err.message}`);
  }

  // (c) Write .beads/.gitignore for Dolt files
  try {
    writeBeadsGitignore(projectRoot);
  } catch (err) {
    warnings.push(`Failed to write .beads/.gitignore: ${err.message}`);
  }

  // (d) Snapshot current .git/hooks/ directory
  const hooksDir = path.join(projectRoot, '.git', 'hooks');
  const hooksSnapshot = snapshotDirectory(hooksDir);

  // (e) Run bd init — wrapped in try/catch
  const execBdInit = options.execBdInit || defaultExecBdInit;
  try {
    execBdInit(projectRoot);
  } catch (err) {
    // Always restore hooks, even on failure
    restoreDirectory(hooksDir, hooksSnapshot);

    if (err.code === 'ENOENT') {
      errors.push('bd CLI not installed');
    } else {
      errors.push(err.message);
    }

    return {
      success: false,
      skipped: false,
      warnings,
      errors
    };
  }

  // (f) Restore .git/hooks/ from snapshot
  restoreDirectory(hooksDir, hooksSnapshot);

  // (g) Restore lefthook hooks if callback provided
  if (typeof options.restoreLefthook === 'function') {
    try {
      options.restoreLefthook(projectRoot);
    } catch (err) {
      warnings.push(`Failed to restore lefthook hooks: ${err.message}`);
    }
  }

  // (h) Pre-seed JSONL if empty
  try {
    preSeedJsonl(projectRoot);
  } catch (err) {
    warnings.push(`Failed to pre-seed issues.jsonl: ${err.message}`);
  }

  return {
    success: true,
    skipped: false,
    warnings,
    errors
  };
}

module.exports = {
  sanitizePrefix,
  writeBeadsConfig,
  writeBeadsGitignore,
  isBeadsInitialized,
  preSeedJsonl,
  safeBeadsInit
};
