/**
 * Template loading and rendering utilities
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load a skill template by name
 * @param {string} templateName - Template name (default, research, coding, review, testing, deployment)
 * @returns {string} Template content
 * @throws {Error} If template not found
 */
export function loadTemplate(templateName) {
  const validTemplates = ['default', 'research', 'coding', 'review', 'testing', 'deployment'];

  if (!validTemplates.includes(templateName)) {
    throw new Error(`Invalid template: ${templateName}. Valid templates: ${validTemplates.join(', ')}`);
  }

  const templatePath = join(__dirname, '../../templates', `${templateName}.md`);

  try {
    return readFileSync(templatePath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to load template ${templateName}: ${error.message}`);
  }
}

/**
 * Render a template with variable substitution
 * @param {string} template - Template content with {{variable}} placeholders
 * @param {Object} variables - Key-value pairs for substitution
 * @returns {string} Rendered template
 */
export function renderTemplate(template, variables) {
  let rendered = template;

  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{{${key}}}`;
    const regex = new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    rendered = rendered.replace(regex, value);
  }

  return rendered;
}

/**
 * Get current date in ISO format (YYYY-MM-DD)
 * @returns {string} Current date
 */
export function getCurrentDate() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get current timestamp in ISO format
 * @returns {string} Current timestamp
 */
export function getCurrentTimestamp() {
  return new Date().toISOString();
}
