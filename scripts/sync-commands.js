#!/usr/bin/env node

/**
 * @module sync-commands
 *
 * Utility for parsing and rebuilding YAML frontmatter in
 * `.claude/commands/*.md` files.
 *
 * Exports:
 *   parseFrontmatter(content) -> { frontmatter: object, body: string }
 *   buildFile(frontmatter, body) -> string
 */

const YAML = require('yaml');

/**
 * Parse YAML frontmatter from a markdown string.
 *
 * Frontmatter is the YAML block between two `---` markers at the very start
 * of the file. If no valid frontmatter block is found, returns an empty object
 * with the full content as the body.
 *
 * @param {string} content - The raw file content
 * @returns {{ frontmatter: Record<string, unknown>, body: string }}
 */
function parseFrontmatter(content) {
  // Frontmatter must start at the very beginning with ---
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: {}, body: content };
  }

  // Find the closing --- marker (skip the opening one)
  const openLen = content.startsWith('---\r\n') ? 5 : 4; // '---\n' or '---\r\n'
  const closeIndex = content.indexOf('\n---\n', openLen - 1);
  const closeIndexCRLF = content.indexOf('\r\n---\r\n', openLen - 1);

  let yamlStr;
  let bodyStart;

  if (closeIndex === -1 && closeIndexCRLF === -1) {
    // Check for --- at end of file (no trailing newline after closing ---)
    const closeAtEnd = content.indexOf('\n---', openLen - 1);
    if (closeAtEnd !== -1 && closeAtEnd + 4 === content.length) {
      yamlStr = content.slice(openLen, closeAtEnd + 1);
      bodyStart = content.length;
    } else {
      // No closing --- found — no valid frontmatter
      return { frontmatter: {}, body: content };
    }
  } else if (closeIndex !== -1 && (closeIndexCRLF === -1 || closeIndex < closeIndexCRLF)) {
    // LF line endings
    yamlStr = content.slice(openLen, closeIndex + 1);
    bodyStart = closeIndex + 5; // skip '\n---\n'
  } else {
    // CRLF line endings
    yamlStr = content.slice(openLen, closeIndexCRLF + 2);
    bodyStart = closeIndexCRLF + 7; // skip '\r\n---\r\n'
  }

  // Parse the YAML string
  const trimmed = yamlStr.trim();
  if (trimmed === '') {
    return { frontmatter: {}, body: content.slice(bodyStart) };
  }

  /** @type {Record<string, unknown>} */
  let frontmatter;
  try {
    frontmatter = YAML.parse(trimmed);
  } catch (_err) {
    // If YAML parsing fails, treat as no frontmatter
    return { frontmatter: {}, body: content };
  }

  // YAML.parse can return null for empty docs or a scalar for non-object input
  if (frontmatter === null || typeof frontmatter !== 'object') {
    return { frontmatter: {}, body: content };
  }

  return { frontmatter, body: content.slice(bodyStart) };
}

/**
 * Build a file string from frontmatter and body.
 *
 * Produces output in the format:
 * ```
 * ---
 * key: value
 * ---
 * body content
 * ```
 *
 * @param {Record<string, unknown>} frontmatter - Key-value pairs for the YAML block
 * @param {string} body - The markdown body content
 * @returns {string} The reconstructed file content
 */
function buildFile(frontmatter, body) {
  const keys = Object.keys(frontmatter);

  let yamlBlock;
  if (keys.length === 0) {
    yamlBlock = '';
  } else {
    yamlBlock = YAML.stringify(frontmatter, {
      lineWidth: 0,       // Prevent line wrapping
      defaultKeyType: 'PLAIN',
      defaultStringType: 'PLAIN',
    }).trimEnd();
    yamlBlock += '\n';
  }

  return `---\n${yamlBlock}---\n${body}`;
}

module.exports = { parseFrontmatter, buildFile };
