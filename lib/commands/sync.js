'use strict';

const { execFileSync } = require('node:child_process');

function isRecoverableBeadsSyncError(error) {
  const message = error?.message ?? String(error ?? '');
  return (
    message.includes('failed to open database') ||
    message.includes('database not found') ||
    message.includes('no beads configuration found')
  );
}

/**
 * Forge Sync Command
 * Syncs Beads issue data by running dolt pull + push.
 * Uses execFileSync (not execSync) to prevent command injection (OWASP A03).
 *
 * @module commands/sync
 */
module.exports = {
  name: 'sync',
  description: 'Sync Beads issue data (dolt pull + push)',
  usage: 'forge sync',
  flags: {},

  /**
   * Run beads dolt pull + push to sync issue data.
   * @param {string[]} _args - Positional arguments (unused)
   * @param {object} _flags - CLI flags (unused)
   * @param {string} _projectRoot - Project root path (unused)
   * @param {object} [opts] - Options for dependency injection
   * @param {Function} [opts._exec] - Override for execFileSync (testing)
   * @returns {Promise<{success: boolean, synced: boolean, message?: string, error?: string}>}
   */
  handler: async (_args, _flags, _projectRoot, opts = {}) => {
    const exec = opts._exec || execFileSync;

    // Step 1: Check if bd binary exists
    try {
      exec('bd', ['--version'], { stdio: 'pipe' });
    } catch { /* intentional: bd not installed, skip sync gracefully */ // NOSONAR S2486
      return {
        success: true,
        synced: false,
        message: 'Beads not installed — nothing to sync',
      };
    }

    // Step 2: Run dolt pull + push
    try {
      exec('bd', ['dolt', 'pull'], { stdio: 'pipe' });
      exec('bd', ['dolt', 'push'], { stdio: 'pipe' });
    } catch (syncErr) {
      if (isRecoverableBeadsSyncError(syncErr)) {
        return {
          success: true,
          synced: false,
          message: 'Beads is installed but not initialized for sync in this worktree — skipping sync',
        };
      }
      return {
        success: false,
        synced: false,
        error: syncErr.message,
      };
    }

    return { success: true, synced: true };
  },
};
