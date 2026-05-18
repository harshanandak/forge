'use strict';

const { describe, expect, test } = require('bun:test');

describe('IssueAdapter SPI', () => {
  test('exports the required issue adapter contract', () => {
    const {
      IssueAdapter,
      REQUIRED_ISSUE_ADAPTER_METHODS,
      validateIssueAdapter,
    } = require('../lib/issue-adapter');

    expect(REQUIRED_ISSUE_ADAPTER_METHODS).toEqual([
      'list',
      'read',
      'create',
      'update',
      'close',
      'comment',
      'mapStatus',
      'decideAuthority',
    ]);

    const adapter = new IssueAdapter({ id: 'test-issues', name: 'Test Issues' });
    expect(adapter.kind).toBe('issue');
    expect(typeof adapter.list).toBe('function');
    expect(validateIssueAdapter(adapter)).toEqual({
      valid: false,
      errors: [
        'list must be implemented by the adapter',
        'read must be implemented by the adapter',
        'create must be implemented by the adapter',
        'update must be implemented by the adapter',
        'close must be implemented by the adapter',
        'comment must be implemented by the adapter',
      ],
    });
  });

  test('rejects incomplete issue adapters', () => {
    const { validateIssueAdapter } = require('../lib/issue-adapter');

    expect(validateIssueAdapter({ id: 'bad', kind: 'issue', list() {} })).toEqual({
      valid: false,
      errors: [
        'read must be a function',
        'create must be a function',
        'update must be a function',
        'close must be a function',
        'comment must be a function',
        'mapStatus must be a function',
        'decideAuthority must be a function',
      ],
    });
  });

  test('rejects subclasses that inherit abstract operation methods', () => {
    const { IssueAdapter, validateIssueAdapter } = require('../lib/issue-adapter');

    class PartialIssueAdapter extends IssueAdapter {
      constructor() {
        super({ id: 'partial' });
      }

      list() {
        return [];
      }

      read() {
        return null;
      }
    }

    expect(validateIssueAdapter(new PartialIssueAdapter())).toEqual({
      valid: false,
      errors: [
        'create must be implemented by the adapter',
        'update must be implemented by the adapter',
        'close must be implemented by the adapter',
        'comment must be implemented by the adapter',
      ],
    });
  });

  test('maps issue statuses for GitHub shared state', () => {
    const { normalizeIssueStatus } = require('../lib/issue-adapter');

    expect(normalizeIssueStatus('open', { target: 'github' })).toBe('open');
    expect(normalizeIssueStatus('in_progress', { target: 'github' })).toBe('open');
    expect(normalizeIssueStatus('blocked', { target: 'github' })).toBe('open');
    expect(normalizeIssueStatus('in_review', { target: 'github' })).toBe('open');
    expect(normalizeIssueStatus('closed', { target: 'github' })).toBe('closed');
    expect(normalizeIssueStatus('done', { target: 'github' })).toBe('closed');
  });

  test('returns explicit authority decisions for shared, forge, cache, and unknown fields', () => {
    const { decideIssueAuthority } = require('../lib/issue-adapter');

    expect(decideIssueAuthority({ fieldPath: 'shared.title', direction: 'pull' })).toEqual({
      authority: 'github',
      action: 'apply-remote',
      conflict: 'record-drift',
    });
    expect(decideIssueAuthority({ fieldPath: 'forge.workflowStage', direction: 'pull' })).toEqual({
      authority: 'forge',
      action: 'preserve-local',
      conflict: 'ignore-remote',
    });
    expect(decideIssueAuthority({ fieldPath: 'cache.githubSnapshot', direction: 'pull' })).toEqual({
      authority: 'cache',
      action: 'rebuild-cache',
      conflict: 'derived',
    });
    expect(decideIssueAuthority({ fieldPath: 'custom.field', direction: 'pull' })).toEqual({
      authority: null,
      action: 'reject',
      conflict: 'unknown-field',
    });
  });
});
