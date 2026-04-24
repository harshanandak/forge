const { describe, test, expect } = require('bun:test');

const { buildSharedIssueRecord } = require('../../lib/issue-sync/schema.js');
const { createLinkStore } = require('../../lib/issue-sync/link-store.js');
const { reconcileSharedIssueRecord } = require('../../lib/issue-sync/reconcile.js');
const {
  listRemoteIssues,
  normalizeRemoteIssue,
  resolveSharedLink,
  materializeLocalIssue,
} = require('../../lib/issue-sync/import-primitives.js');

describe('import primitives', () => {
  test('normalize and materialize a remote GitHub issue page through the steady-state reconciliation path', () => {
    const remotePage = {
      nodes: [
        {
          number: 42,
          node_id: 'MDU6SXNzdWUxMjM0NTY=',
          html_url: 'https://github.com/acme/repo/issues/42',
          title: 'Import existing issue',
          body: 'Imported from GitHub',
          state: 'open',
          assignees: [{ login: 'octocat' }],
          labels: [{ name: 'bug' }, { name: 'triaged' }],
          milestone: { title: 'v1' },
          updated_at: '2026-04-24T10:00:00Z',
        },
      ],
    };

    const remoteIssues = listRemoteIssues(remotePage);
    expect(remoteIssues).toHaveLength(1);
    expect(remoteIssues[0].number).toBe(42);

    const normalizedRemoteIssue = normalizeRemoteIssue(remoteIssues[0]);
    expect(normalizedRemoteIssue.github.number).toBe(42);
    expect(normalizedRemoteIssue.shared.title).toBe('Import existing issue');
    expect(normalizedRemoteIssue.shared.assignees).toEqual(['octocat']);

    const linkStore = createLinkStore([
      {
        forgeIssueId: 'forge-123',
        github: {
          nodeId: 'MDU6SXNzdWUxMjM0NTY=',
          number: 42,
          url: 'https://github.com/acme/repo/issues/42',
        },
      },
    ]);

    const resolvedLink = resolveSharedLink(linkStore, normalizedRemoteIssue);
    expect(resolvedLink?.forgeIssueId).toBe('forge-123');

    const localRecord = buildSharedIssueRecord({
      forge: {
        issueId: 'forge-123',
        workflowStage: 'in_progress',
        progressNotes: ['keep me'],
      },
    });

    const imported = materializeLocalIssue(localRecord, normalizedRemoteIssue, linkStore);
    const steadyState = reconcileSharedIssueRecord(localRecord, normalizedRemoteIssue);

    expect(imported.link?.forgeIssueId).toBe('forge-123');
    expect(imported.diagnostics).toEqual(steadyState.diagnostics);
    expect(imported.record).toEqual(steadyState.record);
    expect(imported.record.cache.githubSnapshot).toEqual(normalizedRemoteIssue);
    expect(imported.record.cache.materializedIssue).toEqual(steadyState.record.cache.materializedIssue);
  });
});
