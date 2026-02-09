/**
 * Common utility functions for skills commands
 * Reduces code duplication across command files
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

/**
 * Get standard skill paths
 * @param {string} name - Skill name
 * @returns {Object} Path objects
 */
export function getSkillPaths(name) {
  const skillsDir = join(process.cwd(), '.skills');
  const registryPath = join(skillsDir, '.registry.json');
  const skillDir = join(skillsDir, name);
  const skillMdPath = join(skillDir, 'SKILL.md');
  const metaPath = join(skillDir, '.skill-meta.json');

  return {
    skillsDir,
    registryPath,
    skillDir,
    skillMdPath,
    metaPath
  };
}

/**
 * Ensure registry exists
 * @throws {Error} If registry doesn't exist
 */
export function ensureRegistryExists() {
  const { skillsDir, registryPath } = getSkillPaths('');

  if (!existsSync(skillsDir)) {
    console.error(chalk.red('✗ Skills directory not found'));
    console.error(chalk.yellow('Run "skills init" first to initialize the registry'));
    throw new Error('Registry not found');
  }

  if (!existsSync(registryPath)) {
    console.error(chalk.red('✗ Skills registry not found'));
    console.error(chalk.yellow('Run "skills init" first to initialize the registry'));
    throw new Error('Registry not found');
  }
}

/**
 * Read registry file
 * @returns {Object} Registry data
 */
export function readRegistry() {
  const { registryPath } = getSkillPaths('');
  return JSON.parse(readFileSync(registryPath, 'utf8'));
}

/**
 * Write registry file
 * @param {Object} registry - Registry data
 */
export function writeRegistry(registry) {
  const { registryPath } = getSkillPaths('');
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');
}

/**
 * Update registry with skill metadata
 * @param {string} name - Skill name
 * @param {Object} metadata - Skill metadata
 * @param {Object} options - Additional options (source, etc.)
 */
export function updateRegistrySkill(name, metadata, options = {}) {
  const registry = readRegistry();

  registry.skills[name] = {
    title: metadata.title,
    description: metadata.description,
    category: metadata.category,
    author: metadata.author,
    version: metadata.version || '1.0.0',
    created: metadata.created || new Date().toISOString(),
    updated: new Date().toISOString(),
    ...(options.source && { source: options.source })
  };

  writeRegistry(registry);
}

/**
 * Remove skill from registry
 * @param {string} name - Skill name
 */
export function removeFromRegistry(name) {
  const registry = readRegistry();
  delete registry.skills[name];
  writeRegistry(registry);
}

/**
 * Handle network/API errors with consistent messaging
 * @param {Error} error - Error object
 * @param {string} action - Action that failed (e.g., 'download', 'publish')
 */
export function handleNetworkError(error, action) {
  if (error.message.includes('Registry API error') || error.message.includes('fetch')) {
    console.error(chalk.red(`✗ Failed to ${action} skill`));
    console.error(chalk.yellow('  Check your internet connection and registry availability'));
    console.error(chalk.gray(`  Error: ${error.message}`));
  } else if (error.message.includes('API key required')) {
    console.error(chalk.red('✗ API key required for publishing'));
    console.error();
    console.error('Set your API key:');
    console.error(chalk.white('  export SKILLS_API_KEY=<your-key>'));
    console.error(chalk.gray('  or'));
    console.error(chalk.white('  skills config set api-key <your-key>'));
    console.error();
    console.error('Get API key: https://skills.sh/settings/api-keys');
    console.error();
  } else {
    console.error(chalk.red('✗ Error:'), error.message);
  }
}

/**
 * Log success message for skill creation/installation
 * @param {string} action - Action performed (e.g., 'Created', 'Installed')
 * @param {string} name - Skill name
 * @param {string} location - Skill directory path
 * @param {Object} metadata - Additional metadata to display
 */
export function logSuccess(action, name, location, metadata = {}) {
  console.log(chalk.green('✓'), `${action} skill: ${chalk.bold(name)}`);
  console.log(chalk.gray(`  Location: ${location}`));

  if (metadata.version) {
    console.log(chalk.gray(`  Version: ${metadata.version}`));
  }
  if (metadata.author) {
    console.log(chalk.gray(`  Author: ${metadata.author}`));
  }
  if (metadata.template) {
    console.log(chalk.gray(`  Template: ${metadata.template}`));
  }

  console.log();
}
