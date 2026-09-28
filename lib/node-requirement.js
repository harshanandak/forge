'use strict';

// Single source of truth for Forge's minimum Node.js runtime.
// Keep in sync with "engines.node" in package.json (asserted by tests).
const MIN_NODE_MAJOR = 24;

function parseNodeMajor(version) {
  const match = String(version).trim().match(/^v?(\d+)/);
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

module.exports = { MIN_NODE_MAJOR, nodeVersionError, parseNodeMajor };
