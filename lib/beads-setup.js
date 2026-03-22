/**
 * Utilities for configuring Beads during `forge setup`.
 *
 * Handles prefix sanitization, config/gitignore generation,
 * initialization detection, and issues.jsonl pre-seeding.
 *
 * @module beads-setup
 */

const fs = require('fs');
const path = require('path');

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
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
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

module.exports = {
  sanitizePrefix,
  writeBeadsConfig,
  writeBeadsGitignore,
  isBeadsInitialized,
  preSeedJsonl
};
