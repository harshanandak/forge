'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const TOKEN_FILENAME = '.forge-push-token';
const MAX_AGE_MS = 30000; // 30 seconds

/**
 * Get the absolute path to the token file.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @returns {string} Token file path
 */
function tokenPath(projectRoot) {
  return path.join(projectRoot, TOKEN_FILENAME);
}

/**
 * Write a one-time nonce token to disk.
 * Called by `forge push` right before `git push` so lefthook hooks
 * can detect that checks already passed and skip re-running them.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @returns {{nonce: string, timestamp: number}} The written token data
 */
function write(projectRoot) {
  const data = {
    nonce: crypto.randomUUID(),
    timestamp: Date.now(),
  };
  fs.writeFileSync(tokenPath(projectRoot), JSON.stringify(data), 'utf-8');
  return data;
}

/**
 * Check if a valid (fresh, well-formed) forge push token exists.
 * Does NOT delete the token — use `consume()` for one-time validation.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @returns {boolean} True if a valid, fresh token exists
 */
function isValid(projectRoot) {
  try {
    const raw = fs.readFileSync(tokenPath(projectRoot), 'utf-8');
    const content = JSON.parse(raw);
    if (!content.nonce || typeof content.timestamp !== 'number') {
      return false;
    }
    const age = Date.now() - content.timestamp;
    return age < MAX_AGE_MS;
  } catch (_err) {
    return false;
  }
}

/**
 * Validate and delete the token in one atomic operation (one-time use).
 * Always attempts to delete the file, even if the token is stale or invalid.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @returns {boolean} True if the token was valid before deletion
 */
function consume(projectRoot) {
  const tp = tokenPath(projectRoot);
  try {
    const raw = fs.readFileSync(tp, 'utf-8');
    // Always delete after reading — whether valid or not
    try { fs.unlinkSync(tp); } catch (_e) { /* already gone */ }

    const content = JSON.parse(raw);
    if (!content.nonce || typeof content.timestamp !== 'number') {
      return false;
    }
    const age = Date.now() - content.timestamp;
    return age < MAX_AGE_MS;
  } catch (_err) {
    // File doesn't exist or isn't readable — try cleanup anyway
    try { fs.unlinkSync(tp); } catch (_e) { /* nothing to clean */ }
    return false;
  }
}

module.exports = { write, isValid, consume };

// When run directly as a script (e.g., from lefthook skip check):
// Exit 0 = token valid (skip hooks), Exit 1 = run hooks normally.
// Uses isValid() (non-destructive) so multiple lefthook commands can
// each check the same token. The token expires after 30s automatically.
if (require.main === module) {
  const projectRoot = process.cwd();
  if (isValid(projectRoot)) {
    console.log('forge push token valid — skipping pre-push hooks');
    process.exit(0);
  }
  process.exit(1);
}
