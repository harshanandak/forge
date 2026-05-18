'use strict';

const { getFieldAuthority } = require('./issue-sync/authority.js');

const REQUIRED_ISSUE_ADAPTER_METHODS = [
  'list',
  'read',
  'create',
  'update',
  'close',
  'comment',
  'mapStatus',
  'decideAuthority',
];

const ABSTRACT_ISSUE_ADAPTER_METHODS = new Set([
  'list',
  'read',
  'create',
  'update',
  'close',
  'comment',
]);

const GITHUB_OPEN_STATUSES = new Set(['open', 'in_progress', 'blocked', 'todo', 'ready']);
const GITHUB_CLOSED_STATUSES = new Set(['closed', 'done', 'resolved', 'complete', 'completed']);

class IssueAdapter {
  constructor(options = {}) {
    this.id = options.id || 'issue-adapter';
    this.kind = options.kind || 'issue';
    this.name = options.name || this.id;
    this.version = options.version || '0.1.0';
  }

  async list() {
    throw new Error(`${this.id}.list is not implemented`);
  }

  async read() {
    throw new Error(`${this.id}.read is not implemented`);
  }

  async create() {
    throw new Error(`${this.id}.create is not implemented`);
  }

  async update() {
    throw new Error(`${this.id}.update is not implemented`);
  }

  async close() {
    throw new Error(`${this.id}.close is not implemented`);
  }

  async comment() {
    throw new Error(`${this.id}.comment is not implemented`);
  }

  mapStatus(status, context) {
    return normalizeIssueStatus(status, context);
  }

  decideAuthority(change, context) {
    return decideIssueAuthority(change, context);
  }
}

function validateIssueAdapter(adapter) {
  const errors = [];

  if (!adapter || typeof adapter !== 'object') {
    return { valid: false, errors: ['adapter must be an object'] };
  }

  if (!adapter.id || typeof adapter.id !== 'string') {
    errors.push('id must be a non-empty string');
  }

  if (adapter.kind !== 'issue') {
    errors.push('kind must be "issue"');
  }

  for (const method of REQUIRED_ISSUE_ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      errors.push(`${method} must be a function`);
    } else if (
      ABSTRACT_ISSUE_ADAPTER_METHODS.has(method)
      && adapter[method] === IssueAdapter.prototype[method]
    ) {
      errors.push(`${method} must be implemented by the adapter`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function normalizeIssueStatus(status, options = {}) {
  const normalized = typeof status === 'string'
    ? status.trim().toLowerCase().replace(/[-\s]+/g, '_')
    : '';

  if (options.target === 'github') {
    if (GITHUB_CLOSED_STATUSES.has(normalized)) {
      return 'closed';
    }
    if (GITHUB_OPEN_STATUSES.has(normalized)) {
      return 'open';
    }
    return 'open';
  }

  return normalized || 'open';
}

function decideIssueAuthority(change = {}, _context = {}) {
  const authority = getFieldAuthority(change.fieldPath);

  if (authority === 'github') {
    return {
      authority,
      action: change.direction === 'push' ? 'project-to-github' : 'apply-remote',
      conflict: change.direction === 'push' ? 'remote-wins-on-pull' : 'record-drift',
    };
  }

  if (authority === 'forge') {
    return {
      authority,
      action: change.direction === 'push' ? 'keep-local' : 'preserve-local',
      conflict: change.direction === 'push' ? 'not-shared-to-github' : 'ignore-remote',
    };
  }

  if (authority === 'cache') {
    return {
      authority,
      action: 'rebuild-cache',
      conflict: 'derived',
    };
  }

  return {
    authority: null,
    action: 'reject',
    conflict: 'unknown-field',
  };
}

module.exports = {
  IssueAdapter,
  REQUIRED_ISSUE_ADAPTER_METHODS,
  decideIssueAuthority,
  normalizeIssueStatus,
  validateIssueAdapter,
};
