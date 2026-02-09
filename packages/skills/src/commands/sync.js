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

    // Get all valid skills
    const skills = getValidSkills(skillsDir);
    if (skills.length === 0) {
      console.log(chalk.yellow('No skills to sync'));
      console.log(chalk.gray('Create a skill with: skills create my-skill'));
      return;
    }

    // Detect and filter enabled agents
    const enabledAgents = detectAgents().filter(agent => agent.enabled);
    if (enabledAgents.length === 0) {
      console.log(chalk.yellow('No agents detected'));
      console.log(chalk.gray('Supported agents: Cursor (.cursor), GitHub (.github)'));
      return;
    }

    // Display sync header
    console.log(chalk.bold('\nSyncing skills to agents...'));
    console.log();
    console.log('Skills:', skills.map(s => chalk.cyan(s)).join(', '));
    console.log();

    // Perform sync
    syncSkillsToAgents(skills, skillsDir, enabledAgents);

    // Update registry timestamp
    if (!registry.config) {
      registry.config = {};
    }
    registry.config.lastSync = new Date().toISOString();
    writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');

    // Update AGENTS.md if not disabled
    if (!options.preserveAgents && !registry.config?.preserveAgentsMd) {
      updateAgentsMd(skills, registry);
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
 * Get all valid skills from skills directory
 * @param {string} skillsDir - Skills directory path
 * @returns {string[]} List of valid skill names
 */
function getValidSkills(skillsDir) {
  const skills = [];

  if (!existsSync(skillsDir)) {
    return skills;
  }

  const entries = readdirSync(skillsDir);
  for (const entry of entries) {
    // Validate entry name before processing (prevents path traversal)
    try {
      validateSkillName(entry);
    } catch (error) {
      continue; // Skip invalid entries
    }

    const skillPath = join(skillsDir, entry);
    const skillMdPath = join(skillPath, 'SKILL.md');

    // Skip non-directories and directories without SKILL.md
    try {
      if (statSync(skillPath).isDirectory() && existsSync(skillMdPath)) {
        skills.push(entry);
      }
    } catch (error) {
      continue; // Skip entries that cause errors
    }
  }

  return skills;
}

/**
 * Sync skills to agent directories
 * @param {string[]} skills - List of skill names
 * @param {string} skillsDir - Skills directory path
 * @param {Array} enabledAgents - List of enabled agents
 */
function syncSkillsToAgents(skills, skillsDir, enabledAgents) {
  for (const agent of enabledAgents) {
    const agentSkillsPath = join(process.cwd(), agent.path);
    mkdirSync(agentSkillsPath, { recursive: true });

    for (const skill of skills) {
      const sourcePath = join(skillsDir, skill);
      const targetPath = join(agentSkillsPath, skill);
      cpSync(sourcePath, targetPath, { recursive: true, force: true });
    }

    console.log(chalk.green('✓'), `Synced to ${chalk.cyan(agent.name)}`);
  }
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
