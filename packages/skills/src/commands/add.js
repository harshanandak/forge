/**
 * skills add - Install skill from Vercel registry
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import chalk from 'chalk';
import { downloadSkill } from '../lib/registry.js';
import { validateSkillName } from '../lib/validation.js';
import { syncCommand } from './sync.js';
import { getSkillPaths, ensureRegistryExists, updateRegistrySkill, handleNetworkError, logSuccess } from '../lib/common.js';

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

    // Get paths and ensure registry exists
    const { skillDir, skillMdPath, metaPath } = getSkillPaths(name);
    ensureRegistryExists();

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

    // Create skill directory and write files
    mkdirSync(skillDir, { recursive: true });

    // Write SKILL.md
    writeFileSync(skillMdPath, skillPackage.content, 'utf8');
    console.log(chalk.green('✓'), 'Downloaded SKILL.md');

    // Write .skill-meta.json
    const metadata = {
      ...skillPackage.metadata,
      installedFrom: 'registry',
      installedAt: new Date().toISOString()
    };
    writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
    console.log(chalk.green('✓'), 'Created metadata');

    // Update registry
    updateRegistrySkill(name, skillPackage.metadata, { source: 'registry' });
    console.log(chalk.green('✓'), 'Updated registry');

    // Sync to agents (unless disabled)
    if (!options.noSync) {
      console.log();
      await syncCommand({});
    }

    // Success message
    console.log();
    logSuccess('Installed', name, skillDir, {
      version: skillPackage.metadata.version,
      author: skillPackage.metadata.author
    });

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

    // Handle network/API errors
    handleNetworkError(error, 'download');
    throw error;
  }
}
