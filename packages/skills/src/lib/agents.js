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
 *
 * Forge currently supports Claude Code, Codex, Cursor, and Hermes.
 * Dropped agents: aider, antigravity, cline, continue, github-copilot,
 * kilocode, opencode, roo, windsurf
 */
const AGENT_DEFINITIONS = [
  { name: 'claude',      directory: '.claude',   description: 'Claude Code (Anthropic)',   enabled: true },
  { name: 'codex',       directory: '.codex',    description: 'Codex CLI (OpenAI)',        enabled: true },
  { name: 'cursor',      directory: '.cursor',   description: 'Cursor AI Code Editor',     enabled: true },
  { name: 'hermes',      directory: '.hermes',   description: 'Hermes harness',            enabled: true },
];

/**
 * Detect installed AI agents in the current directory
 *
 * @returns {Array} Array of detected agent objects with name, path, enabled, description
 *
 * @example
 * const agents = detectAgents();
 * // [
 * //   { name: 'claude', path: '.claude/skills', enabled: true, description: 'Claude Code (Anthropic)' },
 * //   { name: 'codex', path: '.codex/skills', enabled: true, description: 'Codex CLI (OpenAI)' },
 * //   { name: 'cursor', path: '.cursor/skills', enabled: true, description: 'Cursor AI Code Editor' }
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
