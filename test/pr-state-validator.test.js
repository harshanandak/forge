'use strict';

const { describe, test, expect } = require('bun:test');

const { validatePrStateAdapter } = require('../lib/pr-state-validator');
const { validateReviewAdapter } = require('../lib/review-adapter');

function makeValidAdapter(overrides = {}) {
  return {
    id: 'pr-state-test',
    kind: 'pr-state',
    readState() {},
    readRequiredChecks() {},
    readDivergence() {},
    rerunFailedChecks() {},
    replyToThread() {},
    ...overrides,
  };
}

describe('validatePrStateAdapter', () => {
  test('rejects a non-object', () => {
    expect(validatePrStateAdapter(null)).toEqual({
      valid: false,
      errors: ['adapter must be an object'],
    });
  });

  test('rejects the review kind with a clear message', () => {
    const result = validatePrStateAdapter(makeValidAdapter({ kind: 'review' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('kind must be "pr-state"');
  });

  test('accepts a complete pr-state adapter', () => {
    expect(validatePrStateAdapter(makeValidAdapter())).toEqual({ valid: true, errors: [] });
  });

  test('reports every missing required method', () => {
    const result = validatePrStateAdapter({ id: 'broken', kind: 'pr-state' });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'readState must be a function',
      'readRequiredChecks must be a function',
      'readDivergence must be a function',
      'rerunFailedChecks must be a function',
      'replyToThread must be a function',
    ]);
  });

  test('requires a non-empty id', () => {
    const result = validatePrStateAdapter(makeValidAdapter({ id: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('id must be a non-empty string');
  });

  test('a pr-state adapter is NOT accepted by validateReviewAdapter (different SPI)', () => {
    // The pr-state adapter must never be fed to the review validator.
    const result = validateReviewAdapter(makeValidAdapter());
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('kind must be "review"');
  });
});
