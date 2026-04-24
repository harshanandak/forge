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

  test('prefers the incoming canonical identity when collapsing duplicate records', () => {
    const store = createLinkStore();
    const forgeRecord = {
      forgeIssueId: 'forge-nlgg',
      github: {
        nodeId: 'I_kwDOForge42Primary',
        number: null,
        url: 'https://github.com/acme/forge/issues/42',
      },
      sources: [
        { source: 'mapping', githubNodeId: 'I_kwDOForge42Primary', forgeIssueId: 'forge-nlgg' },
      ],
      diagnostics: [],
    };
    const numberRecord = {
      forgeIssueId: null,
      github: {
        nodeId: 'I_kwDOForge42Stale',
        number: 42,
        url: 'https://github.com/acme/forge/issues/42?stale=1',
      },
      sources: [
        { source: 'syncComment', githubNodeId: 'I_kwDOForge42Stale', githubNumber: 42 },
      ],
      diagnostics: [],
    };

    store.records.push(forgeRecord, numberRecord);
    store.byForgeIssueId.set('forge-nlgg', forgeRecord);
    store.byGitHubNodeId.set('I_kwDOForge42Primary', forgeRecord);
    store.byGitHubNodeId.set('I_kwDOForge42Stale', numberRecord);
    store.byGitHubNumber.set(42, numberRecord);

    const link = upsertCanonicalLink(store, {
      forgeIssueId: 'forge-nlgg',
      github: {
        nodeId: 'I_kwDOForge42Incoming',
        number: 42,
        url: 'https://github.com/acme/forge/issues/42?incoming=1',
      },
      sources: [
        { source: 'externalRef', githubNumber: 42, forgeIssueId: 'forge-nlgg' },
      ],
    });

    expect(link).toEqual({
      forgeIssueId: 'forge-nlgg',
      github: {
        nodeId: 'I_kwDOForge42Incoming',
        number: 42,
        url: 'https://github.com/acme/forge/issues/42?incoming=1',
      },
      sources: [
        { source: 'externalRef', githubNumber: 42, forgeIssueId: 'forge-nlgg' },
        { source: 'mapping', githubNodeId: 'I_kwDOForge42Primary', forgeIssueId: 'forge-nlgg' },
        { source: 'syncComment', githubNodeId: 'I_kwDOForge42Stale', githubNumber: 42 },
      ],
      diagnostics: [],
    });
    expect(listCanonicalLinks(store)).toEqual([link]);
    expect(resolveCanonicalLink(store, { forgeIssueId: 'forge-nlgg' })).toEqual(link);
    expect(resolveCanonicalLink(store, { githubNodeId: 'I_kwDOForge42Incoming' })).toEqual(link);
    expect(resolveCanonicalLink(store, { githubNumber: 42 })).toEqual(link);
  });
});
