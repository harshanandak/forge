/**
 * Agent detection utilities
 *
 * Detects AI agents in the current project based on directory presence
 */

import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Agent definitions
 */
const AGENT_DEFINITIONS = [
  {
    name: 'cursor',
    directory: '.cursor',
    description: 'Cursor AI Code Editor',
    enabled: true
  },
  {
    name: 'github',
    directory: '.github',
    description: 'GitHub Copilot Workspace',
    enabled: true
  },
  {
    name: 'cline',
    directory: '.cline',
    description: 'Cline VSCode Extension',
    enabled: false
  },
  {
    name: 'continue',
    directory: '.continue',
    description: 'Continue VSCode Extension',
    enabled: false
  }
];

/**
 * Detect installed AI agents in the current directory
 *
 * @returns {Array} Array of detected agent objects with name, path, enabled, description
 *
 * @example
 * const agents = detectAgents();
 * // [
 * //   { name: 'cursor', path: '.cursor/skills', enabled: true, description: 'Cursor AI Code Editor' },
 * //   { name: 'github', path: '.github/skills', enabled: true, description: 'GitHub Copilot Workspace' }
 * // ]
 */
export function detectAgents() {
  const agents = [];
  const cwd = process.cwd();

  for (const agent of AGENT_DEFINITIONS) {
    const agentDir = join(cwd, agent.directory);

    if (existsSync(agentDir)) {
      agents.push({
        name: agent.name,
        path: `${agent.directory}/skills`,
        enabled: agent.enabled,
        description: agent.description
      });
    }
  }

  // Sort alphabetically for consistency
  agents.sort((a, b) => a.name.localeCompare(b.name));

  return agents;
}
