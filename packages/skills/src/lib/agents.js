/**
 * Agent detection utilities
 *
 * Detects AI agents in the current project based on directory presence
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Agent definitions
 *
 * All agents are enabled: true — directory existence already gates syncing.
 * If a developer has .roo/, etc. they use that agent and want skills.
 *
 * Dropped agents (removed in agent-command-parity-v2):
 * aider, antigravity, continue, windsurf
 */
const AGENT_DEFINITIONS = [
  { name: 'claude',      directory: '.claude',   description: 'Claude Code (Anthropic)',   enabled: true },
  { name: 'cline',       directory: '.cline',    description: 'Cline VSCode Extension',    enabled: true },
  { name: 'cursor',      directory: '.cursor',   description: 'Cursor AI Code Editor',     enabled: true },
  { name: 'github',      directory: '.github',   description: 'GitHub Copilot Workspace',  enabled: true },
  { name: 'kilocode',    directory: '.kilocode', description: 'Kilo Code (VS Code)',       enabled: true },
  { name: 'opencode',    directory: '.opencode', description: 'OpenCode',                  enabled: true },
  { name: 'roo',         directory: '.roo',      description: 'Roo Code (Cline fork)',     enabled: true },
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
      const entry = {
        name: agent.name,
        path: `${agent.directory}/skills`,
        enabled: agent.enabled,
        description: agent.description
      };
      if (agent.configFile) entry.configFile = agent.configFile;
      agents.push(entry);
    }
  }

  // Sort alphabetically for consistency
  agents.sort((a, b) => a.name.localeCompare(b.name));

  return agents;
}
