'use strict';

/**
 * ForgeContext — Mutable state container for the Forge CLI.
 *
 * Replaces the module-level globals in bin/forge.js with a single
 * injectable object, making state explicit and testable.
 *
 * Mirrors the globals: projectRoot, FORCE_MODE, VERBOSE_MODE,
 * NON_INTERACTIVE, SYMLINK_ONLY, SYNC_ENABLED, actionLog,
 * PKG_MANAGER, and packageDir.
 *
 * @module forge-context
 */

class ForgeContext {
  /**
   * @param {object} [options]
   * @param {string}   [options.projectRoot]    - Project root directory
   * @param {boolean}  [options.forceMode]      - Force overwrite (--force)
   * @param {boolean}  [options.verboseMode]    - Verbose output (--verbose)
   * @param {boolean}  [options.nonInteractive] - Skip prompts (--quick / --yes)
   * @param {boolean}  [options.symlinkOnly]    - Fail instead of copy fallback (--symlink)
   * @param {boolean}  [options.syncEnabled]    - Scaffold Beads GitHub sync (--sync)
   * @param {string}   [options.pkgManager]     - Detected package manager
   * @param {Array}    [options.actionLog]      - Incremental setup action log
   * @param {string}   [options.packageDir]     - Forge package directory
   */
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.forceMode = options.forceMode || false;
    this.verboseMode = options.verboseMode || false;
    this.nonInteractive = options.nonInteractive || false;
    this.symlinkOnly = options.symlinkOnly || false;
    this.syncEnabled = options.syncEnabled || false;
    this.pkgManager = options.pkgManager || 'npm';
    this.actionLog = options.actionLog || [];
    this.packageDir = options.packageDir || '';
  }
}

module.exports = { ForgeContext };
