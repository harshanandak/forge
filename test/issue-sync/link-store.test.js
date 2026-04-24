const { describe, expect, test } = require('bun:test');

const {
  createLinkStore,
  listCanonicalLinks,
  resolveCanonicalLink,
  upsertCanonicalLink,
} = require('../../lib/issue-sync/link-store.js');

describe('canonical link store', () => {
  test('resolves one link by Forge issue ID, GitHub node ID, and GitHub number', () => {
    const store = createLinkStore();
    const link = upsertCanonicalLink(store, {
      forgeIssueId: 'forge-nlgg',
      github: {
        nodeId: 'I_kwDOForge42',
        number: 42,
        url: 'https://github.com/acme/forge/issues/42',
      },
    });

    expect(resolveCanonicalLink(store, { forgeIssueId: 'forge-nlgg' })).toEqual(link);
    expect(resolveCanonicalLink(store, { githubNodeId: 'I_kwDOForge42' })).toEqual(link);
    expect(resolveCanonicalLink(store, { githubNumber: 42 })).toEqual(link);
    expect(listCanonicalLinks(store)).toEqual([link]);
  });
});
