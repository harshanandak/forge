const { describe, expect, test } = require('bun:test');

const {
  createLinkStore,
  listCanonicalLinks,
  resolveCanonicalLink,
} = require('../../lib/issue-sync/link-store.js');
const { bridgeLegacyLinkHints } = require('../../lib/issue-sync/legacy-link-bridge.js');

describe('legacy link bridge', () => {
  test('hydrates one canonical record per legacy mapping entry when seeded from mapping only', () => {
    const store = createLinkStore();

    const result = bridgeLegacyLinkHints({
      mapping: {
        7: 'forge-seven',
        42: 'forge-forty-two',
      },
    }, { store });

    expect(result.links).toHaveLength(2);
    expect(listCanonicalLinks(store)).toHaveLength(2);
    expect(resolveCanonicalLink(store, { githubNumber: 7 })).toEqual({
      forgeIssueId: 'forge-seven',
      github: {
        nodeId: null,
        number: 7,
        url: null,
      },
      sources: [
        {
          source: 'mapping',
          forgeIssueId: 'forge-seven',
          githubNumber: 7,
        },
      ],
      diagnostics: [],
    });
    expect(resolveCanonicalLink(store, { forgeIssueId: 'forge-forty-two' })).toEqual({
      forgeIssueId: 'forge-forty-two',
      github: {
        nodeId: null,
        number: 42,
        url: null,
      },
      sources: [
        {
          source: 'mapping',
          forgeIssueId: 'forge-forty-two',
          githubNumber: 42,
        },
      ],
      diagnostics: [],
    });
  });

  test('collapses conflicting legacy hints into one canonical record and drift diagnostic', () => {
    const store = createLinkStore([
      {
        forgeIssueId: 'forge-nlgg',
        github: {
          nodeId: 'I_kwDOForge41Existing',
          number: 41,
          url: 'https://github.com/acme/forge/issues/41',
        },
      },
    ]);

    const result = bridgeLegacyLinkHints({
      forgeIssueId: 'forge-nlgg',
      github: {
        nodeId: 'I_kwDOForge42Primary',
        number: 42,
        url: 'https://github.com/acme/forge/issues/42',
      },
      mapping: {
        42: 'forge-nlgg',
        7: 'forge-other',
      },
      github_issue: 42,
      syncComments: [
        {
          beadsId: 'forge-nlgg',
          githubNumber: 42,
          githubNodeId: 'I_kwDOForge42Stale',
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
        nodeId: 'I_kwDOForge42Primary',
        number: 42,
        url: 'https://github.com/acme/forge/issues/42',
      },
      sources: [
        {
          source: 'githubNodeId',
          githubNumber: 42,
          githubNodeId: 'I_kwDOForge42Primary',
          forgeIssueId: 'forge-nlgg',
          url: 'https://github.com/acme/forge/issues/42',
        },
        {
          source: 'mapping',
          githubNumber: 42,
          forgeIssueId: 'forge-nlgg',
        },
        { source: 'githubIssue', githubNumber: 42, forgeIssueId: 'forge-nlgg' },
        {
          source: 'syncComment',
          githubNumber: 42,
          githubNodeId: 'I_kwDOForge42Stale',
          forgeIssueId: 'forge-nlgg',
        },
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
          field: 'github.nodeId',
          selected: { source: 'githubNodeId', value: 'I_kwDOForge42Primary' },
          conflicts: [
            { source: 'existing', value: 'I_kwDOForge41Existing' },
            { source: 'syncComment', value: 'I_kwDOForge42Stale' },
          ],
        },
        {
          type: 'legacy-link-drift',
          field: 'github.number',
          selected: { source: 'githubNodeId', value: 42 },
          conflicts: [
            { source: 'existing', value: 41 },
            { source: 'syncComment', value: 77 },
            { source: 'descriptionUrl', value: 99 },
          ],
        },
      ],
    });
    expect(result.diagnostics).toEqual(result.link.diagnostics);
    expect(listCanonicalLinks(store)).toHaveLength(1);
    expect(resolveCanonicalLink(store, { forgeIssueId: 'forge-nlgg' })).toEqual(result.link);
    expect(resolveCanonicalLink(store, { githubNodeId: 'I_kwDOForge42Primary' })).toEqual(result.link);
    expect(resolveCanonicalLink(store, { githubNumber: 42 })).toEqual(result.link);
  });

  test('does not synthesize a canonical url from an unrelated repository template', () => {
    const store = createLinkStore();

    const result = bridgeLegacyLinkHints({
      forgeIssueId: 'forge-nlgg',
      mapping: 42,
      description: 'Linked issue: https://github.com/other/repo/issues/7',
    }, { store });

    expect(result.link.github).toEqual({
      nodeId: null,
      number: 42,
      url: null,
    });
  });
});
