const { describe, expect, test } = require('bun:test');

const {
  createLinkStore,
  listCanonicalLinks,
  resolveCanonicalLink,
} = require('../../lib/issue-sync/link-store.js');
const { bridgeLegacyLinkHints } = require('../../lib/issue-sync/legacy-link-bridge.js');

describe('legacy link bridge', () => {
  test('collapses conflicting legacy hints into one canonical record and drift diagnostic', () => {
    const store = createLinkStore();

    const result = bridgeLegacyLinkHints({
      forgeIssueId: 'forge-nlgg',
      mapping: {
        forgeIssueId: 'forge-nlgg',
        githubNumber: 42,
      },
      githubIssue: 42,
      syncComments: [
        {
          beadsId: 'forge-nlgg',
          githubNumber: 42,
          body: 'Synced as gh-42',
        },
        {
          beadsId: 'forge-nlgg',
          githubNumber: 77,
          body: 'Stale sync marker gh-77',
        },
      ],
      externalRef: 'gh-42',
      description: 'Linked issue: https://github.com/acme/forge/issues/99',
    }, { store });

    expect(result.link).toEqual({
      forgeIssueId: 'forge-nlgg',
      github: {
        nodeId: null,
        number: 42,
        url: 'https://github.com/acme/forge/issues/42',
      },
      sources: [
        { source: 'mapping', githubNumber: 42, forgeIssueId: 'forge-nlgg' },
        { source: 'githubIssue', githubNumber: 42, forgeIssueId: 'forge-nlgg' },
        { source: 'syncComment', githubNumber: 42, forgeIssueId: 'forge-nlgg' },
        { source: 'syncComment', githubNumber: 77, forgeIssueId: 'forge-nlgg' },
        { source: 'externalRef', githubNumber: 42, forgeIssueId: 'forge-nlgg' },
        {
          source: 'descriptionUrl',
          githubNumber: 99,
          forgeIssueId: 'forge-nlgg',
          url: 'https://github.com/acme/forge/issues/99',
        },
      ],
      diagnostics: [
        {
          type: 'legacy-link-drift',
          field: 'github.number',
          selected: { source: 'externalRef', value: 42 },
          conflicts: [
            { source: 'syncComment', value: 77 },
            { source: 'descriptionUrl', value: 99 },
          ],
        },
      ],
    });
    expect(result.diagnostics).toEqual(result.link.diagnostics);
    expect(listCanonicalLinks(store)).toHaveLength(1);
    expect(resolveCanonicalLink(store, { forgeIssueId: 'forge-nlgg' })).toEqual(result.link);
    expect(resolveCanonicalLink(store, { githubNumber: 42 })).toEqual(result.link);
  });
});
