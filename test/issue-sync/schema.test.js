const { describe, expect, test } = require('bun:test');

const {
  buildSharedIssueRecord,
  createDefaultSharedIssueRecord,
} = require('../../lib/issue-sync/schema.js');

describe('shared issue schema', () => {
  test('creates a normalized record with stable defaults', () => {
    const record = createDefaultSharedIssueRecord();

    expect(record).toEqual({
      github: {
        number: null,
        nodeId: null,
        url: null,
      },
      shared: {
        title: '',
        body: '',
        state: 'open',
        assignees: [],
        labels: [],
        milestone: null,
      },
      forge: {
        issueId: null,
        dependencies: [],
        parentId: null,
        childIds: [],
        workflowStage: null,
        acceptanceCriteria: [],
        progressNotes: [],
        stageTransitions: [],
        decisions: [],
        memory: [],
      },
      cache: {
        githubSnapshot: null,
        materializedIssue: null,
        legacyLinkHints: {
          mapping: null,
          githubIssue: null,
          syncComments: [],
          externalRef: null,
          descriptionUrl: null,
        },
      },
      sync: {
        remoteUpdatedAt: null,
        lastPulledAt: null,
        lastPushedAt: null,
        pendingOutbound: [],
        drift: [],
      },
    });
  });

  test('builds a normalized record while preserving section defaults', () => {
    const record = buildSharedIssueRecord({
      github: {
        number: 42,
        nodeId: 'I_kwDOG123',
        url: 'https://github.com/acme/forge/issues/42',
      },
      shared: {
        title: 'Shared title',
        labels: ['sync'],
      },
      forge: {
        issueId: 'forge-nlgg',
        workflowStage: 'dev',
      },
      cache: {
        legacyLinkHints: {
          externalRef: 'gh-42',
        },
      },
      sync: {
        remoteUpdatedAt: '2026-04-24T10:00:00Z',
      },
    });

    expect(record.github.number).toBe(42);
    expect(record.shared.title).toBe('Shared title');
    expect(record.shared.body).toBe('');
    expect(record.forge.issueId).toBe('forge-nlgg');
    expect(record.forge.dependencies).toEqual([]);
    expect(record.cache.legacyLinkHints.externalRef).toBe('gh-42');
    expect(record.cache.legacyLinkHints.mapping).toBeNull();
    expect(record.sync.remoteUpdatedAt).toBe('2026-04-24T10:00:00Z');
    expect(record.sync.pendingOutbound).toEqual([]);
  });
});
