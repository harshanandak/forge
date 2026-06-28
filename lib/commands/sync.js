'use strict';

const { createSyncBackend } = require('../sync-backend');

/**
 * Forge Sync Command
 * Syncs Kernel issue state with the configured sync backend.
 *
 * The local kernel is single-machine authority, so the default `local-noop`
 * backend is a graceful no-op that names the model instead of moving data.
 * Selecting `git-jsonl`/`server` (a future swap) is a backend change with zero
 * call-site churn — see docs/work/2026-06-26-sync-authority/design.md.
 *
 * @module commands/sync
 */
module.exports = {
  name: 'sync',
  description: 'Sync Kernel issue state with the configured sync backend (local-noop until a server/remote is configured)',
  usage: 'forge sync',
  flags: {},

  /**
   * Resolve a SyncBackend (default `local-noop`) and run its one-shot sync.
   * @param {string[]} _args - Positional arguments (unused)
   * @param {object} _flags - CLI flags (unused)
   * @param {string} projectRoot - Project root path (used for backend resolution)
   * @param {object} [opts] - Options for dependency injection
   * @param {object} [opts._backend] - Override for the resolved SyncBackend (testing)
   * @param {object} [opts.deps] - Explicit backend selection (precedence over env/config)
   * @param {object} [opts.env] - Environment override (testing)
   * @returns {Promise<{success: boolean, synced: boolean, message?: string, error?: string}>}
   */
  handler: async (_args, _flags, projectRoot, opts = {}) => {
    let backend;
    try {
      backend = opts._backend || createSyncBackend({
        projectRoot,
        deps: opts.deps,
        env: opts.env,
      });
    } catch (resolveErr) {
      return { success: false, synced: false, error: resolveErr.message };
    }

    let result;
    try {
      result = await backend.sync({ ...opts, projectRoot });
    } catch (syncErr) {
      console.error(`forge sync failed: ${syncErr.message}`);
      return { success: false, synced: false, error: syncErr.message };
    }
    // Surface the outcome to the user — otherwise `forge sync` runs silently and
    // a user can't tell whether it synced, no-op'd (local-noop), or failed.
    if (result && result.message) {
      console.log(result.message);
    } else if (result && !result.success && result.error) {
      console.error(`forge sync failed: ${result.error}`);
    }
    return result;
  },
};
