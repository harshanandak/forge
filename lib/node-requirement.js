'use strict';

// Single source of truth for Forge's minimum Node.js runtime.
// Keep in sync with "engines.node" in package.json (asserted by tests).
const MIN_NODE_MAJOR = 24;
// Bun floor, matching the kernel's builtin SQLite requirement (lib/kernel/sqlite-driver.js).
const MIN_BUN_VERSION = '1.2';

function parseNodeMajor(version) {
  // Whole-string match: a valid prefix followed by junk ("v24invalid") is
  // unparseable and must fail closed. Prerelease suffixes ("-nightly...") are allowed.
  const match = String(version).trim().match(/^v?(\d+)(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/);
  return match ? Number(match[1]) : Number.NaN;
}

/**
 * Returns an upgrade error message when `version` is below the supported
 * minimum, or null when it is supported.
 * @param {string|number} version - e.g. process.version ("v24.1.0") or a major number.
 * @returns {string|null}
 */
function nodeVersionError(version) {
  const major = typeof version === 'number' ? version : parseNodeMajor(version);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) return null;
  const current = typeof version === 'number' ? `v${version}.x` : String(version);
  return `Node.js ${MIN_NODE_MAJOR}+ required (current: ${current}). Upgrade Node.js from https://nodejs.org`;
}

function bunVersionAtLeast(version, minimum) {
  const match = String(version).trim().match(/^v?(\d+)\.(\d+)(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/);
  if (!match) return false;
  const [minMajor, minMinor] = minimum.split('.').map(Number);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * Runtime floor for the process actually executing Forge. Under Bun,
 * process.versions.node is Bun's emulated Node-compat version (e.g. Bun 1.2.14
 * reports 22.6.0), so the Bun floor applies instead of the Node floor.
 * @param {{ node?: string, bun?: string }} [versions] - defaults to process.versions.
 * @returns {string|null} upgrade error message, or null when supported.
 */
function runtimeVersionError(versions = process.versions) {
  if (versions && versions.bun !== undefined) {
    if (bunVersionAtLeast(versions.bun, MIN_BUN_VERSION)) return null;
    return `Bun ${MIN_BUN_VERSION}+ required (current: ${versions.bun}). Upgrade Bun from https://bun.sh`;
  }
  const node = versions && versions.node;
  return nodeVersionError(node ? `v${String(node).replace(/^v/, '')}` : 'unknown');
}

/** Human label for the executing runtime, e.g. "node v24.1.0" or "bun v1.2.14". */
function runtimeLabel(versions = process.versions) {
  if (versions && versions.bun !== undefined) return `bun v${versions.bun}`;
  return `node v${String((versions && versions.node) || 'unknown').replace(/^v/, '')}`;
}

module.exports = {
  MIN_NODE_MAJOR,
  MIN_BUN_VERSION,
  nodeVersionError,
  parseNodeMajor,
  runtimeVersionError,
  runtimeLabel,
};
