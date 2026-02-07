/**
 * skills create - Create new skill from template
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { loadTemplate, renderTemplate, getCurrentDate, getCurrentTimestamp } from '../lib/template.js';
import { syncCommand } from './sync.js';

/**
 * Validate skill name (alphanumeric, hyphens, underscores only)
 */
function validateSkillName(name) {
  const validNameRegex = /^[a-z0-9-_]+$/;
  if (!validNameRegex.test(name)) {
    throw new Error('Invalid skill name: Use lowercase letters, numbers, hyphens, and underscores only');
  }
  return true;
}

/**
 * Create new skill from template
 */
export async function createCommand(name, options) {
  try {
    // Validate skill name
    validateSkillName(name);

    const skillsDir = join(process.cwd(), '.skills');
    const skillDir = join(skillsDir, name);
    const registryPath = join(skillsDir, '.registry.json');

    // Check if .skills/ exists
    if (!existsSync(skillsDir)) {
      console.error(chalk.red('✗ Skills directory not found'));
      console.error(chalk.yellow('Run "skills init" first to initialize the registry'));
      process.exit(1);
    }

    // Check if skill already exists
    if (existsSync(skillDir)) {
      throw new Error(`Skill already exists: ${name}`);
    }

    // Get skill metadata (interactive or from options)
    let metadata;
    if (options.nonInteractive) {
      // Use provided options (for testing)
      metadata = {
        title: options.title || name,
        description: options.description || '',
        category: options.category || 'coding',
        author: options.author || 'Unknown',
        tags: options.tags || []
      };
    } else {
      // Interactive prompts
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'title',
          message: 'Skill title:',
          default: name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        },
        {
          type: 'input',
          name: 'description',
          message: 'Short description:',
          validate: (input) => input.length > 0 || 'Description is required'
        },
        {
          type: 'list',
          name: 'category',
          message: 'Category:',
          choices: ['research', 'coding', 'review', 'testing', 'deployment'],
          default: 'coding'
        },
        {
          type: 'input',
          name: 'author',
          message: 'Author:',
          default: process.env.USER || process.env.USERNAME || 'Unknown'
        },
        {
          type: 'input',
          name: 'tags',
          message: 'Tags (comma-separated):',
          filter: (input) => input.split(',').map(t => t.trim()).filter(t => t.length > 0)
        }
      ]);

      metadata = answers;
    }

    // Load and render template
    const templateName = options.template || 'default';
    const template = loadTemplate(templateName);

    const currentDate = getCurrentDate();
    const variables = {
      title: metadata.title,
      description: metadata.description,
      category: metadata.category,
      author: metadata.author,
      created: currentDate,
      updated: currentDate
    };

    const renderedSkill = renderTemplate(template, variables);

    // Create skill directory
    mkdirSync(skillDir, { recursive: true });

    // Write SKILL.md
    const skillMdPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillMdPath, renderedSkill, 'utf8');

    // Create .skill-meta.json
    const skillMeta = {
      id: name,
      title: metadata.title,
      description: metadata.description,
      category: metadata.category,
      version: '1.0.0',
      author: metadata.author,
      created: getCurrentTimestamp(),
      updated: getCurrentTimestamp(),
      tags: metadata.tags || [],
      usage: {
        invocations: 0,
        lastUsed: null
      }
    };

    const metaPath = join(skillDir, '.skill-meta.json');
    writeFileSync(metaPath, JSON.stringify(skillMeta, null, 2), 'utf8');

    // Update registry
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.skills[name] = {
      title: metadata.title,
      description: metadata.description,
      category: metadata.category,
      author: metadata.author,
      created: currentDate,
      updated: currentDate
    };
    writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');

    // Success message
    console.log(chalk.green('✓ Created skill:'), chalk.bold(name));
    console.log(chalk.gray(`  Location: ${skillDir}`));
    console.log(chalk.gray(`  Template: ${templateName}`));

    // Auto-sync to agents (unless --no-sync flag is set)
    if (!options.noSync) {
      console.log();
      await syncCommand({});
    }

    console.log();
    console.log('Next steps:');
    console.log(chalk.cyan('  - Edit:'), `${skillMdPath}`);
    console.log(chalk.cyan('  - List:'), 'skills list');

  } catch (error) {
    console.error(chalk.red('✗ Error:'), error.message);
    throw error; // Re-throw for tests
  }
}
