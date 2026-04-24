const { describe, expect, test } = require('bun:test');

const { normalizeRemoteIssue } = require('../../lib/issue-sync/github-pull.js');
const { reconcileSharedIssueRecord } = require('../../lib/issue-sync/reconcile.js');
const { buildSharedIssueRecord } = require('../../lib/issue-sync/schema.js');

describe('shared issue reconciliation', () => {
  test('updates GitHub-owned fields while preserving Forge-owned workflow state', () => {
    const localRecord = buildSharedIssueRecord({
      github: {
        number: 42,
        nodeId: 'I_kwDOForge42',
        url: 'https://github.com/acme/forge/issues/42',
      },
      shared: {
        title: 'Stale local title',
        body: 'Canonical body',
        state: 'closed',
        assignees: ['octocat'],
        labels: ['sync'],
        milestone: 'v2.0',
      },
      forge: {
        issueId: 'forge-nlgg',
        workflowStage: 'dev',
        dependencies: ['forge-alpha'],
        progressNotes: ['keep me'],
        stageTransitions: [{ stage: 'dev', at: '2026-04-23T09:00:00Z' }],
        decisions: ['keep local decision'],
        memory: ['local memory'],
      },
      cache: {
        githubSnapshot: {
          shared: {
            title: 'Stale local title',
          },
        },
        materializedIssue: {
          forge: {
            workflowStage: 'dev',
          },
        },
      },
      sync: {
        remoteUpdatedAt: '2026-04-24T10:00:00Z',
        lastPulledAt: '2026-04-23T09:05:00Z',
        lastPushedAt: '2026-04-23T09:10:00Z',
        pendingOutbound: ['shared.title'],
        drift: [{ type: 'previous-drift' }],
      },
    });

    const remoteSnapshot = normalizeRemoteIssue({
      number: 42,
      node_id: 'I_kwDOForge42',
      html_url: 'https://github.com/acme/forge/issues/42',
      title: 'Canonical GitHub title',
      body: 'Canonical body',
      state: 'closed',
      assignees: [{ login: 'octocat' }],
      labels: [{ name: 'sync' }],
      milestone: { title: 'v2.0' },
      updated_at: '2026-04-24T10:00:00Z',
    });

    const result = reconcileSharedIssueRecord(localRecord, remoteSnapshot);

    expect(result.record.github).toEqual({
      number: 42,
      nodeId: 'I_kwDOForge42',
      url: 'https://github.com/acme/forge/issues/42',
    });
    expect(result.record.shared).toEqual({
      title: 'Canonical GitHub title',
      body: 'Canonical body',
      state: 'closed',
      assignees: ['octocat'],
      labels: ['sync'],
      milestone: 'v2.0',
    });
    expect(result.record.forge).toEqual(localRecord.forge);
    expect(result.record.sync.remoteUpdatedAt).toBe('2026-04-24T10:00:00Z');
    expect(result.record.sync.lastPulledAt).toBe('2026-04-23T09:05:00Z');
    expect(result.record.sync.lastPushedAt).toBe('2026-04-23T09:10:00Z');
    expect(result.record.sync.pendingOutbound).toEqual(['shared.title']);
    expect(result.record.sync.drift).toEqual([
      { type: 'previous-drift' },
      {
        type: 'github-shared-drift',
        field: 'shared.title',
        localValue: 'Stale local title',
        remoteValue: 'Canonical GitHub title',
      },
    ]);
    expect(result.diagnostics).toEqual([
      {
        type: 'github-shared-drift',
        field: 'shared.title',
        localValue: 'Stale local title',
        remoteValue: 'Canonical GitHub title',
      },
    ]);
    expect(result.record.cache.githubSnapshot).toEqual(remoteSnapshot);
    expect(result.record.cache.materializedIssue).toMatchObject({
      github: result.record.github,
      shared: result.record.shared,
      forge: localRecord.forge,
      sync: {
        remoteUpdatedAt: '2026-04-24T10:00:00Z',
        lastPulledAt: '2026-04-23T09:05:00Z',
        lastPushedAt: '2026-04-23T09:10:00Z',
        pendingOutbound: ['shared.title'],
        drift: result.record.sync.drift,
      },
    });
    expect(result.record.cache.materializedIssue.cache.materializedIssue).toBeNull();
  });
});
