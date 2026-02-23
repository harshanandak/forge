/**
 * skills sync - Synchronize skills to agent directories
 */

import { existsSync, readFileSync, writeFileSync, cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { detectAgents } from '../lib/agents.js';
import { validateSkillName } from '../lib/validation.js';
import { ensureRegistryExists, readRegistry, getSkillPaths } from '../lib/common.js';

/**
 * Sync skills to agent directories
 */
export async function syncCommand(options) {
  try {
    // Ensure registry exists and load it (with graceful error handling)
    ensureRegistryExists();
    const registry = readRegistry();
    const { skillsDir, registryPath } = getSkillPaths('');

    // Get all valid skills from both sources (dual-source: skills/ root + .skills/)
    const skills = getValidSkills(skillsDir);
    if (skills.length === 0) {
      console.log(chalk.yellow('No skills to sync'));
      console.log(chalk.gray('Create a skill with: skills create my-skill'));
      return;
    }

    // Detect agents — all enabled: true, directory existence is the gate
    const enabledAgents = detectAgents();
    if (enabledAgents.length === 0) {
      console.log(chalk.yellow('No agents detected'));
      console.log(chalk.gray('Supported: aider (.aider), antigravity (.agent), claude (.claude), cline (.cline), continue (.continue), cursor (.cursor), github (.github), kilocode (.kilocode), opencode (.opencode), roo (.roo), windsurf (.windsurf)'));
      return;
    }

    // Display sync header
    console.log(chalk.bold('\nSyncing skills to agents...'));
    console.log();
    console.log('Skills:', skills.map(s => chalk.cyan(s.name)).join(', '));
    console.log();

    // Perform sync
    syncSkillsToAgents(skills, enabledAgents);

    // Update registry timestamp
    if (!registry.config) {
      registry.config = {};
    }
    registry.config.lastSync = new Date().toISOString();
    writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');

    // Update AGENTS.md if not disabled
    if (!options.preserveAgents && !registry.config?.preserveAgentsMd) {
      updateAgentsMd(skills.map(s => s.name), registry);
    }

    // Display summary
    console.log();
    console.log(chalk.gray(`Synced ${skills.length} skill${skills.length !== 1 ? 's' : ''} to ${enabledAgents.length} agent${enabledAgents.length !== 1 ? 's' : ''}`));
    console.log();

  } catch (error) {
    if (error.message !== 'Registry not found') {
      console.error(chalk.red('✗ Error:'), error.message);
    }
    throw error;
  }
}

/**
 * Get all valid skills from dual sources: skills/ (root) and .skills/ (CLI-managed).
 * .skills/ takes priority — if the same skill name exists in both, .skills/ wins.
 *
 * @param {string} skillsDir - CLI-managed skills directory (.skills/)
 * @returns {{name: string, sourcePath: string}[]} List of valid skills with source paths
 */
function getValidSkills(skillsDir) {
  const skillMap = new Map();

  // Root skills/ (PR5.5 published format, lower priority)
  const rootSkillsDir = join(process.cwd(), 'skills');
  if (existsSync(rootSkillsDir)) {
    _collectSkillsFrom(rootSkillsDir, skillMap);
  }

  // .skills/ (CLI-managed, higher priority — overwrites root entries)
  if (existsSync(skillsDir)) {
    _collectSkillsFrom(skillsDir, skillMap);
  }

  return Array.from(skillMap.values());
}

/**
 * Collect valid skills from a directory into a Map (deduplication by name).
 * @param {string} dir - Directory to scan
 * @param {Map} skillMap - Map to collect into (later calls overwrite earlier)
 */
function _collectSkillsFrom(dir, skillMap) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    // Validate entry name (prevents path traversal)
    try {
      validateSkillName(entry);
    } catch (_error) {
      continue;
    }

    const skillPath = join(dir, entry);
    const skillMdPath = join(skillPath, 'SKILL.md');

    try {
      if (statSync(skillPath).isDirectory() && existsSync(skillMdPath)) {
        skillMap.set(entry, { name: entry, sourcePath: skillPath });
      }
    } catch (_error) {
      continue;
    }
  }
}

/**
 * Sync skills to agent directories
 * @param {{name: string, sourcePath: string}[]} skills - List of skills with source paths
 * @param {Array} enabledAgents - List of detected agents
 */
function syncSkillsToAgents(skills, enabledAgents) {
  for (const agent of enabledAgents) {
    const agentSkillsPath = join(process.cwd(), agent.path);
    mkdirSync(agentSkillsPath, { recursive: true });

    for (const skill of skills) {
      const targetPath = join(agentSkillsPath, skill.name);
      cpSync(skill.sourcePath, targetPath, { recursive: true, force: true });
    }

    console.log(chalk.green('✓'), `Synced to ${chalk.cyan(agent.name)}`);

    // Special handling: update Aider config with read: entries
    if (agent.configFile) {
      updateAiderConfig(agent, skills);
    }
  }
}

/**
 * Update Aider's config file to include read: entries for all skills.
 * Aider cannot auto-discover from a skills/ directory — it needs explicit read: paths.
 *
 * @param {Object} agent - Agent object with configFile and path properties
 * @param {{name: string, sourcePath: string}[]} skills - List of skills
 */
function updateAiderConfig(agent, skills) {
  const configPath = join(process.cwd(), agent.configFile);
  if (!existsSync(configPath)) return;

  const content = readFileSync(configPath, 'utf8');
  const readPaths = skills.map(s => `  - ${agent.path}/${s.name}/SKILL.md`).join('\n');

  // Replace existing read: section or append new one
  const readSection = `read:\n${readPaths}`;
  const updated = content.includes('read:')
    ? content.replace(/^read:[\s\S]*?(?=\n\w|\n#|$)/m, readSection)
    : content + `\n# Skills (auto-generated by skills sync)\n${readSection}\n`;

  writeFileSync(configPath, updated, 'utf8');
  console.log(chalk.green('✓'), `Updated ${chalk.cyan(agent.configFile)} with skill read paths`);
}

/**
 * Update AGENTS.md with skills information
 *
 * @param {string[]} skills - List of skill names
 * @param {Object} registry - Skills registry
 */
function updateAgentsMd(skills, registry) {
  const agentsMdPath = join(process.cwd(), 'AGENTS.md');

  // Create backup if AGENTS.md exists
  if (existsSync(agentsMdPath)) {
    const backupPath = join(process.cwd(), '.agents.md.backup');
    const content = readFileSync(agentsMdPath, 'utf8');
    writeFileSync(backupPath, content, 'utf8');
    console.log(chalk.gray('  Backup created: .agents.md.backup'));
  }

  // Generate AGENTS.md content
  let content = '# Agent Instructions\n\n';
  content += 'This file provides instructions for AI agents working in this project.\n\n';

  if (skills.length > 0) {
    content += '## Available Skills\n\n';

    // Ensure registry.skills exists
    const skills_registry = registry.skills || {};

    for (const skillName of skills) {
      const skillMeta = skills_registry[skillName];
      if (!skillMeta) continue;

      content += `### ${skillMeta.title}\n`;
      content += `**Command**: \`/skill ${skillName}\`\n`;
      content += `**Category**: ${skillMeta.category}\n\n`;
      content += `${skillMeta.description}\n\n`;
    }
  }

  content += '## Workflow Integration\n\n';
  content += 'See CLAUDE.md for the complete Forge workflow.\n';

  // Write AGENTS.md
  writeFileSync(agentsMdPath, content, 'utf8');
  console.log(chalk.green('✓'), 'Updated AGENTS.md');
}
