/**
 * skills search - Search Vercel registry
 */

import chalk from 'chalk';
import { searchSkills } from '../lib/registry.js';

/**
 * Search for skills in the registry
 *
 * @param {string} query - Search query
 * @param {Object} options - Search options (category, author, etc.)
 */
export async function searchCommand(query, options = {}) {
  try {
    console.log(chalk.bold(`\nSearching Vercel registry...`));
    console.log(chalk.gray(`  Query: "${query}"`));
    if (options.category) {
      console.log(chalk.gray(`  Category: ${options.category}`));
    }
    console.log();

    // Build search filters
    const filters = {};
    if (options.category) {
      filters.category = options.category;
    }
    if (options.author) {
      filters.author = options.author;
    }

    // Search registry
    const results = await searchSkills(query, filters);

    if (!results || results.length === 0) {
      console.log(chalk.yellow('No skills found'));
      console.log();
      console.log('Try:');
      console.log('  - Different search terms');
      console.log('  - Removing category filter');
      console.log('  - Browse all: skills search "*"');
      console.log();
      return;
    }

    // Display results
    console.log(chalk.bold(`Found ${results.length} skill${results.length !== 1 ? 's' : ''}:`));
    console.log();

    for (const skill of results) {
      console.log(chalk.cyan.bold(skill.name), chalk.gray(`(v${skill.version})`));
      console.log(chalk.gray(`  ${skill.description}`));
      console.log(chalk.gray(`  Category: ${skill.category} | Author: ${skill.author}`));

      if (skill.downloads) {
        console.log(chalk.gray(`  Downloads: ${skill.downloads}`));
      }

      console.log(chalk.gray(`  Install: ${chalk.white(`skills add ${skill.name}`)}`));
      console.log();
    }

    // Summary
    console.log(chalk.gray('─'.repeat(50)));
    console.log(chalk.gray(`Total: ${results.length} results`));
    console.log();

  } catch (error) {
    // Network/API errors
    if (error.message.includes('Registry API error') || error.message.includes('fetch')) {
      console.error(chalk.red('✗ Failed to search registry'));
      console.error(chalk.yellow('  Check your internet connection and registry availability'));
      console.error(chalk.gray(`  Error: ${error.message}`));
    } else {
      console.error(chalk.red('✗ Error:'), error.message);
    }

    throw error;
  }
}
