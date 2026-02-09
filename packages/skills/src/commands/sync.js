/**
 * skills sync - Synchronize skills to agent directories
 */

import { existsSync, readFileSync, writeFileSync, cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { detectAgents } from '../lib/agents.js';
import { validateSkillName } from '../lib/validation.js';

/**
 * Sync skills to agent directories
 */
export async function syncCommand(options) {
  try {
    const skillsDir = join(process.cwd(), '.skills');
    const registryPath = join(skillsDir, '.registry.json');

    // Check if registry exists
    if (!existsSync(registryPath)) {
      console.error(chalk.red('✗ Skills registry not found'));
      console.error(chalk.yellow('Run "skills init" first to initialize the registry'));
      throw new Error('Registry not found');
    }

    // Load registry
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

    // Get all valid skills (directories with SKILL.md)
    const skills = [];
    if (existsSync(skillsDir)) {
      const entries = readdirSync(skillsDir);
      for (const entry of entries) {
        // Validate entry name before processing (prevents path traversal)
        try {
          validateSkillName(entry);
        } catch (error) {
          // Skip invalid entries (e.g., .registry.json, malicious paths)
          continue;
        }

        const skillPath = join(skillsDir, entry);
        const skillMdPath = join(skillPath, 'SKILL.md');

        // Skip non-directories and directories without SKILL.md
        try {
          if (statSync(skillPath).isDirectory() && existsSync(skillMdPath)) {
            skills.push(entry);
          }
        } catch (error) {
          // Skip entries that cause errors (e.g., permission issues)
          continue;
        }
      }
    }

    // Check if there are skills to sync
    if (skills.length === 0) {
      console.log(chalk.yellow('No skills to sync'));
      console.log(chalk.gray('Create a skill with: skills create my-skill'));
      return;
    }

    // Detect agents
    const allAgents = detectAgents();
    const enabledAgents = allAgents.filter(agent => agent.enabled);

    // Check if there are agents
    if (enabledAgents.length === 0) {
      console.log(chalk.yellow('No agents detected'));
      console.log(chalk.gray('Supported agents: Cursor (.cursor), GitHub (.github)'));
      return;
    }

    // Sync skills to each enabled agent
    console.log(chalk.bold('\nSyncing skills to agents...'));
    console.log();

    // Display skills being synced
    console.log('Skills:', skills.map(s => chalk.cyan(s)).join(', '));
    console.log();

    for (const agent of enabledAgents) {
      const agentSkillsPath = join(process.cwd(), agent.path);

      // Create agent skills directory if needed
      mkdirSync(agentSkillsPath, { recursive: true });

      // Copy each skill
      for (const skill of skills) {
        const sourcePath = join(skillsDir, skill);
        const targetPath = join(agentSkillsPath, skill);

        // Copy entire skill directory (SKILL.md, .skill-meta.json, etc.)
        cpSync(sourcePath, targetPath, { recursive: true, force: true });
      }

      console.log(chalk.green('✓'), `Synced to ${chalk.cyan(agent.name)}`);
    }

    // Update registry with sync timestamp
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

    for (const skillName of skills) {
      const skillMeta = registry.skills[skillName];
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
