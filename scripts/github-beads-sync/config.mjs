/**
 * Config loader for GitHub-Beads issue sync.
 * @module scripts/github-beads-sync/config
 */

import { readFileSync } from 'node:fs';

/**
 * Default configuration for GitHub-Beads sync.
 * @type {Readonly<SyncConfig>}
 */
export const DEFAULT_CONFIG = Object.freeze({
  labelToType: Object.freeze({
    bug: 'bug',
    enhancement: 'feature',
    documentation: 'task',
    question: 'task',
  }),
  labelToPriority: Object.freeze({
    P0: 0, critical: 0,
    P1: 1, high: 1,
    P2: 2, medium: 2,
    P3: 3, low: 3,
    P4: 4, backlog: 4,
  }),
  defaultType: 'task',
  defaultPriority: 2,
  mapAssignee: true,
  publicRepoGate: 'none',
  gateLabelName: 'beads-track',
  gateAssociations: Object.freeze(['MEMBER', 'COLLABORATOR', 'OWNER']),
});

/**
 * Deep-merge source into target (one level of nesting).
 * Arrays and scalars from source overwrite target.
 * Plain objects are merged key-by-key.
 * @param {object} target
 * @param {object} source
 * @returns {object} Merged result (new object)
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = { ...tgtVal, ...srcVal };
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Clone DEFAULT_CONFIG into a mutable plain object.
 * @returns {object}
 */
function cloneDefaults() {
  return {
    ...DEFAULT_CONFIG,
    labelToType: { ...DEFAULT_CONFIG.labelToType },
    labelToPriority: { ...DEFAULT_CONFIG.labelToPriority },
    gateAssociations: [...DEFAULT_CONFIG.gateAssociations],
  };
}

/**
 * Load and validate sync configuration.
 * - No arguments: returns a copy of DEFAULT_CONFIG.
 * - With path: reads JSON file and deep-merges with defaults (user overrides win).
 * - Missing file: returns defaults (no throw).
 * - Invalid JSON: throws with helpful message.
 *
 * @param {string} [configPath] - Path to a JSON config file.
 * @returns {object} Merged configuration object.
 */
export function loadConfig(configPath) {
  if (!configPath) {
    return cloneDefaults();
  }

  let raw;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    // File not found or unreadable — return defaults
    return cloneDefaults();
  }

  let userConfig;
  try {
    userConfig = JSON.parse(raw);
  } catch (parseErr) {
    throw new Error(
      `Invalid JSON in config file: ${configPath}\n` +
      `Parse error: ${parseErr.message}`,
      { cause: parseErr }
    );
  }

  const merged = deepMerge(cloneDefaults(), userConfig);
  return validateConfig(merged);
}

/**
 * Validate and normalize config values.
 * Replaces invalid types with defaults rather than throwing.
 * @param {object} cfg
 * @returns {object} Validated config
 */
function validateConfig(cfg) {
  const defaults = cloneDefaults();
  if (!cfg.labelToType || typeof cfg.labelToType !== 'object' || Array.isArray(cfg.labelToType)) {
    cfg.labelToType = defaults.labelToType;
  }
  if (!cfg.labelToPriority || typeof cfg.labelToPriority !== 'object' || Array.isArray(cfg.labelToPriority)) {
    cfg.labelToPriority = defaults.labelToPriority;
  }
  if (typeof cfg.defaultPriority !== 'number') {
    cfg.defaultPriority = defaults.defaultPriority;
  }
  if (typeof cfg.mapAssignee !== 'boolean') {
    cfg.mapAssignee = defaults.mapAssignee;
  }
  if (!Array.isArray(cfg.gateAssociations)) {
    cfg.gateAssociations = defaults.gateAssociations;
  }
  return cfg;
}
