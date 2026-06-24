'use strict';

/**
 * PR-state adapter contract validator.
 *
 * Mirrors the shape of `validateReviewAdapter` in lib/review-adapter.js but
 * enforces its own `kind: 'pr-state'`. The pr-state adapter is a distinct SPI
 * from the review adapter — it wraps read-only PR/CI state plus a small set of
 * idempotent, reversible side-effects (rerun a failed check, post a status
 * reply). It is never fed to `validateReviewAdapter`.
 *
 * State persists via GitHub PR comments/labels and git only.
 *
 * @module pr-state-validator
 */

/** Methods every PR-state adapter must implement. */
const REQUIRED_PR_STATE_ADAPTER_METHODS = [
  'readState',
  'readRequiredChecks',
  'readDivergence',
  'rerunFailedChecks',
  'replyToThread',
];

/**
 * Validate that an object satisfies the PR-state adapter contract.
 *
 * @param {*} adapter - Candidate adapter.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePrStateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    return { valid: false, errors: ['adapter must be an object'] };
  }

  const errors = [];

  if (!adapter.id || typeof adapter.id !== 'string') {
    errors.push('id must be a non-empty string');
  }

  if (adapter.kind !== 'pr-state') {
    errors.push('kind must be "pr-state"');
  }

  for (const method of REQUIRED_PR_STATE_ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      errors.push(`${method} must be a function`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  REQUIRED_PR_STATE_ADAPTER_METHODS,
  validatePrStateAdapter,
};
