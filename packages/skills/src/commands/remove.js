/**
 * skills remove - Remove a skill from .skills/ and agent directories
 */

import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { detectAgents } from '../lib/agents.js';
import { validateSkillName, ensurePathWithin } from '../lib/validation.js';
import { getSkillPaths, ensureRegistryExists, removeFromRegistry } from '../lib/common.js';

/**
 * Remove a skill
 */
export async function removeCommand(name, options) {
  try {
    // Validate skill name (prevents path traversal attacks)
    validateSkillName(name);

    // Get paths and ensure registry exists
    const { skillsDir, skillDir } = getSkillPaths(name);
    ensureRegistryExists();

    // Ensure skill directory is within .skills/ (defense in depth)
    ensurePathWithin(skillsDir, skillDir);

    // Check if skill exists
    if (!existsSync(skillDir)) {
      throw new Error(`Skill not found: ${name}`);
    }

    // Remove skill directory from .skills/
    rmSync(skillDir, { recursive: true, force: true });

    // Remove from registry
    removeFromRegistry(name);

    // Remove from agent directories
    const agents = detectAgents();
    const cleanedAgents = [];

    for (const agent of agents) {
      const agentSkillsDir = join(process.cwd(), agent.path);
      const agentSkillPath = join(agentSkillsDir, name);

      // Ensure agent skill path is within agent directory (defense in depth)
      try {
        ensurePathWithin(agentSkillsDir, agentSkillPath);
      } catch (error) {
        console.error(chalk.yellow(`⚠ Skipping agent ${agent.name}: ${error.message}`));
        continue;
      }

      if (existsSync(agentSkillPath)) {
        rmSync(agentSkillPath, { recursive: true, force: true });
        cleanedAgents.push(agent.name);
      }
    }

    // Success message
    console.log(chalk.green('✓'), `Removed skill: ${chalk.bold(name)}`);

    if (cleanedAgents.length > 0) {
      console.log(chalk.gray(`  Cleaned from agents: ${cleanedAgents.join(', ')}`));
    }

    console.log();

  } catch (error) {
    if (error.message !== 'Registry not found') {
      console.error(chalk.red('✗ Error:'), error.message);
    }
    throw error;
  }
}
