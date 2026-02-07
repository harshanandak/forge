/**
 * skills validate - Validate SKILL.md format and content
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import chalk from 'chalk';
import { validateSkillName, ensurePathWithin } from '../lib/validation.js';

/**
 * Valid skill categories
 */
const VALID_CATEGORIES = ['research', 'coding', 'review', 'testing', 'deployment'];

/**
 * Required YAML frontmatter fields
 */
const REQUIRED_FIELDS = ['title', 'description', 'category'];

/**
 * Validate a skill's SKILL.md file
 *
 * @param {string} name - Skill name
 * @returns {Object} Validation result { valid: boolean, errors: string[] }
 */
export async function validateCommand(name) {
  const errors = [];

  try {
    // Validate skill name (prevents path traversal attacks)
    validateSkillName(name);

    const skillsDir = join(process.cwd(), '.skills');
    const skillDir = join(skillsDir, name);
    const skillMdPath = join(skillDir, 'SKILL.md');

    // Ensure paths are within .skills/ directory (defense in depth)
    ensurePathWithin(skillsDir, skillDir);
    ensurePathWithin(skillDir, skillMdPath);

    // Check if SKILL.md exists
    if (!existsSync(skillMdPath)) {
      errors.push('SKILL.md not found');
      console.error(chalk.red('✗ SKILL.md not found'));
      return { valid: false, errors };
    }

    // Read SKILL.md
    const content = readFileSync(skillMdPath, 'utf8');

    // Extract YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

    if (!frontmatterMatch) {
      errors.push('YAML frontmatter not found (must start with --- and end with ---)');
      console.error(chalk.red('✗ Invalid format'));
      console.error(chalk.gray('  YAML frontmatter not found'));
      return { valid: false, errors };
    }

    // Parse YAML with safe schema (prevents YAML injection attacks)
    let metadata;
    try {
      metadata = yaml.load(frontmatterMatch[1], { schema: yaml.JSON_SCHEMA });
    } catch (yamlError) {
      errors.push(`YAML parse error: ${yamlError.message}`);
      console.error(chalk.red('✗ Invalid YAML'));
      console.error(chalk.gray(`  ${yamlError.message}`));
      return { valid: false, errors };
    }

    // Validate required fields
    for (const field of REQUIRED_FIELDS) {
      if (!metadata[field]) {
        errors.push(`Required field missing: ${field}`);
      }
    }

    // Validate category
    if (metadata.category && !VALID_CATEGORIES.includes(metadata.category)) {
      errors.push(`Invalid category: ${metadata.category} (must be one of: ${VALID_CATEGORIES.join(', ')})`);
    }

    // Display results
    if (errors.length > 0) {
      console.error(chalk.red('✗ Validation failed'));
      console.error();
      for (const error of errors) {
        console.error(chalk.gray(`  • ${error}`));
      }
      console.error();
      return { valid: false, errors };
    }

    // Success
    console.log(chalk.green('✓ Valid skill'));
    console.log(chalk.gray(`  Title: ${metadata.title}`));
    console.log(chalk.gray(`  Category: ${metadata.category}`));
    console.log();

    return { valid: true, errors: [] };

  } catch (error) {
    errors.push(error.message);
    console.error(chalk.red('✗ Error:'), error.message);
    return { valid: false, errors };
  }
}
