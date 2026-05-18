'use strict';

const REQUIRED_REVIEW_ADAPTER_METHODS = [
  'fetchThreads',
  'parse',
  'reply',
  'resolve',
  'score',
];

class ReviewAdapter {
  constructor(options = {}) {
    this.id = options.id || 'review-adapter';
    this.kind = options.kind || 'review';
    this.name = options.name || this.id;
    this.version = options.version || '0.1.0';
  }

  async fetchThreads() {
    throw new Error(`${this.id}.fetchThreads is not implemented`);
  }

  parse() {
    throw new Error(`${this.id}.parse is not implemented`);
  }

  async reply() {
    throw new Error(`${this.id}.reply is not implemented`);
  }

  async resolve() {
    throw new Error(`${this.id}.resolve is not implemented`);
  }

  score() {
    throw new Error(`${this.id}.score is not implemented`);
  }
}

function validateReviewAdapter(adapter) {
  const errors = [];

  if (!adapter || typeof adapter !== 'object') {
    return { valid: false, errors: ['adapter must be an object'] };
  }

  if (!adapter.id || typeof adapter.id !== 'string') {
    errors.push('id must be a non-empty string');
  }

  if (adapter.kind !== 'review') {
    errors.push('kind must be "review"');
  }

  for (const method of REQUIRED_REVIEW_ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      errors.push(`${method} must be a function`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  ReviewAdapter,
  REQUIRED_REVIEW_ADAPTER_METHODS,
  validateReviewAdapter,
};
