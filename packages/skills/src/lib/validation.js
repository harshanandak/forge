/**
 * Shared validation utilities for skills CLI
 *
 * Security-critical functions for preventing path traversal and injection attacks
 */

import { resolve, sep } from 'node:path';

/**
 * Regex for valid skill names
 * Only allows: lowercase letters, numbers, hyphens, underscores
 * Prevents: path traversal (/, \, ..), absolute paths, uppercase
 */
const SKILL_NAME_REGEX = /^[a-z0-9-_]+$/;

/**
 * Maximum allowed length for skill names
 * Prevents DoS via extremely long names
 */
const MAX_SKILL_NAME_LENGTH = 100;

/**
 * Validate a skill name to prevent path traversal and injection attacks
 *
 * @param {string} name - Skill name to validate
 * @returns {boolean} true if valid
 * @throws {Error} If skill name is invalid
 *
 * @example
 * validateSkillName('my-skill'); // OK
 * validateSkillName('../etc'); // Throws Error
 * validateSkillName('MY-SKILL'); // Throws Error (uppercase not allowed)
 */
export function validateSkillName(name) {
  // Check for null, undefined, empty string
  if (!name || typeof name !== 'string') {
    throw new Error('Skill name is required');
  }

  // Check length to prevent DoS
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    throw new Error(`Skill name too long (max ${MAX_SKILL_NAME_LENGTH} characters)`);
  }

  // Validate against allowed character set
  // This prevents:
  // - Path traversal: ../, ..\, /etc, C:\
  // - Directory separators: /, \
  // - Uppercase letters (convention is lowercase)
  // - Special characters that could cause issues
  if (!SKILL_NAME_REGEX.test(name)) {
    throw new Error('Invalid skill name: Use lowercase letters, numbers, hyphens, and underscores only');
  }

  return true;
}

/**
 * Ensure a target path is within a base directory
 *
 * Prevents path traversal attacks by verifying the resolved target path
 * is actually within the base directory after normalizing both paths.
 *
 * @param {string} basePath - Base directory path (e.g., /home/user/.skills)
 * @param {string} targetPath - Target path to validate
 * @returns {string} The resolved target path if valid
 * @throws {Error} If path traversal is detected
 *
 * @example
 * ensurePathWithin('/home/user/.skills', '/home/user/.skills/my-skill'); // OK
 * ensurePathWithin('/home/user/.skills', '/etc/passwd'); // Throws Error
 * ensurePathWithin('/home/user/.skills', '/home/user/.skills/../../../etc'); // Throws Error
 */
export function ensurePathWithin(basePath, targetPath) {
  // Resolve to absolute, normalized paths
  // This handles:
  // - Relative paths (./foo)
  // - Traversal sequences (../)
  // - Redundant separators (foo//bar)
  // - Symbolic links (if they exist)
  const resolvedBase = resolve(basePath);
  const resolvedTarget = resolve(targetPath);

  // Check if resolved target starts with the base path
  // Must include separator to prevent false positives like:
  //   base: /home/user/.skills
  //   target: /home/user/.skills-malicious
  // The separator ensures we're checking directory boundaries
  // Allow exact match (resolvedTarget === resolvedBase) for the base directory itself
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + sep)) {
    throw new Error('Path traversal detected');
  }

  return resolvedTarget;
}
