const { describe, expect, test } = require('bun:test');

const { normalizeRemoteIssue } = require('../../lib/issue-sync/github-pull.js');

describe('github pull normalization', () => {
  test('normalizes a GitHub issue payload into shared record inputs', () => {
    const normalized = normalizeRemoteIssue({
      number: 42,
      node_id: 'I_kwDOForge42',
      html_url: 'https://github.com/acme/forge/issues/42',
      title: 'Canonical title',
      body: 'Canonical body',
      state: 'closed',
      assignee: {
        login: 'octocat',
      },
      assignees: [
        { login: 'octocat' },
        { login: 'hubot' },
      ],
      labels: [
        { name: 'sync' },
        { name: 'priority' },
      ],
      milestone: {
        title: 'v2.0',
      },
      updated_at: '2026-04-24T10:00:00Z',
      state_reason: 'completed',
    });

    expect(normalized).toEqual({
      github: {
        number: 42,
        nodeId: 'I_kwDOForge42',
        url: 'https://github.com/acme/forge/issues/42',
      },
      shared: {
        title: 'Canonical title',
        body: 'Canonical body',
        state: 'closed',
        assignees: ['octocat', 'hubot'],
        labels: ['sync', 'priority'],
        milestone: 'v2.0',
      },
      sync: {
        remoteUpdatedAt: '2026-04-24T10:00:00Z',
      },
    });
  });

  test('ignores API URLs and handles partial payloads gracefully', () => {
    const normalized = normalizeRemoteIssue({
      number: 42,
      node_id: 'I_kwDOForge42',
      url: 'https://api.github.com/repos/acme/forge/issues/42',
      assignee: {
        login: 'octocat',
      },
      labels: [],
    });

    expect(normalized).toEqual({
      github: {
        number: 42,
        nodeId: 'I_kwDOForge42',
        url: null,
      },
      shared: {
        title: '',
        body: '',
        state: 'open',
        assignees: ['octocat'],
        labels: [],
        milestone: null,
      },
      sync: {
        remoteUpdatedAt: null,
      },
    });
  });

  test('normalizes GraphQL identity plus connection-shaped assignees and labels', () => {
    const normalized = normalizeRemoteIssue({
      number: 77,
      id: 'I_kwDOForge77',
      url: 'https://github.com/acme/forge/issues/77',
      assignees: {
        edges: [
          { node: { login: 'octocat' } },
          { node: { login: 'hubot' } },
        ],
      },
      labels: {
        nodes: [
          { name: 'sync' },
          { name: 'sync' },
          { name: 'import' },
        ],
      },
    });

    expect(normalized).toEqual({
      github: {
        number: 77,
        nodeId: 'I_kwDOForge77',
        url: 'https://github.com/acme/forge/issues/77',
      },
      shared: {
        title: '',
        body: '',
        state: 'open',
        assignees: ['octocat', 'hubot'],
        labels: ['sync', 'import'],
        milestone: null,
      },
      sync: {
        remoteUpdatedAt: null,
      },
    });
  });
});
