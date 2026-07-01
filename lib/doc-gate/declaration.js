'use strict';

/**
 * doc-gate `.docgate.json` declaration loader + validator.
 *
 * The detector (lib/doc-gate/detect.js) abstains / escalates on repos it cannot
 * confidently resolve. This module implements the research-validated
 * "declaration beats inference" escape hatch (cf. corepack `packageManager`,
 * knip.json): a repo may commit a `.docgate.json` that AUTHORITATIVELY declares
 * its structure, so the detector resolves it and the gate enforces precisely.
 *
 * Design (consistent with the detector + gate):
 *  - Tracked-files-only: the declaration is read ONLY when `git ls-files` lists
 *    it, so untracked worktree clutter can never change a verdict.
 *  - Fail-closed: the git wrapper THROWS on failure; a git error, unreadable
 *    file, invalid JSON, or a schema violation is SURFACED as a non-empty
 *    `errors` array — an invalid declaration is never silently ignored.
 *  - Strict schema: unknown top-level keys are rejected and every field's type
 *    is validated; `version` must be 1.
 *
 * @module doc-gate/declaration
 */

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const DECLARATION_FILE = '.docgate.json';
const ALLOWED_KEYS = new Set(['version', 'source', 'toolchain', 'excludeFromGate', 'rules']);
const RULE_KEYS = new Set(['when', 'requires']);

/**
 * Strict git wrapper: THROWS on any failure (fail-closed). The declaration
 * loader must never treat a git error as "no declaration" — that would let a
 * broken repo silently skip enforcement. Callers turn the throw into an explicit
 * `errors` entry.
 *
 * @param {string} root - Repository root.
 * @param {string[]} args - git arguments.
 * @returns {string} stdout.
 */
function gitStrict(root, args) {
  // NOSONAR S4036 - hardcoded CLI command, no user input.
  const res = cp.spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); // NOSONAR S4036
  if (res.error) throw new Error(`git ${args.join(' ')}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} exited ${res.status}: ${String(res.stderr || '').trim()}`);
  return res.stdout;
}

/** True when `file` is a tracked path in the repo at `root`. */
function isTracked(root, file) {
  const out = gitStrict(root, ['ls-files', '--', file]);
  return out.split('\n').map(s => s.trim()).filter(Boolean).length > 0;
}

/** True when `v` is an array of NON-BLANK strings (an empty array is allowed).
 * Blank/whitespace entries are rejected so `source: [""]` can't promote a repo to
 * DECLARED while matching no files. */
function isNonBlankStringArray(v) {
  return Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim() !== '');
}

/** Validate a single `rules[]` entry, pushing precise messages into `errors`. */
function validateRule(rule, index, errors) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    errors.push(`"rules[${index}]" must be an object with "when" and "requires"`);
    return;
  }
  if (typeof rule.when !== 'string' || !rule.when) errors.push(`"rules[${index}].when" must be a non-empty string`);
  if (typeof rule.requires !== 'string' || !rule.requires) errors.push(`"rules[${index}].requires" must be a non-empty string`);
  for (const key of Object.keys(rule)) {
    if (!RULE_KEYS.has(key)) errors.push(`"rules[${index}]" has unknown key "${key}"`);
  }
}

/**
 * Validate a parsed `.docgate.json` object against the strict schema.
 *
 * Schema: `{ version: 1, source?: string[], toolchain?: string,
 * excludeFromGate?: string[], rules?: [{ when: string, requires: string }] }`.
 *
 * @param {*} parsed - The JSON.parse result.
 * @returns {{ declaration: object|null, errors: string[] }} A valid object is
 *   returned as `declaration`; ANY problem yields a non-empty `errors` array and
 *   a null `declaration` (invalid declarations are never applied).
 */
/** Validate the optional schema fields (source/toolchain/excludeFromGate/rules),
 * pushing precise messages into `errors`. Extracted to keep validateDeclaration
 * under the SonarCloud cognitive-complexity threshold. */
function validateOptionalFields(parsed, errors) {
  if (parsed.source !== undefined && !(isNonBlankStringArray(parsed.source) && parsed.source.length > 0)) {
    errors.push('"source" must be a non-empty array of non-empty strings');
  }
  if (parsed.toolchain !== undefined && (typeof parsed.toolchain !== 'string' || !parsed.toolchain.trim())) {
    errors.push('"toolchain" must be a non-empty string');
  }
  if (parsed.excludeFromGate !== undefined && !isNonBlankStringArray(parsed.excludeFromGate)) {
    errors.push('"excludeFromGate" must be an array of non-empty strings');
  }
  if (parsed.rules !== undefined) {
    if (!Array.isArray(parsed.rules)) errors.push('"rules" must be an array');
    else parsed.rules.forEach((rule, i) => validateRule(rule, i, errors));
  }
}

function validateDeclaration(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { declaration: null, errors: [`${DECLARATION_FILE} must be a JSON object`] };
  }
  const errors = [];
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`unknown top-level key "${key}"`);
  }
  if (parsed.version !== 1) errors.push('"version" must be 1');
  validateOptionalFields(parsed, errors);
  if (errors.length > 0) return { declaration: null, errors };
  return { declaration: parsed, errors: [] };
}

/**
 * Load + validate a repo's committed `.docgate.json` declaration.
 *
 * Tracked-files-only: the file is read only when `git ls-files` lists it. A
 * missing / untracked file is a normal "no declaration" (`{ declaration: null,
 * errors: [] }`). A git error, unreadable file, invalid JSON, or a schema
 * violation is surfaced as a non-empty `errors` array (fail-closed).
 *
 * @param {string} root - Absolute repository root (a git working tree).
 * @returns {{ declaration: object|null, errors: string[] }}
 */
function loadDeclaration(root) {
  let tracked;
  try {
    tracked = isTracked(root, DECLARATION_FILE);
  } catch (err) {
    // FAIL-CLOSED: a git failure must surface, never be treated as "no file".
    return { declaration: null, errors: [`could not determine tracked status of ${DECLARATION_FILE}: ${err.message}`] };
  }
  if (!tracked) return { declaration: null, errors: [] };

  let raw;
  try {
    raw = fs.readFileSync(path.join(root, DECLARATION_FILE), 'utf8');
  } catch (err) {
    return { declaration: null, errors: [`could not read ${DECLARATION_FILE}: ${err.message}`] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { declaration: null, errors: [`invalid JSON in ${DECLARATION_FILE}: ${err.message}`] };
  }

  return validateDeclaration(parsed);
}

/**
 * Build a starter `.docgate.json` object from a detector result, so a human or
 * agent can commit + edit it. Uses the auto-detected source/toolchain as the
 * starting point; falls back to a `src` placeholder when detection abstained.
 *
 * @param {object} detectResult - The result of `detect(root)`.
 * @returns {object} A schema-valid declaration object.
 */
function scaffoldDeclaration(detectResult) {
  const declaration = { version: 1 };
  const src = detectResult?.source?.value;
  declaration.source = Array.isArray(src) && src.length > 0 ? [...src] : ['src'];
  const toolchain = detectResult?.toolchain?.value;
  if (typeof toolchain === 'string' && toolchain) declaration.toolchain = toolchain;
  declaration.excludeFromGate = [];
  declaration.rules = [];
  return declaration;
}

module.exports = { loadDeclaration, validateDeclaration, scaffoldDeclaration, DECLARATION_FILE };
