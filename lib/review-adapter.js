'use strict';

const REQUIRED_REVIEW_ADAPTER_METHODS = [
  'fetchThreads',
  'parse',
  'reply',
  'resolve',
  'score',
];

const REVIEW_EVIDENCE_LIMITS = Object.freeze({
  maxTextChars: 256,
});

const SECRET_PATTERNS = [
  /\bBearer\s+\S+/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_\w{20,}\b/gi,
  /\b(?:sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,})\b/g,
  /\bAKIA[0-9A-Z]{16}\b/gi,
  /\b(?:api[_ -]?key|authorization|credential|password|private[_ -]?key|secret|token)\s*[:=]\s*\S{8,}/gi,
];
const PRIVATE_PATH_PATTERNS = [
  /[a-z]:\\Users\\[^\\\s]+(?:\\[^\s]*)?/gi,
  /\/(?:Users|home)\/[^/\s]+(?:\/[^\s]*)?/g,
  /\/root\/[^\s"'<>{}[\]]+/g,
];

function stripControlCharacters(value) {
  let output = '';
  for (const character of value) {
    const code = character.codePointAt(0);
    const control = (code >= 0 && code <= 8)
      || code === 11
      || code === 12
      || (code >= 14 && code <= 31)
      || code === 127;
    output += control ? ' ' : character;
  }
  return output;
}

function normalizeEvidenceText(value, options = {}) {
  const requestedLimit = options.maxChars ?? REVIEW_EVIDENCE_LIMITS.maxTextChars;
  const maxChars = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : REVIEW_EVIDENCE_LIMITS.maxTextChars;
  let text = stripControlCharacters(String(value ?? ''))
    .replace(/[\r\n\t]+/g, ' ');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
  for (const pattern of PRIVATE_PATH_PATTERNS) text = text.replace(pattern, '[REDACTED_PATH]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function classifyReviewActor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  const typename = value.authorTypename
    || value.authorType
    || value.actorTypename
    || value.actorType
    || value.author?.__typename;
  const actorKinds = {
    Bot: 'bot',
    User: 'user',
    Organization: 'organization',
    Mannequin: 'mannequin',
    EnterpriseUserAccount: 'enterprise-user',
  };
  return actorKinds[typename] || 'unknown';
}

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
  REVIEW_EVIDENCE_LIMITS,
  ReviewAdapter,
  REQUIRED_REVIEW_ADAPTER_METHODS,
  classifyReviewActor,
  normalizeEvidenceText,
  validateReviewAdapter,
};
