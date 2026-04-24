import { describe, it, expect } from 'bun:test';
import { handleOpened, handleClosed } from '../../../scripts/github-beads-sync/index.mjs';

function makeOpenedEvent(overrides = {}) {
  return {
    sender: { login: 'octocat' },
    issue: {
      number: 42,
      title: 'Fix the thing',
      body: 'Detailed description here',
      labels: [{ name: 'bug' }, { name: 'P1' }],
      assignee: { login: 'alice' },
      html_url: 'https://github.com/owner/repo/issues/42',
      author_association: 'MEMBER',
      ...overrides.issue,
    },
    ...overrides,
  };
}

function makeClosedEvent(overrides = {}) {
  return {
    sender: { login: 'octocat' },
    issue: {
      number: 42,
      title: 'Fix the thing',
      body: '',
      labels: [],
      assignee: null,
      html_url: 'https://github.com/owner/repo/issues/42',
      author_association: 'MEMBER',
      ...overrides.issue,
    },
    ...overrides,
  };
}

function makeMockBd(overrides = {}) {
  return {
    bdCreate: overrides.bdCreate ?? (() => 'forge-abc123'),
    bdClose: overrides.bdClose ?? (() => {}),
    bdShow: overrides.bdShow ?? (() => 'open'),
  };
}

function makeMockGithub(overrides = {}) {
  return {
    findSyncComment: overrides.findSyncComment ?? (() => null),
    createOrEditComment: overrides.createOrEditComment ?? (() => {}),
  };
}

function makeMockMapping(overrides = {}) {
  return {
    getBeadsId: overrides.getBeadsId ?? (() => null),
    setBeadsId: overrides.setBeadsId ?? (() => {}),
  };
}

function makeMockLinkStore(overrides = {}) {
  return {
    resolveCanonicalLink: overrides.resolveCanonicalLink ?? (() => null),
    upsertCanonicalLink: overrides.upsertCanonicalLink ?? (() => ({})),
  };
}

function makeOptions(overrides = {}) {
  return {
    configPath: undefined,
    mappingPath: '/tmp/test-mapping.json',
    owner: 'testowner',
    repo: 'testrepo',
    bd: makeMockBd(overrides.bd),
    github: makeMockGithub(overrides.github),
    linkStore: makeMockLinkStore(overrides.linkStore),
    mapping: makeMockMapping(overrides.mapping),
    ...overrides,
  };
}

describe('handleOpened', () => {
  it('happy path - creates beads issue, upserts canonical link, posts comment', async () => {
    const bdCreateCalls = [];
    const upsertCanonicalLinkCalls = [];
    const createOrEditCalls = [];

    const opts = makeOptions({
      bd: {
        bdCreate: (o) => { bdCreateCalls.push(o); return 'forge-abc123'; },
      },
      github: {
        findSyncComment: () => null,
        createOrEditComment: (ow, re, num, body) => { createOrEditCalls.push({ ow, re, num, body }); },
      },
      linkStore: {
        resolveCanonicalLink: () => null,
        upsertCanonicalLink: (record) => { upsertCanonicalLinkCalls.push(record); return record; },
      },
      mapping: {
        getBeadsId: () => { throw new Error('legacy mapping should not be consulted on canonical writes'); },
        setBeadsId: () => { throw new Error('legacy mapping should not be written on canonical writes'); },
      },
    });

    const result = await handleOpened(makeOpenedEvent(), opts);

    expect(result.success).toBe(true);
    expect(result.beadsId).toBe('forge-abc123');
    expect(result.issueNumber).toBe(42);
    expect(bdCreateCalls).toHaveLength(1);
    expect(bdCreateCalls[0].title).toBe('Fix the thing');
    expect(bdCreateCalls[0].type).toBe('bug');
    expect(bdCreateCalls[0].priority).toBe(1);
    expect(bdCreateCalls[0].externalRef).toBe('gh-42');
    expect(upsertCanonicalLinkCalls).toHaveLength(1);
    expect(upsertCanonicalLinkCalls[0].forgeIssueId).toBe('forge-abc123');
    expect(upsertCanonicalLinkCalls[0].github.number).toBe(42);
    expect(createOrEditCalls).toHaveLength(1);
    expect(createOrEditCalls[0].num).toBe(42);
    expect(createOrEditCalls[0].body).toContain('forge-abc123');
  });

  it('skips bot actor (contains [bot])', async () => {
    const result = await handleOpened(makeOpenedEvent({ sender: { login: 'dependabot[bot]' } }), makeOptions());

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('bot actor');
  });

  it('skips bot actor (github-actions)', async () => {
    const result = await handleOpened(makeOpenedEvent({ sender: { login: 'github-actions' } }), makeOptions());

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('bot actor');
  });

  it('skips when issue has skip-beads-sync label', async () => {
    const result = await handleOpened(makeOpenedEvent({
      issue: { labels: [{ name: 'bug' }, { name: 'skip-beads-sync' }] },
    }), makeOptions());

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('skip label');
  });

  it('skips when body contains no-beads', async () => {
    const result = await handleOpened(makeOpenedEvent({
      issue: { body: 'This issue has no-beads tracking needed' },
    }), makeOptions());

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no-beads in body');
  });

  it('idempotent - canonical link store entry returns skip', async () => {
    const opts = makeOptions({
      linkStore: {
        resolveCanonicalLink: () => ({
          forgeIssueId: 'forge-existing',
          github: {
            nodeId: 'node-42',
            number: 42,
            url: 'https://github.com/testowner/testrepo/issues/42',
          },
        }),
      },
      mapping: {
        getBeadsId: () => { throw new Error('legacy mapping should not be consulted when canonical link exists'); },
        setBeadsId: () => { throw new Error('legacy mapping should not be written when canonical link exists'); },
      },
      github: {
        findSyncComment: () => { throw new Error('sync comment lookup should not be needed when canonical link exists'); },
        createOrEditComment: () => { throw new Error('sync comment repair should not be needed when canonical link exists'); },
      },
      bd: {
        bdCreate: () => { throw new Error('bdCreate should not be called for canonical duplicates'); },
      },
    });

    const result = await handleOpened(makeOpenedEvent(), opts);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('already synced (canonical link)');
    expect(result.beadsId).toBe('forge-existing');
  });

  it('skips unauthorized author with author_association gate', async () => {
    const opts = makeOptions({
      configOverride: { publicRepoGate: 'author_association' },
    });
    const result = await handleOpened(makeOpenedEvent({
      issue: { author_association: 'NONE' },
    }), opts);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('author not authorized');
  });
});

describe('handleClosed', () => {
  it('happy path - reads canonical link store and closes beads issue', async () => {
    const bdCloseCalls = [];

    const opts = makeOptions({
      bd: {
        bdClose: (id, reason) => { bdCloseCalls.push({ id, reason }); },
        bdShow: () => 'open',
      },
      linkStore: {
        resolveCanonicalLink: () => ({
          forgeIssueId: 'forge-abc123',
          github: {
            nodeId: 'node-42',
            number: 42,
            url: 'https://github.com/testowner/testrepo/issues/42',
          },
        }),
      },
      mapping: {
        getBeadsId: () => { throw new Error('legacy mapping should not be consulted when canonical link exists'); },
      },
      github: {
        findSyncComment: () => { throw new Error('sync comment lookup should not be needed when canonical link exists'); },
      },
    });

    const result = await handleClosed(makeClosedEvent(), opts);

    expect(result.success).toBe(true);
    expect(result.beadsId).toBe('forge-abc123');
    expect(result.issueNumber).toBe(42);
    expect(bdCloseCalls).toHaveLength(1);
    expect(bdCloseCalls[0].id).toBe('forge-abc123');
    expect(bdCloseCalls[0].reason).toContain('#42');
  });

  it('skips when no canonical link exists even if a sync comment is present', async () => {
    const bdCloseCalls = [];

    const opts = makeOptions({
      bd: {
        bdClose: (id, reason) => { bdCloseCalls.push({ id, reason }); },
        bdShow: () => 'open',
      },
      github: {
        findSyncComment: () => {
          throw new Error('sync comment lookup should not be consulted when canonical link is missing');
        },
      },
      linkStore: {
        resolveCanonicalLink: () => null,
      },
    });

    const result = await handleClosed(makeClosedEvent(), opts);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no beads link found');
    expect(bdCloseCalls).toHaveLength(0);
  });

  it('skips when no beads link found', async () => {
    const result = await handleClosed(makeClosedEvent(), makeOptions({
      mapping: { getBeadsId: () => null },
      github: { findSyncComment: () => null },
    }));

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no beads link found');
  });

  it('skips when beads issue already closed', async () => {
    const result = await handleClosed(makeClosedEvent(), makeOptions({
      linkStore: {
        resolveCanonicalLink: () => ({
          forgeIssueId: 'forge-abc123',
          github: {
            nodeId: 'node-42',
            number: 42,
            url: 'https://github.com/testowner/testrepo/issues/42',
          },
        }),
      },
      bd: {
        bdShow: () => 'closed',
        bdClose: () => { throw new Error('should not be called'); },
      },
    }));

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('already closed');
  });

  it('skips bot actor', async () => {
    const result = await handleClosed(makeClosedEvent({ sender: { login: 'renovate[bot]' } }), makeOptions());

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('bot actor');
  });
});
