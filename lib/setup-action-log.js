/**
 * Centralized action log for setup operations.
 *
 * Collects file-level actions (created, skipped, merged, etc.) during
 * `forge setup` so the CLI can display a structured summary at the end.
 *
 * @module setup-action-log
 */

/** Map of directory prefixes to human-readable agent names. */
const AGENT_PREFIXES = {
  '.claude/': 'Claude Code',
  '.cursor/': 'Cursor',
  '.windsurf/': 'Windsurf',
  '.cline/': 'Cline',
  '.copilot/': 'Copilot',
  '.aider/': 'Aider',
  '.roo/': 'Roo Code'
};

/**
 * Detect the agent name from a file path.
 *
 * @param {string} filePath - Relative file path (e.g. `.claude/settings.json`)
 * @returns {string} Agent name or `'General'` if no agent prefix matches
 */
function detectAgent(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  for (const [prefix, name] of Object.entries(AGENT_PREFIXES)) {
    if (normalized.startsWith(prefix)) {
      return name;
    }
  }
  return 'General';
}

/**
 * Strip the agent directory prefix from a file path.
 *
 * @param {string} filePath - Relative file path
 * @returns {string} Path with the leading agent directory removed
 */
function stripAgentPrefix(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  for (const prefix of Object.keys(AGENT_PREFIXES)) {
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length);
    }
  }
  return normalized;
}

class SetupActionLog {
  constructor() {
    /** @type {Array<{file: string, action: string, detail: string|null}>} */
    this.actions = [];
  }

  /**
   * Record a setup action.
   *
   * @param {string} file   - Relative file path that was acted on
   * @param {string} action - One of: created, skipped, merged, conflict, removed, force-created
   * @param {string|null} [detail=null] - Optional human-readable detail
   */
  add(file, action, detail = null) {
    this.actions.push({ file, action, detail });
  }

  /**
   * Get counts grouped by action type.
   *
   * @returns {Record<string, number>} e.g. `{ created: 4, skipped: 2 }`
   */
  getSummary() {
    const counts = {};
    for (const { action } of this.actions) {
      counts[action] = (counts[action] || 0) + 1;
    }
    return counts;
  }

  /**
   * Get the full ordered list of actions.
   *
   * @returns {Array<{file: string, action: string, detail: string|null}>}
   */
  getVerbose() {
    return this.actions;
  }

  /**
   * Group files by detected agent name.
   *
   * Each agent key maps to an object whose keys are action types and whose
   * values are arrays of file paths (with the agent prefix stripped).
   *
   * @returns {Record<string, Record<string, string[]>>}
   */
  getAgentSummary() {
    const agents = {};
    for (const { file, action } of this.actions) {
      const agent = detectAgent(file);
      const stripped = stripAgentPrefix(file);

      if (!agents[agent]) {
        agents[agent] = {};
      }
      if (!agents[agent][action]) {
        agents[agent][action] = [];
      }
      agents[agent][action].push(stripped);
    }
    return agents;
  }

  /**
   * Filter actions by type.
   *
   * @param {string} action - The action type to filter on
   * @returns {Array<{file: string, action: string, detail: string|null}>}
   */
  getByAction(action) {
    return this.actions.filter(a => a.action === action);
  }

  /**
   * Total number of recorded actions.
   *
   * @returns {number}
   */
  get length() {
    return this.actions.length;
  }
}

module.exports = { SetupActionLog };
