/**
 * skills add - Install skill from Vercel registry
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { downloadSkill } from '../lib/registry.js';
import { validateSkillName } from '../lib/validation.js';
import { syncCommand } from './sync.js';

/**
 * Add (install) a skill from the registry
 *
 * @param {string} name - Skill name to install
 * @param {Object} options - Command options
 */
export async function addCommand(name, options = {}) {
  try {
    // Validate skill name (prevents path traversal)
    validateSkillName(name);

    const skillsDir = join(process.cwd(), '.skills');
    const registryPath = join(skillsDir, '.registry.json');
    const skillDir = join(skillsDir, name);

    // Check if registry exists
    if (!existsSync(registryPath)) {
      console.error(chalk.red('✗ Skills registry not found'));
      console.error(chalk.yellow('Run "skills init" first to initialize the registry'));
      throw new Error('Registry not found');
    }

    // Check if skill already exists locally
    if (existsSync(skillDir) && !options.force) {
      console.error(chalk.red('✗ Skill already exists:'), name);
      console.error(chalk.yellow('Use --force to overwrite'));
      throw new Error(`Skill already exists: ${name}`);
    }

    console.log(chalk.bold(`\nInstalling skill from registry...`));
    console.log(chalk.gray(`  Skill: ${name}`));
    console.log();

    // Download skill package from registry
    console.log('📦 Downloading from Vercel registry...');
    const skillPackage = await downloadSkill(name);

    if (!skillPackage || !skillPackage.content || !skillPackage.metadata) {
      throw new Error('Invalid skill package received from registry');
    }

    // Create skill directory
    mkdirSync(skillDir, { recursive: true });

    // Write SKILL.md
    const skillMdPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillMdPath, skillPackage.content, 'utf8');
    console.log(chalk.green('✓'), 'Downloaded SKILL.md');

    // Write .skill-meta.json
    const metaPath = join(skillDir, '.skill-meta.json');
    const metadata = {
      ...skillPackage.metadata,
      installedFrom: 'registry',
      installedAt: new Date().toISOString()
    };
    writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
    console.log(chalk.green('✓'), 'Created metadata');

    // Update registry
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.skills[name] = {
      title: skillPackage.metadata.title,
      description: skillPackage.metadata.description,
      category: skillPackage.metadata.category,
      author: skillPackage.metadata.author,
      version: skillPackage.metadata.version,
      created: skillPackage.metadata.created,
      updated: new Date().toISOString(),
      source: 'registry'
    };
    writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');
    console.log(chalk.green('✓'), 'Updated registry');

    // Sync to agents (unless disabled)
    if (!options.noSync) {
      console.log();
      await syncCommand({});
    }

    // Success message
    console.log();
    console.log(chalk.green('✓'), `Installed skill: ${chalk.bold(name)}`);
    console.log(chalk.gray(`  Location: ${skillDir}`));
    console.log(chalk.gray(`  Version: ${skillPackage.metadata.version}`));
    console.log(chalk.gray(`  Author: ${skillPackage.metadata.author}`));
    console.log();

    // Next steps
    console.log('Next steps:');
    console.log(`  - View: cat ${skillMdPath}`);
    console.log(`  - List: skills list`);
    console.log(`  - Validate: skills validate ${name}`);
    console.log();

  } catch (error) {
    if (error.message === 'Registry not found') {
      // Already logged
      throw error;
    }

    // Network/API errors
    if (error.message.includes('Registry API error') || error.message.includes('fetch')) {
      console.error(chalk.red('✗ Failed to download skill'));
      console.error(chalk.yellow('  Check your internet connection and registry availability'));
      console.error(chalk.gray(`  Error: ${error.message}`));
    } else {
      console.error(chalk.red('✗ Error:'), error.message);
    }

    throw error;
  }
}
