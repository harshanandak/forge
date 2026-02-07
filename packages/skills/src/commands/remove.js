/**
 * skills remove - Remove a skill from .skills/ and agent directories
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { detectAgents } from '../lib/agents.js';

/**
 * Remove a skill
 */
export async function removeCommand(name, options) {
  try {
    // Validate skill name
    if (!name || name.trim() === '') {
      throw new Error('Skill name is required');
    }

    const skillsDir = join(process.cwd(), '.skills');
    const registryPath = join(skillsDir, '.registry.json');
    const skillDir = join(skillsDir, name);

    // Check if registry exists
    if (!existsSync(registryPath)) {
      console.error(chalk.red('✗ Skills registry not found'));
      console.error(chalk.yellow('Run "skills init" first to initialize the registry'));
      throw new Error('Registry not found');
    }

    // Load registry
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

    // Check if skill exists
    if (!existsSync(skillDir)) {
      throw new Error(`Skill not found: ${name}`);
    }

    // Remove skill directory from .skills/
    rmSync(skillDir, { recursive: true, force: true });

    // Remove from registry
    delete registry.skills[name];

    // Save updated registry
    writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');

    // Remove from agent directories
    const agents = detectAgents();
    const cleanedAgents = [];

    for (const agent of agents) {
      const agentSkillPath = join(process.cwd(), agent.path, name);

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
