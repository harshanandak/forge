/**
 * CRUD module for .github/beads-mapping.json
 *
 * Maps GitHub issue numbers (string keys) to Beads issue IDs.
 * Format: { "42": "forge-abc", "7": "forge-xyz" }
 *
 * @module mapping
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads the mapping file and returns parsed JSON.
 * Returns {} if the file does not exist.
 * Throws with a helpful message if JSON is invalid.
 *
 * @param {string} mappingPath - Absolute path to the mapping JSON file
 * @returns {Record<string, string>} The mapping object
 */
export function readMapping(mappingPath) {
  if (!fs.existsSync(mappingPath)) {
    return {};
  }
  const raw = fs.readFileSync(mappingPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse mapping file at ${mappingPath}: ${err.message}`, { cause: err });
  }
}

/**
 * Writes the mapping object to disk as JSON with 2-space indent.
 * Atomic: writes to a temp file then renames.
 * Creates parent directories if they do not exist.
 *
 * @param {string} mappingPath - Absolute path to the mapping JSON file
 * @param {Record<string, string>} data - The mapping object to write
 */
export function writeMapping(mappingPath, data) {
  const dir = path.dirname(mappingPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = mappingPath + '.tmp';
  const content = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, mappingPath);
}

/**
 * Returns the Beads ID for a given GitHub issue number, or null if not found.
 * Coerces numeric issueNumber to string for lookup.
 *
 * @param {string} mappingPath - Absolute path to the mapping JSON file
 * @param {string|number} issueNumber - The GitHub issue number
 * @returns {string|null} The Beads ID or null
 */
export function getBeadsId(mappingPath, issueNumber) {
  const data = readMapping(mappingPath);
  const key = String(issueNumber);
  return data[key] ?? null;
}

/**
 * Adds or updates a mapping entry. Reads existing data, merges, and writes back.
 * Preserves all existing entries.
 *
 * @param {string} mappingPath - Absolute path to the mapping JSON file
 * @param {string|number} issueNumber - The GitHub issue number
 * @param {string} beadsId - The Beads issue ID
 */
export function setBeadsId(mappingPath, issueNumber, beadsId) {
  const data = readMapping(mappingPath);
  const key = String(issueNumber);
  data[key] = beadsId;
  writeMapping(mappingPath, data);
}
