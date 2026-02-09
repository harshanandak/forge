/**
 * skills list - Show all installed skills
 */

import chalk from 'chalk';
import { ensureRegistryExists, readRegistry } from '../lib/common.js';

/**
 * List all installed skills
 */
export async function listCommand(options) {
  try {
    // Ensure registry exists and load it (with graceful error handling)
    ensureRegistryExists();
    const registry = readRegistry();
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

    // Display table header (pad first, then colorize)
    const header = [
      chalk.bold('Name'.padEnd(nameWidth)),
      chalk.bold('Category'.padEnd(categoryWidth)),
      chalk.bold('Description')
    ].join('  ');
    console.log(header);
    console.log('─'.repeat(nameWidth + categoryWidth + descWidth + 4));

    // Display skills (pad first, then colorize)
    for (const [name, skill] of skills) {
      const categoryColor = getCategoryColor(skill.category);

      const row = [
        chalk.cyan(name.padEnd(nameWidth)),
        chalk[categoryColor](skill.category.padEnd(categoryWidth)),
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
