/**
 * Renders a clean summary from SetupActionLog data.
 *
 * Default mode: 3-line concise output.
 * Verbose mode: file-by-file detail grouped by agent.
 *
 * @module setup-summary-renderer
 */

/**
 * Capitalize the first letter of a string.
 *
 * @param {string} str
 * @returns {string}
 */
function capitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Render setup summary as a string.
 *
 * @param {import('./setup-action-log').SetupActionLog} actionLog - The populated action log
 * @param {string[]} agentNames - List of configured agent slugs (e.g. ['claude', 'cursor'])
 * @param {boolean} verbose - Whether to show file-by-file detail
 * @returns {string} The formatted summary output
 */
function renderSetupSummary(actionLog, agentNames, verbose) {
  if (verbose) {
    return renderVerbose(actionLog, agentNames);
  }
  return renderDefault(actionLog, agentNames);
}

/**
 * Render the default 3-line concise summary.
 *
 * @param {import('./setup-action-log').SetupActionLog} actionLog
 * @param {string[]} agentNames
 * @returns {string}
 */
function renderDefault(actionLog, agentNames) {
  const agentCount = agentNames.length;
  const agentLabel = agentCount === 1 ? '1 agent' : `${agentCount} agents`;
  const agentList = agentNames.length > 0 ? ` (${agentNames.join(', ')})` : '';

  const summary = actionLog.getSummary();

  // Build counts line — only include non-zero actions
  const displayOrder = ['created', 'skipped', 'merged', 'force-created', 'updated', 'conflict', 'removed'];
  const parts = [];
  for (const action of displayOrder) {
    if (summary[action] && summary[action] > 0) {
      parts.push(`${capitalize(action)}: ${summary[action]} ${summary[action] === 1 ? 'file' : 'files'}`);
    }
  }
  // Include any actions not in displayOrder
  for (const [action, count] of Object.entries(summary)) {
    if (!displayOrder.includes(action) && count > 0) {
      parts.push(`${capitalize(action)}: ${count} ${count === 1 ? 'file' : 'files'}`);
    }
  }

  const lines = [];
  lines.push(`Forge setup complete — ${agentLabel} configured${agentList}`);

  if (parts.length > 0) {
    lines.push(`  ${parts.join(' | ')}`);
  } else {
    lines.push('  0 files changed');
  }

  lines.push('  Run forge setup --verbose to see all files');

  return lines.join('\n');
}

/**
 * Render verbose file-by-file output grouped by agent.
 *
 * @param {import('./setup-action-log').SetupActionLog} actionLog
 * @param {string[]} _agentNames - Not used in verbose (agents come from log data)
 * @returns {string}
 */
function renderVerbose(actionLog, _agentNames) {
  const agentSummary = actionLog.getAgentSummary();
  const lines = [];

  for (const [agent, actions] of Object.entries(agentSummary)) {
    for (const [action, files] of Object.entries(actions)) {
      const fileCount = files.length;
      const fileLabel = fileCount === 1 ? '1 file' : `${fileCount} files`;
      const fileList = files.join(', ');
      lines.push(`${agent}: ${fileList} (${fileLabel}) [${action}]`);
    }
  }

  return lines.join('\n');
}

module.exports = { renderSetupSummary };
