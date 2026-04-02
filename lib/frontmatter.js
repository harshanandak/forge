'use strict';

/**
 * @module frontmatter
 *
 * Utility for parsing and manipulating YAML frontmatter using gray-matter.
 *
 * This is the canonical frontmatter library for runtime code that needs
 * full gray-matter capabilities (e.g., commands-reset, plugin transforms).
 *
 * Note: scripts/sync-commands.js uses its own hand-rolled YAML parser
 * (via the `yaml` package) because sync runs at build time and must not
 * depend on gray-matter being installed in the target project.
 *
 * @example
 *   const { parse, stringify, stripAll, keepOnly } = require('./frontmatter');
 *   const { data, content } = parse(raw);
 *   const rebuilt = stringify(data, content);
 */

const matter = require('gray-matter');

/**
 * Parse YAML frontmatter from a markdown string.
 *
 * @param {string} content - Raw file content with optional frontmatter
 * @returns {{ data: Record<string, unknown>, content: string }}
 */
function parse(content) {
  const result = matter(content);
  return { data: result.data, content: result.content };
}

/**
 * Build a file string from frontmatter data and body content.
 *
 * @param {Record<string, unknown>} data - Key-value pairs for the YAML block
 * @param {string} content - The markdown body content
 * @returns {string}
 */
function stringify(data, content) {
  return matter.stringify(content, data);
}

/**
 * Strip all frontmatter, returning only the body content.
 *
 * @param {string} content - Raw file content with optional frontmatter
 * @returns {string} Body content without frontmatter
 */
function stripAll(content) {
  const result = matter(content);
  return result.content;
}

/**
 * Keep only specified fields in frontmatter, strip the rest.
 *
 * If none of the specified fields exist, returns body only (no frontmatter).
 *
 * @param {string} content - Raw file content with optional frontmatter
 * @param {string[]} fields - Field names to keep
 * @returns {string} Rebuilt file with filtered frontmatter
 */
function keepOnly(content, fields) {
  const result = matter(content);
  const filtered = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(result.data, field)) {
      filtered[field] = result.data[field];
    }
  }
  if (Object.keys(filtered).length === 0) {
    return result.content;
  }
  return matter.stringify(result.content, filtered);
}

module.exports = { parse, stringify, stripAll, keepOnly };
