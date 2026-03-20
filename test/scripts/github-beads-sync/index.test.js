import { describe, it, expect } from 'bun:test';
import { handleOpened, handleClosed } from '../../../scripts/github-beads-sync/index.mjs';

// ---------------------------------------------------------------------------
// Helpers: fake event builders
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers: mock dependency factories
// ---------------------------------------------------------------------------

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

function makeOptions(overrides = {}) {
  return {
    configPath: undefined,
    mappingPath: '/tmp/test-mapping.json',
    owner: 'testowner',
    repo: 'testrepo',
    bd: makeMockBd(overrides.bd),
    github: makeMockGithub(overrides.github),
    mapping: makeMockMapping(overrides.mapping),
    ...overrides,
  };
}

// ===========================================================================
// handleOpened
// ===========================================================================
describe('handleOpened', () => {
  it('happy path — creates beads issue, updates mapping, posts comment', async () => {
    const bdCreateCalls = [];
    const setBeadsIdCalls = [];
    const createOrEditCalls = [];

    const opts = makeOptions({
      bd: {
        bdCreate: (o) => { bdCreateCalls.push(o); return 'forge-abc123'; },
      },
      github: {
        findSyncComment: () => null,
        createOrEditComment: (ow, re, num, body) => { createOrEditCalls.push({ ow, re, num, body }); },
      },
      mapping: {
        getBeadsId: () => null,
        setBeadsId: (p, num, id) => { setBeadsIdCalls.push({ p, num, id }); },
      },
    });

    const event = makeOpenedEvent();
    const result = await handleOpened(event, opts);

    expect(result.success).toBe(true);
    expect(result.beadsId).toBe('forge-abc123');
    expect(result.issueNumber).toBe(42);

    // bdCreate was called with sanitized title and mapped type/priority
    expect(bdCreateCalls.length).toBe(1);
    expect(bdCreateCalls[0].title).toBe('Fix the thing');
    expect(bdCreateCalls[0].type).toBe('bug');
    expect(bdCreateCalls[0].priority).toBe(1);
    expect(bdCreateCalls[0].externalRef).toBe('gh-42');

    // mapping updated
    expect(setBeadsIdCalls.length).toBe(1);
    expect(setBeadsIdCalls[0].num).toBe(42);
    expect(setBeadsIdCalls[0].id).toBe('forge-abc123');

    // comment posted
    expect(createOrEditCalls.length).toBe(1);
    expect(createOrEditCalls[0].num).toBe(42);
    expect(createOrEditCalls[0].body).toContain('forge-abc123');
  });

  it('skips bot actor (contains [bot])', async () => {
    const event = makeOpenedEvent({ sender: { login: 'dependabot[bot]' } });
    const result = await handleOpened(event, makeOptions());

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('bot actor');
  });

  it('skips bot actor (github-actions)', async () => {
    const event = makeOpenedEvent({ sender: { login: 'github-actions' } });
    const result = await handleOpened(event, makeOptions());

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('bot actor');
  });

  it('skips when issue has skip-beads-sync label', async () => {
    const event = makeOpenedEvent({
      issue: { labels: [{ name: 'bug' }, { name: 'skip-beads-sync' }] },
    });
    const result = await handleOpened(event, makeOptions());

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('skip label');
  });

  it('skips when body contains no-beads', async () => {
    const event = makeOpenedEvent({
      issue: { body: 'This issue has no-beads tracking needed' },
    });
    const result = await handleOpened(event, makeOptions());

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no-beads in body');
  });

  it('idempotent — existing sync comment returns skip', async () => {
    const opts = makeOptions({
      github: {
        findSyncComment: () => ({
          id: 999,
          body: '<!-- beads-sync:42 -->\n**Beads:** `forge-existing`',
        }),
        createOrEditComment: () => {},
      },
    });

    const event = makeOpenedEvent();
    const result = await handleOpened(event, opts);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('already synced');
    expect(result.beadsId).toBe('forge-existing');
  });

  it('skips unauthorized author with author_association gate', async () => {
    const opts = makeOptions({
      configPath: undefined,
    });
    // We need a config that has publicRepoGate = 'author_association'
    // Override by passing a custom configPath that doesn't exist (defaults) then override config
    // Better approach: use a config override in options
    const event = makeOpenedEvent({
      issue: { author_association: 'NONE' },
    });

    // We need to set publicRepoGate on the config. Since loadConfig returns defaults
    // with publicRepoGate: 'none', we need a config file or a config override.
    // Let's use the configOverride option pattern.
    opts.configOverride = { publicRepoGate: 'author_association' };

    const result = await handleOpened(event, opts);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('author not authorized');
  });
});

// ===========================================================================
// handleClosed
// ===========================================================================
describe('handleClosed', () => {
  it('happy path — reads mapping and closes beads issue', async () => {
    const bdCloseCalls = [];

    const opts = makeOptions({
      bd: {
        bdClose: (id, reason) => { bdCloseCalls.push({ id, reason }); },
        bdShow: () => 'open',
      },
      mapping: {
        getBeadsId: () => 'forge-abc123',
      },
    });

    const event = makeClosedEvent();
    const result = await handleClosed(event, opts);

    expect(result.success).toBe(true);
    expect(result.beadsId).toBe('forge-abc123');
    expect(result.issueNumber).toBe(42);

    expect(bdCloseCalls.length).toBe(1);
    expect(bdCloseCalls[0].id).toBe('forge-abc123');
    expect(bdCloseCalls[0].reason).toContain('#42');
  });

  it('fallback — no mapping, falls back to comment parsing', async () => {
    const bdCloseCalls = [];

    const opts = makeOptions({
      bd: {
        bdClose: (id, reason) => { bdCloseCalls.push({ id, reason }); },
        bdShow: () => 'open',
      },
      mapping: {
        getBeadsId: () => null,
      },
      github: {
        findSyncComment: () => ({
          id: 999,
          body: '<!-- beads-sync:42 -->\n**Beads:** `forge-fromcomment`',
        }),
      },
    });

    const event = makeClosedEvent();
    const result = await handleClosed(event, opts);

    expect(result.success).toBe(true);
    expect(result.beadsId).toBe('forge-fromcomment');

    expect(bdCloseCalls.length).toBe(1);
    expect(bdCloseCalls[0].id).toBe('forge-fromcomment');
  });

  it('skips when no beads link found', async () => {
    const opts = makeOptions({
      mapping: { getBeadsId: () => null },
      github: { findSyncComment: () => null },
    });

    const event = makeClosedEvent();
    const result = await handleClosed(event, opts);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no beads link found');
  });

  it('skips when beads issue already closed', async () => {
    const opts = makeOptions({
      bd: {
        bdShow: () => 'closed',
        bdClose: () => { throw new Error('should not be called'); },
      },
      mapping: { getBeadsId: () => 'forge-abc123' },
    });

    const event = makeClosedEvent();
    const result = await handleClosed(event, opts);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('already closed');
  });

  it('skips bot actor', async () => {
    const event = makeClosedEvent({ sender: { login: 'renovate[bot]' } });
    const result = await handleClosed(event, makeOptions());

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('bot actor');
  });
});
