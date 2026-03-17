/**
 * Eval set schema validator and loader.
 *
 * Supports three assertion types:
 *   - standard  : { type, check }
 *   - hard-gate : { type, precondition, check }
 *   - contract  : { type, producer, consumer, check }
 */

const fs = require('fs');

const VALID_ASSERTION_TYPES = ['standard', 'hard-gate', 'contract'];

// ── assertion-level required fields by type ────────────────────────────
const ASSERTION_REQUIRED_FIELDS = {
  standard: ['check'],
  'hard-gate': ['precondition', 'check'],
  contract: ['producer', 'consumer', 'check'],
};

// ── helpers ────────────────────────────────────────────────────────────

function requireNonEmptyString(obj, field, prefix) {
  if (typeof obj[field] !== 'string' || obj[field].length === 0) {
    throw new Error(`${prefix}missing required field: ${field}`);
  }
}

function validateAssertion(assertion, queryName, index) {
  const prefix = `query "${queryName}", assertion ${index}`;

  if (!assertion || typeof assertion.type !== 'string') {
    throw new Error(`${prefix}: missing required field: type`);
  }

  if (!VALID_ASSERTION_TYPES.includes(assertion.type)) {
    throw new Error(`${prefix}: unknown assertion type: "${assertion.type}"`);
  }

  const requiredFields = ASSERTION_REQUIRED_FIELDS[assertion.type];
  for (const field of requiredFields) {
    if (typeof assertion[field] !== 'string' || assertion[field].length === 0) {
      throw new Error(`${prefix} (${assertion.type}): missing required field: ${field}`);
    }
  }
}

function validateQuery(query, index, seenNames) {
  // name must exist before we can use it in error messages
  if (typeof query.name !== 'string' || query.name.length === 0) {
    throw new Error(`query at index ${index}: missing required field: name`);
  }

  const name = query.name;

  if (seenNames.has(name)) {
    throw new Error(`duplicate query name: "${name}"`);
  }
  seenNames.add(name);

  requireNonEmptyString(query, 'prompt', `query "${name}": `);

  // assertions: must be a non-empty array
  if (!Array.isArray(query.assertions)) {
    throw new Error(`query "${name}": missing required field: assertions`);
  }
  if (query.assertions.length === 0) {
    throw new Error(`query "${name}": assertions must be a non-empty array`);
  }

  for (let i = 0; i < query.assertions.length; i++) {
    validateAssertion(query.assertions[i], name, i);
  }

  // Normalise optional fields
  if (query.setup === undefined) query.setup = null;
  if (query.teardown === undefined) query.teardown = null;
}

// ── public API ─────────────────────────────────────────────────────────

/**
 * Validate an in-memory eval-set object.
 * Returns the (possibly normalised) object on success, throws on failure.
 */
function validateEvalSet(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('eval set must be a non-null object');
  }

  requireNonEmptyString(data, 'command', '');
  requireNonEmptyString(data, 'description', '');

  if (!Array.isArray(data.queries)) {
    throw new Error('missing required field: queries');
  }
  if (data.queries.length === 0) {
    throw new Error('queries must be a non-empty array');
  }

  const seenNames = new Set();
  for (let i = 0; i < data.queries.length; i++) {
    validateQuery(data.queries[i], i, seenNames);
  }

  return data;
}

/**
 * Load an eval-set from a `.eval.json` file on disk.
 * Returns the validated object or throws with a descriptive error.
 */
function loadEvalSet(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`eval set file not found: ${filePath}`);
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`failed to read eval set file: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (_err) {
    throw new Error(`invalid JSON in eval set file: ${filePath}`);
  }

  return validateEvalSet(data);
}

module.exports = { loadEvalSet, validateEvalSet };
