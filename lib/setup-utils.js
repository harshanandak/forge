/**
 * Foundational utilities for `forge setup` command.
 *
 * - `ActionCollector` — collects planned/completed file actions for dry-run
 *   summaries and normal-mode logging.
 * - `isNonInteractive()` — detects CI environments and piped stdin so
 *   interactive prompts can fall back to defaults.
 *
 * @module setup-utils
 */

/**
 * Collects file-level actions during setup.
 *
 * Used by `--dry-run` to collect planned actions and by normal mode
 * to log what was actually done.
 */
class ActionCollector {
  constructor() {
    /** @type {Array<{type: string, path: string, description: string}>} */
    this._actions = [];
  }

  /**
   * Record a setup action.
   *
   * @param {'create'|'modify'|'skip'} type - Action type
   * @param {string} path - File path that was (or would be) acted on
   * @param {string} description - Human-readable explanation
   */
  add(type, path, description) {
    this._actions.push({ type, path, description });
  }

  /**
   * Return a copy of all recorded actions.
   *
   * @returns {Array<{type: string, path: string, description: string}>}
   */
  list() {
    return [...this._actions];
  }

  /**
   * Print a formatted summary of all recorded actions to stdout.
   */
  print() {
    if (this._actions.length === 0) {
      return;
    }

    const icons = {
      create: '+',
      modify: '~',
      skip: '-'
    };

    for (const { type, path, description } of this._actions) {
      const icon = icons[type] || '?';
      process.stdout.write(`  [${icon}] ${type.padEnd(6)} ${path} — ${description}\n`);
    }
  }
}

/**
 * Detect whether the current environment is non-interactive.
 *
 * Returns `true` if any of:
 * - `process.env.CI` is truthy (non-empty)
 * - `process.env.GITHUB_ACTIONS` exists
 * - `process.env.GITLAB_CI` exists
 * - `process.stdin.isTTY` is falsy
 * - `--non-interactive` flag was passed in `process.argv`
 *
 * @returns {boolean}
 */
function isNonInteractive() {
  if (process.env.CI && process.env.CI !== '') {
    return true;
  }
  if (process.env.GITHUB_ACTIONS !== undefined) {
    return true;
  }
  if (process.env.GITLAB_CI !== undefined) {
    return true;
  }
  if (!process.stdin.isTTY) {
    return true;
  }
  if (process.argv.includes('--non-interactive')) {
    return true;
  }
  return false;
}

module.exports = { ActionCollector, isNonInteractive };
