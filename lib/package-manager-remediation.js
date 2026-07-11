/**
 * package-manager-remediation.js — Detect the caller's package manager from
 * lockfile presence so remediation messages (e.g. "lefthook is missing, run
 * X") give the correct install command instead of hard-coding a single tool.
 *
 * This is deliberately separate from lib/detection-utils.js#detectPackageManager,
 * which shells out to probe installed binaries and prints setup-wizard output.
 * Remediation messages need a fast, side-effect-free, synchronous lookup that
 * never spawns a process — it runs on every stage-gate health check.
 *
 * @module lib/package-manager-remediation
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Ordered lockfile → package manager mapping. First match wins.
 * `install` is the command to fetch already-declared dependencies.
 * `addDev(pkg)` is the command to add a new dev dependency and install it.
 */
const PACKAGE_MANAGERS = [
  {
    name: 'bun',
    lockFiles: ['bun.lockb', 'bun.lock'],
    install: 'bun install',
    addDev: pkg => `bun add -D ${pkg} && bun install`
  },
  {
    name: 'pnpm',
    lockFiles: ['pnpm-lock.yaml'],
    install: 'pnpm install',
    addDev: pkg => `pnpm add -D ${pkg}`
  },
  {
    name: 'yarn',
    lockFiles: ['yarn.lock'],
    install: 'yarn install',
    addDev: pkg => `yarn add -D ${pkg}`
  },
  {
    name: 'npm',
    lockFiles: ['package-lock.json'],
    install: 'npm install',
    addDev: pkg => `npm install -D ${pkg}`
  }
];

// npm is the safest universal fallback when no lockfile is present or
// recognized — it ships with Node itself, so it is always a documented,
// reasonable default rather than assuming any particular toolchain.
const DEFAULT_MANAGER = PACKAGE_MANAGERS[PACKAGE_MANAGERS.length - 1];

/**
 * Detect the package manager in use for a project from lockfile presence.
 *
 * @param {string} [projectRoot] - Absolute path to the project root. Falls
 *   back to process.cwd() when omitted or not a non-empty string.
 * @returns {{ name: string, install: string, addDev: (pkg: string) => string }}
 *   The detected (or default) package manager descriptor.
 */
function detectPackageManagerForRemediation(projectRoot) {
  const root = typeof projectRoot === 'string' && projectRoot.trim()
    ? projectRoot
    : process.cwd();

  for (const manager of PACKAGE_MANAGERS) {
    const hasLockFile = manager.lockFiles.some(file =>
      fs.existsSync(path.join(root, file))
    );
    if (hasLockFile) return manager;
  }

  return DEFAULT_MANAGER;
}

/**
 * Get the install command for the detected package manager (e.g. when a
 * dependency is already declared but not installed).
 *
 * @param {string} [projectRoot] - Absolute path to the project root.
 * @returns {string} Install command, e.g. "npm install".
 */
function getInstallCommand(projectRoot) {
  return detectPackageManagerForRemediation(projectRoot).install;
}

/**
 * Get the "add as dev dependency" command for the detected package manager.
 *
 * @param {string} [projectRoot] - Absolute path to the project root.
 * @param {string} pkg - Package name to add, e.g. "lefthook".
 * @returns {string} Add-dev-dependency command, e.g. "npm install -D lefthook".
 */
function getAddDevCommand(projectRoot, pkg) {
  return detectPackageManagerForRemediation(projectRoot).addDev(pkg);
}

module.exports = {
  detectPackageManagerForRemediation,
  getInstallCommand,
  getAddDevCommand
};
