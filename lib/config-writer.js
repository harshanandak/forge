'use strict';

/**
 * @module config-writer
 *
 * Sparse read-modify-write for the ONE schema-validated config surface,
 * `.forge/config.yaml` (the file `lib/core/runtime-graph.js` reads via
 * `loadRuntimeGraphConfig`). This is the single missing primitive behind the
 * `forge gate` / `forge role` verbs: create-or-update the file, set/remove one
 * nested key, and preserve every other key untouched.
 *
 * Design: docs/work/2026-07-04-kernel-native-skills/extensibility-architecture.md
 * (§9 "the sparse writer"). This is NOT a generalization of the legacy
 * `.forge/adapters.json` review writer — that path stays where it is.
 *
 * Key paths are ARRAYS of segments, not dotted strings, because real keys
 * contain dots (e.g. the gate id `gate.plan-exit`). Splitting on `.` would
 * corrupt them, so callers pass `['workflow', 'gates', 'gate.plan-exit',
 * 'enabled']`.
 */

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

/** Root of the installed Forge package (ships the canonical `skills/` dir). */
const PACKAGE_ROOT = path.join(__dirname, '..');

const CONFIG_RELATIVE = path.join('.forge', 'config.yaml');

function getConfigPath(projectRoot = process.cwd()) {
  return path.join(projectRoot, '.forge', 'config.yaml');
}

function assertKeyPath(keyPath) {
  if (!Array.isArray(keyPath) || keyPath.length === 0
    || keyPath.some(seg => typeof seg !== 'string' || seg === '')) {
    throw new Error('config-writer: keyPath must be a non-empty array of non-empty string segments.');
  }
}

/** Load the raw config object (or `{}` if the file is absent/empty). */
function loadRawConfig(projectRoot = process.cwd()) {
  const configPath = getConfigPath(projectRoot);
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, 'utf8');
  if (raw.trim() === '') return {};
  const parsed = YAML.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_RELATIVE} root must be an object.`);
  }
  return parsed;
}

function writeRawConfig(projectRoot, config) {
  const configPath = getConfigPath(projectRoot);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify(config));
  return configPath;
}

/**
 * Set a nested key to `value`, creating intermediate objects as needed and
 * preserving all sibling keys. Creates `.forge/config.yaml` if absent.
 *
 * @param {string} projectRoot
 * @param {string[]} keyPath - Segments, e.g. ['roles', 'plan', 'skill'].
 * @param {*} value
 * @returns {{config: object, configPath: string}}
 */
function setConfigOverride(projectRoot, keyPath, value) {
  assertKeyPath(keyPath);
  const config = loadRawConfig(projectRoot);
  let node = config;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i];
    if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) {
      node[key] = {};
    }
    node = node[key];
  }
  node[keyPath[keyPath.length - 1]] = value;
  return { config, configPath: writeRawConfig(projectRoot, config) };
}

/**
 * Remove a nested key (a "reset" to the profile/default). Prunes ancestor
 * objects that become empty so the surface stays sparse. No-op if the key is
 * absent or the file does not exist.
 *
 * @param {string} projectRoot
 * @param {string[]} keyPath
 * @returns {{config: object, configPath: string, removed: boolean}}
 */
function removeConfigOverride(projectRoot, keyPath) {
  assertKeyPath(keyPath);
  const configPath = getConfigPath(projectRoot);
  if (!fs.existsSync(configPath)) {
    return { config: {}, configPath, removed: false };
  }
  const config = loadRawConfig(projectRoot);
  const chain = [config];
  let node = config;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i];
    if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) {
      return { config, configPath, removed: false };
    }
    node = node[key];
    chain.push(node);
  }
  const leaf = keyPath[keyPath.length - 1];
  if (!Object.hasOwn(node, leaf)) {
    return { config, configPath, removed: false };
  }
  delete node[leaf];
  // Prune now-empty ancestor objects, deepest first.
  for (let i = chain.length - 1; i > 0; i -= 1) {
    if (Object.keys(chain[i]).length === 0) {
      delete chain[i - 1][keyPath[i - 1]];
    } else {
      break;
    }
  }
  return { config, configPath: writeRawConfig(projectRoot, config), removed: true };
}

/**
 * Directories searched (in precedence order) when resolving a skill name.
 * Mirrors the skills-sync precedence: `.skills/` shadow wins over canonical
 * `skills/`, then the installed package's shipped defaults.
 */
function skillSearchDirs(projectRoot = process.cwd()) {
  return [
    path.join(projectRoot, '.skills'),
    path.join(projectRoot, 'skills'),
    path.join(PACKAGE_ROOT, 'skills'),
  ];
}

/**
 * Resolve a skill NAME to a real `SKILL.md` via `.skills/ > skills/`
 * precedence. Returns null if no such skill exists — the `forge role` verb
 * uses this for write-time validation so an unresolvable skill errors before
 * anything is written (never mid-run).
 *
 * @param {string} projectRoot
 * @param {string} name
 * @returns {{name: string, dir: string, path: string}|null}
 */
function resolveSkill(projectRoot, name) {
  if (typeof name !== 'string' || name === ''
    || name.includes('/') || name.includes('\\') || name.includes('\0')
    || name === '.' || name === '..') {
    return null;
  }
  for (const dir of skillSearchDirs(projectRoot)) {
    const skillMd = path.join(dir, name, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      return { name, dir, path: skillMd };
    }
  }
  return null;
}

module.exports = {
  getConfigPath,
  loadRawConfig,
  setConfigOverride,
  removeConfigOverride,
  resolveSkill,
  skillSearchDirs,
};
