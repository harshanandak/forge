/**
 * skills list - Show all installed skills
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';

/**
 * List all installed skills
 */
export async function listCommand(options) {
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
    let skills = Object.entries(registry.skills || {});

    // Filter by category if specified
    if (options.category) {
      skills = skills.filter(([_, skill]) => skill.category === options.category);
    }

    // Handle empty results
    if (skills.length === 0) {
      if (options.category) {
        console.log(chalk.yellow(`No skills found in category: ${options.category}`));
        console.log(chalk.gray('Available categories: research, coding, review, testing, deployment'));
      } else {
        console.log(chalk.yellow('No skills installed yet'));
        console.log();
        console.log('Create your first skill:');
        console.log(chalk.cyan('  skills create my-skill'));
      }
      return;
    }

    // Sort alphabetically by name
    skills.sort((a, b) => a[0].localeCompare(b[0]));

    // Display header
    console.log();
    console.log(chalk.bold('Installed Skills'));
    console.log();

    // Calculate column widths
    const nameWidth = Math.max(15, ...skills.map(([name]) => name.length));
    const categoryWidth = 12;
    const descWidth = 50;

    // Display table header
    const header = [
      chalk.bold('Name').padEnd(nameWidth + 10), // +10 for color codes
      chalk.bold('Category').padEnd(categoryWidth + 10),
      chalk.bold('Description')
    ].join('  ');
    console.log(header);
    console.log('─'.repeat(nameWidth + categoryWidth + descWidth + 4));

    // Display skills
    for (const [name, skill] of skills) {
      const categoryColor = getCategoryColor(skill.category);

      const row = [
        chalk.cyan(name).padEnd(nameWidth + 10),
        chalk[categoryColor](skill.category).padEnd(categoryWidth + 10),
        truncate(skill.description, descWidth)
      ].join('  ');

      console.log(row);
    }

    // Display summary
    console.log();
    console.log(chalk.gray(`${skills.length} skill${skills.length !== 1 ? 's' : ''} total`));
    console.log();

  } catch (error) {
    if (error.message !== 'Registry not found') {
      console.error(chalk.red('✗ Error:'), error.message);
    }
    throw error;
  }
}

/**
 * Get color for category
 */
function getCategoryColor(category) {
  const colors = {
    research: 'blue',
    coding: 'green',
    review: 'yellow',
    testing: 'magenta',
    deployment: 'red'
  };
  return colors[category] || 'white';
}

/**
 * Truncate string to max length
 */
function truncate(str, maxLength) {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 3) + '...';
}
