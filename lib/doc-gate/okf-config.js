'use strict';

/**
 * doc-gate OKF feature toggle — `.forge/doc-gate.json`.
 *
 * OKF (Google's Open Knowledge Format) support is an OPT-IN, user-toggleable
 * knowledge-base feature. It is DISABLED by default: OKF v0.1 is a DRAFT and
 * explicitly "not an official Google product", so nothing generates a bundle or
 * touches AGENTS.md until a user turns it on.
 *
 * This module is the toggle store. It mirrors the `.forge/*.json` config pattern
 * used by `lib/adapter-cli.js` (see `setAdapterEnabled`) but writes a dedicated
 * `.forge/doc-gate.json` shaped `{ okf: { enabled: boolean } }`.
 *
 * IMPORTANT: this file is NOT the repo-root `.docgate.json` declaration
 * (lib/doc-gate/declaration.js). Those two are deliberately separate — the
 * declaration authoritatively describes repo structure and flips the detector
 * verdict to DECLARED; this toggle ONLY gates OKF bundle generation. Neither
 * reads or writes the other's file.
 *
 * Fail-safe: a missing OR malformed config resolves to DISABLED, never an error.
 *
 * @module doc-gate/okf-config
 */

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_DIR = '.forge';
const CONFIG_FILE = 'doc-gate.json';

/** Absolute path to a repo's `.forge/doc-gate.json`. */
function configPath(root) {
  return path.join(root, CONFIG_DIR, CONFIG_FILE);
}

/** True only for a plain (non-array) object. */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize any parsed value into a well-formed `{ okf: { enabled: boolean } }`,
 * preserving unrelated top-level keys. `enabled` is `true` ONLY when it is
 * strictly the boolean `true`, so any junk (missing, string, number, null) is a
 * safe `false`.
 */
function normalizeConfig(parsed) {
  const base = isPlainObject(parsed) ? parsed : {};
  const okf = isPlainObject(base.okf) ? base.okf : {};
  return { ...base, okf: { ...okf, enabled: okf.enabled === true } };
}

/**
 * Load + normalize a repo's `.forge/doc-gate.json`.
 *
 * A missing file, an unreadable file, or invalid JSON all resolve to the DISABLED
 * default — this must never throw, so the toggle can be queried anywhere.
 *
 * @param {string} root - Repository root.
 * @returns {{ okf: { enabled: boolean } }}
 */
function loadOkfConfig(root) {
  let raw;
  try {
    raw = fs.readFileSync(configPath(root), 'utf8');
  } catch (_err) {
    // Missing / unreadable config => disabled (fail-safe). NOSONAR S2486
    return normalizeConfig(null);
  }
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch (_err) {
    // Malformed JSON => disabled (fail-safe), never surfaced as an error. NOSONAR S2486
    return normalizeConfig(null);
  }
}

/** True when OKF generation is enabled for `root`. */
function isOkfEnabled(root) {
  return loadOkfConfig(root).okf.enabled === true;
}

/**
 * Symlink-safe config write: refuse to write THROUGH a symlink (a checked-in
 * symlink could clobber a file outside the repo), matching `doc-gate init`.
 */
function writeConfig(root, config) {
  const dir = path.join(root, CONFIG_DIR);
  // Refuse a symlinked CONFIG_DIR (.forge) BEFORE mkdir/write — a checked-in
  // symlink there could redirect the write to a file OUTSIDE the repo.
  let dirStat = null;
  try { dirStat = fs.lstatSync(dir); } catch { /* absent: will be created */ }
  if (dirStat?.isSymbolicLink()) {
    throw new Error(`${CONFIG_DIR} is a symlink; refusing to write through it.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath(root);
  let stat = null;
  try { stat = fs.lstatSync(file); } catch { /* absent: stat stays null */ }
  if (stat?.isSymbolicLink()) {
    throw new Error(`${CONFIG_DIR}/${CONFIG_FILE} is a symlink; refusing to write through it.`);
  }
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Set the OKF `enabled` flag, preserving any unrelated config keys.
 *
 * @param {string} root - Repository root.
 * @param {boolean} enabled - Desired state.
 * @returns {{ okf: { enabled: boolean } }} The written config.
 */
function setOkfEnabled(root, enabled) {
  const current = loadOkfConfig(root);
  const next = { ...current, okf: { ...current.okf, enabled: enabled === true } };
  writeConfig(root, next);
  return next;
}

module.exports = {
  loadOkfConfig,
  isOkfEnabled,
  setOkfEnabled,
  configPath,
  CONFIG_DIR,
  CONFIG_FILE,
};
