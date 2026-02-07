/**
 * skills publish - Publish skill to Vercel registry
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { publishSkill, skillExists } from '../lib/registry.js';
import { validateSkillName } from '../lib/validation.js';
import { validateCommand } from './validate.js';

/**
 * Publish a skill to the Vercel registry
 *
 * @param {string} name - Skill name to publish
 * @param {Object} options - Publish options
 */
export async function publishCommand(name, options = {}) {
  try {
    // Validate skill name (prevents path traversal)
    validateSkillName(name);

    const skillsDir = join(process.cwd(), '.skills');
    const skillDir = join(skillsDir, name);
    const skillMdPath = join(skillDir, 'SKILL.md');
    const metaPath = join(skillDir, '.skill-meta.json');

    // Check if skill exists locally
    if (!existsSync(skillDir)) {
      console.error(chalk.red('✗ Skill not found:'), name);
      console.error(chalk.yellow(`  Create it first: skills create ${name}`));
      throw new Error(`Skill not found: ${name}`);
    }

    if (!existsSync(skillMdPath)) {
      console.error(chalk.red('✗ SKILL.md not found in:'), skillDir);
      throw new Error('SKILL.md not found');
    }

    console.log(chalk.bold(`\nPublishing skill to Vercel registry...`));
    console.log(chalk.gray(`  Skill: ${name}`));
    console.log();

    // Validate skill first
    console.log('📋 Validating skill...');
    const validation = await validateCommand(name);

    if (!validation.valid) {
      console.error(chalk.red('✗ Skill validation failed'));
      console.error(chalk.yellow('  Fix validation errors before publishing'));
      throw new Error('Validation failed');
    }

    // Read SKILL.md
    const content = readFileSync(skillMdPath, 'utf8');

    // Read metadata
    let metadata;
    if (existsSync(metaPath)) {
      metadata = JSON.parse(readFileSync(metaPath, 'utf8'));
    } else {
      // Extract from SKILL.md frontmatter
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) {
        throw new Error('SKILL.md frontmatter not found');
      }

      const yaml = await import('js-yaml');
      metadata = yaml.load(frontmatterMatch[1], { schema: yaml.JSON_SCHEMA });
    }

    // Check if skill already exists in registry (unless force)
    if (!options.force) {
      console.log('🔍 Checking registry...');
      const exists = await skillExists(name);

      if (exists) {
        console.error(chalk.red('✗ Skill already published:'), name);
        console.error(chalk.yellow('  Use --force to overwrite (publish new version)'));
        throw new Error(`Skill already exists in registry: ${name}`);
      }
    }

    // Create skill package
    const skillPackage = {
      name,
      version: metadata.version || '1.0.0',
      title: metadata.title,
      description: metadata.description,
      category: metadata.category,
      author: metadata.author || 'Anonymous',
      tags: metadata.tags || [],
      content,
      metadata,
      publishedAt: new Date().toISOString()
    };

    // Publish to registry
    console.log('📦 Uploading to Vercel registry...');
    const result = await publishSkill(skillPackage);

    // Success message
    console.log();
    console.log(chalk.green('✓'), `Published skill: ${chalk.bold(name)}`);
    console.log(chalk.gray(`  Version: ${skillPackage.version}`));
    console.log(chalk.gray(`  Registry URL: https://skills.sh/${name}`));

    if (result.url) {
      console.log(chalk.gray(`  View: ${result.url}`));
    }

    console.log();

    // Next steps
    console.log('Share with others:');
    console.log(chalk.white(`  skills add ${name}`));
    console.log();

  } catch (error) {
    if (error.message === 'Skill not found: ' + name || error.message === 'Validation failed') {
      // Already logged
      throw error;
    }

    // API key errors
    if (error.message.includes('API key required')) {
      console.error(chalk.red('✗ API key required for publishing'));
      console.error();
      console.error('Set your API key:');
      console.error(chalk.white('  export SKILLS_API_KEY=<your-key>'));
      console.error(chalk.gray('  or'));
      console.error(chalk.white('  skills config set api-key <your-key>'));
      console.error();
      console.error('Get API key: https://skills.sh/settings/api-keys');
      console.error();
    }
    // Network/API errors
    else if (error.message.includes('Registry API error') || error.message.includes('fetch')) {
      console.error(chalk.red('✗ Failed to publish skill'));
      console.error(chalk.yellow('  Check your internet connection and registry availability'));
      console.error(chalk.gray(`  Error: ${error.message}`));
    } else {
      console.error(chalk.red('✗ Error:'), error.message);
    }

    throw error;
  }
}
