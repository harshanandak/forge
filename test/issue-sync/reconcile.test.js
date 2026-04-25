const { describe, expect, test } = require('bun:test');

const { normalizeRemoteIssue } = require('../../lib/issue-sync/github-pull.js');
const {
  buildMaterializedIssueSnapshot,
  createDriftDiagnostic,
  deepEqual,
  reconcileSharedIssueRecord,
  readField,
  writeField,
} = require('../../lib/issue-sync/reconcile.js');
const { buildSharedIssueRecord } = require('../../lib/issue-sync/schema.js');

function buildBaseRecord() {
  return buildSharedIssueRecord({
    github: {
      number: 42,
      nodeId: 'I_kwDOForge42',
      url: 'https://github.com/acme/forge/issues/42',
    },
    shared: {
      title: 'Local title',
      body: 'Local body',
      state: 'open',
      assignees: ['octocat'],
      labels: ['sync'],
      milestone: 'v2.0',
    },
    forge: {
      issueId: 'forge-nlgg',
      workflowStage: 'dev',
      decisions: ['keep local decision'],
    },
    cache: {
      githubSnapshot: {
        shared: {
          title: 'Local title',
        },
      },
      materializedIssue: {
        cache: {
          materializedIssue: 'stale',
        },
      },
    },
    sync: {
      remoteUpdatedAt: '2026-04-24T10:00:00Z',
      lastPulledAt: '2026-04-23T09:05:00Z',
      lastPushedAt: '2026-04-23T09:10:00Z',
      pendingOutbound: ['shared.title'],
      drift: [],
    },
  });
}

describe('shared issue reconciliation', () => {
  test('updates GitHub-owned fields while preserving Forge-owned workflow state', () => {
    const localRecord = buildSharedIssueRecord({
      ...buildBaseRecord(),
      shared: {
        ...buildBaseRecord().shared,
        title: 'Stale local title',
        state: 'closed',
      },
      sync: {
        ...buildBaseRecord().sync,
        drift: [{ type: 'previous-drift' }],
      },
    });

    const remoteSnapshot = normalizeRemoteIssue({
      number: 42,
      node_id: 'I_kwDOForge42',
      html_url: 'https://github.com/acme/forge/issues/42',
      title: 'Canonical GitHub title',
      body: 'Local body',
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
      body: 'Local body',
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

  test('deepEqual compares nested arrays and objects', () => {
    expect(deepEqual(
      { shared: { labels: ['sync', { name: 'triage' }] } },
      { shared: { labels: ['sync', { name: 'triage' }] } },
    )).toBe(true);
    expect(deepEqual(
      { shared: { labels: ['sync', { name: 'triage' }] } },
      { shared: { labels: ['sync', { name: 'bug' }] } },
    )).toBe(false);
    expect(deepEqual(['sync', 'triage'], ['sync', 'triage'])).toBe(true);
    expect(deepEqual(['sync'], ['triage'])).toBe(false);
    expect(deepEqual('forge', 'forge')).toBe(true);
    expect(deepEqual('forge', 'sync')).toBe(false);
  });

  test('readField and writeField cover all GitHub-owned field paths', () => {
    const cases = [
      ['github.number', 42, 7],
      ['github.nodeId', 'I_kwDOForge42', 'I_kwDOForge7'],
      ['github.url', 'https://github.com/acme/forge/issues/42', 'https://github.com/acme/forge/issues/7'],
      ['shared.title', 'Local title', 'Updated title'],
      ['shared.body', 'Local body', 'Updated body'],
      ['shared.state', 'open', 'closed'],
      ['shared.assignees', ['octocat'], ['hubot']],
      ['shared.labels', ['sync'], ['bug']],
      ['shared.milestone', 'v2.0', 'v3.0'],
      ['sync.remoteUpdatedAt', '2026-04-24T10:00:00Z', '2026-04-25T10:00:00Z'],
    ];

    for (const [fieldPath, initialValue, nextValue] of cases) {
      const record = buildBaseRecord();
      expect(readField(record, fieldPath)).toEqual(initialValue);
      writeField(record, fieldPath, nextValue);
      expect(readField(record, fieldPath)).toEqual(nextValue);
    }

    const record = buildBaseRecord();
    expect(readField(record, 'unknown.field')).toBeUndefined();
    writeField(record, 'unknown.field', 'ignored');
    expect(record).toEqual(buildBaseRecord());
  });

  test('createDriftDiagnostic clones nested values', () => {
    const localValue = { labels: ['sync'] };
    const remoteValue = { labels: ['bug'] };

    const diagnostic = createDriftDiagnostic('shared.labels', localValue, remoteValue);

    localValue.labels.push('triage');
    remoteValue.labels.push('priority');

    expect(diagnostic).toEqual({
      type: 'github-shared-drift',
      field: 'shared.labels',
      localValue: { labels: ['sync'] },
      remoteValue: { labels: ['bug'] },
    });
  });

  test('buildMaterializedIssueSnapshot clones the record and clears nested materializedIssue', () => {
    const record = buildBaseRecord();

    const snapshot = buildMaterializedIssueSnapshot(record);
    snapshot.shared.title = 'Changed in snapshot';

    expect(snapshot.cache.materializedIssue).toBeNull();
    expect(record.cache.materializedIssue).toEqual({
      cache: {
        materializedIssue: 'stale',
      },
    });
    expect(record.shared.title).toBe('Local title');
  });

  test('preserves the local remoteUpdatedAt watermark when requested', () => {
    const result = reconcileSharedIssueRecord(
      buildBaseRecord(),
      normalizeRemoteIssue({
        number: 42,
        node_id: 'I_kwDOForge42',
        html_url: 'https://github.com/acme/forge/issues/42',
        title: 'Local title',
        body: 'Local body',
        labels: [{ name: 'sync' }],
        assignees: [{ login: 'octocat' }],
        milestone: { title: 'v2.0' },
        updated_at: '2026-04-25T12:00:00Z',
      }),
      { preserveRemoteUpdatedAt: false },
    );

    expect(result.record.sync.remoteUpdatedAt).toBe('2026-04-24T10:00:00Z');
  });

  test('deduplicates repeated drift diagnostics', () => {
    const duplicateDiagnostic = {
      type: 'github-shared-drift',
      field: 'shared.title',
      localValue: 'Local title',
      remoteValue: 'Canonical title',
    };

    const localRecord = buildSharedIssueRecord({
      ...buildBaseRecord(),
      sync: {
        ...buildBaseRecord().sync,
        drift: [duplicateDiagnostic],
      },
    });

    const result = reconcileSharedIssueRecord(
      localRecord,
      normalizeRemoteIssue({
        number: 42,
        node_id: 'I_kwDOForge42',
        html_url: 'https://github.com/acme/forge/issues/42',
        title: 'Canonical title',
        body: 'Local body',
        labels: [{ name: 'sync' }],
        assignees: [{ login: 'octocat' }],
        milestone: { title: 'v2.0' },
        updated_at: '2026-04-24T10:00:00Z',
      }),
    );

    expect(result.record.sync.drift).toEqual([duplicateDiagnostic]);
  });

  test('caps drift history at the most recent 50 entries', () => {
    const existingDrift = Array.from({ length: 60 }, (_, index) => ({
      type: 'previous-drift',
      field: `field-${index}`,
    }));

    const localRecord = buildSharedIssueRecord({
      ...buildBaseRecord(),
      sync: {
        ...buildBaseRecord().sync,
        drift: existingDrift,
      },
    });

    const result = reconcileSharedIssueRecord(
      localRecord,
      normalizeRemoteIssue({
        number: 42,
        node_id: 'I_kwDOForge42',
        html_url: 'https://github.com/acme/forge/issues/42',
        title: 'Local title',
        body: 'Local body',
        labels: [{ name: 'sync' }],
        assignees: [{ login: 'octocat' }],
        milestone: { title: 'v2.0' },
        updated_at: '2026-04-24T10:00:00Z',
      }),
    );

    expect(result.record.sync.drift).toHaveLength(50);
    expect(result.record.sync.drift[0]).toEqual({
      type: 'previous-drift',
      field: 'field-10',
    });
    expect(result.record.sync.drift.at(-1)).toEqual({
      type: 'previous-drift',
      field: 'field-59',
    });
  });
});
