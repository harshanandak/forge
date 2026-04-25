/**
 * Integration tests for GitHub-Beads sync pipeline.
 * Uses realistic webhook fixture data and tests the full pipeline
 * through dependency injection (sanitize -> map -> create -> canonical link -> comment).
 *
 * @module test/scripts/github-beads-sync/integration
 */

import { describe, it, expect } from 'bun:test';
import { handleOpened, handleClosed } from '../../../scripts/github-beads-sync/index.mjs';

// ---------------------------------------------------------------------------
// Fixtures — loaded from JSON files
// ---------------------------------------------------------------------------

import issueOpenedFixture from './fixtures/issue-opened.json';
import issueClosedFixture from './fixtures/issue-closed.json';
import issueMaliciousFixture from './fixtures/issue-opened-malicious.json';

// ---------------------------------------------------------------------------
// DI mock factories (same pattern as index.test.js)
// ---------------------------------------------------------------------------

/**
 * Create mock bd functions with call recording.
 * @param {object} [overrides]
 * @returns {{ mocks: object, calls: object }}
 */
function makeMockBdWithCalls(overrides = {}) {
  const calls = { create: [], close: [], show: [] };
  return {
    mocks: {
      bdCreate: overrides.bdCreate ?? ((opts) => {
        calls.create.push(opts);
        return 'forge-integ001';
      }),
      bdClose: overrides.bdClose ?? ((id, reason) => {
        calls.close.push({ id, reason });
      }),
      bdShow: overrides.bdShow ?? ((id) => {
        calls.show.push(id);
        return 'open';
      }),
    },
    calls,
  };
}

/**
 * Create mock github functions with call recording.
 * @param {object} [overrides]
 * @returns {{ mocks: object, calls: object }}
 */
function makeMockGithubWithCalls(overrides = {}) {
  const calls = { findSyncComment: [], createOrEditComment: [] };
  return {
    mocks: {
      findSyncComment: overrides.findSyncComment ?? ((_ow, _re, num) => {
        calls.findSyncComment.push(num);
        return null;
      }),
      createOrEditComment: overrides.createOrEditComment ?? ((ow, re, num, body) => {
        calls.createOrEditComment.push({ ow, re, num, body });
      }),
    },
    calls,
  };
}

/**
 * Create mock canonical link store functions with call recording.
 * @param {object} [overrides]
 * @returns {{ mocks: object, calls: object }}
 */
function makeMockLinkStoreWithCalls(overrides = {}) {
  const calls = { resolve: [], upsert: [] };
  return {
    mocks: {
      resolveCanonicalLink: overrides.resolveCanonicalLink ?? ((lookup) => {
        calls.resolve.push(lookup);
        return null;
      }),
      upsertCanonicalLink: overrides.upsertCanonicalLink ?? ((link) => {
        calls.upsert.push(link);
        return link;
      }),
    },
    calls,
  };
}

/**
 * Build full options object with call-recording mocks.
 * @param {object} [overrides] - Override individual mock functions
 * @param {object} [configOverride] - Config overrides for testing
 * @returns {{ options: object, bdCalls: object, githubCalls: object, linkStoreCalls: object }}
 */
function makeTrackedOptions(overrides = {}, configOverride = undefined) {
  const { mocks: bdMocks, calls: bdCalls } = makeMockBdWithCalls(overrides.bd);
  const { mocks: githubMocks, calls: githubCalls } = makeMockGithubWithCalls(overrides.github);
  const { mocks: linkStoreMocks, calls: linkStoreCalls } = makeMockLinkStoreWithCalls(overrides.linkStore);

  return {
    options: {
      configPath: undefined,
      mappingPath: '/tmp/integration-test-mapping.json',
      owner: 'test-owner',
      repo: 'test-repo',
      bd: bdMocks,
      github: githubMocks,
      linkStore: linkStoreMocks,
      configOverride,
    },
    bdCalls,
    githubCalls,
    linkStoreCalls,
  };
}

// ===========================================================================
// Integration: Full opened pipeline
// ===========================================================================
describe('integration: full opened pipeline', () => {
  it('processes realistic webhook through sanitize -> map -> create -> canonical link -> comment', async () => {
    const { options, bdCalls, githubCalls, linkStoreCalls } = makeTrackedOptions();

    const result = await handleOpened(issueOpenedFixture, options);

    // Pipeline succeeded
    expect(result.success).toBe(true);
    expect(result.beadsId).toBe('forge-integ001');
    expect(result.issueNumber).toBe(42);

    // bd.create was called with correctly mapped fields
    expect(bdCalls.create).toHaveLength(1);
    const createArgs = bdCalls.create[0];
    expect(createArgs.title).toBe('Add dark mode support for dashboard');
    expect(createArgs.type).toBe('feature'); // "enhancement" label -> feature type
    expect(createArgs.priority).toBe(1);     // "P1" label -> priority 1
    expect(createArgs.assignee).toBe('developer-alice');
    expect(createArgs.description).toBe('https://github.com/test-owner/test-repo/issues/42');
    expect(createArgs.externalRef).toBe('gh-42');

    // Canonical link store was updated with the GitHub issue identity
    expect(linkStoreCalls.upsert).toHaveLength(1);
    expect(linkStoreCalls.upsert[0].forgeIssueId).toBe('forge-integ001');
    expect(linkStoreCalls.upsert[0].github.number).toBe(42);
    expect(linkStoreCalls.upsert[0].github.url).toBe('https://github.com/test-owner/test-repo/issues/42');

    // Sync comment was posted to GitHub
    expect(githubCalls.createOrEditComment).toHaveLength(1);
    const commentCall = githubCalls.createOrEditComment[0];
    expect(commentCall.ow).toBe('test-owner');
    expect(commentCall.re).toBe('test-repo');
    expect(commentCall.num).toBe(42);
    expect(commentCall.body).toContain('forge-integ001');
    expect(commentCall.body).toContain('beads-sync:42');
  });
});

// ===========================================================================
// Integration: Full closed pipeline
// ===========================================================================
describe('integration: full closed pipeline', () => {
  it('closes beads issue when a canonical link exists for the GitHub issue', async () => {
    const { options, bdCalls } = makeTrackedOptions({
      linkStore: {
        resolveCanonicalLink: () => ({
          forgeIssueId: 'forge-integ001',
          github: {
            number: 42,
            url: 'https://github.com/test-owner/test-repo/issues/42',
          },
        }),
      },
    });

    const result = await handleClosed(issueClosedFixture, options);

    expect(result.success).toBe(true);
    expect(result.beadsId).toBe('forge-integ001');
    expect(result.issueNumber).toBe(42);

    // bd.show was called to check status
    expect(bdCalls.show).toHaveLength(1);
    expect(bdCalls.show[0]).toBe('forge-integ001');

    // bd.close was called with correct reason
    expect(bdCalls.close).toHaveLength(1);
    expect(bdCalls.close[0].id).toBe('forge-integ001');
    expect(bdCalls.close[0].reason).toContain('#42');
  });
});

// ===========================================================================
// Integration: Closed with missing canonical link
// ===========================================================================
describe('integration: closed without canonical link', () => {
  it('closes when no canonical link exists but a matching sync comment is available', async () => {
    const { options, bdCalls, linkStoreCalls } = makeTrackedOptions({
      linkStore: {
        resolveCanonicalLink: () => null,
      },
      github: {
        findSyncComment: () => ({
          id: 12345,
          body: '<!-- beads-sync:42 -->\n**Beads:** `forge-fromcomment`\n<details>\n<summary>Sync details</summary>\n\n- Type: feature\n- Priority: 1\n- External ref: gh-42\n- Synced: 2026-03-21T00:00:00.000Z\n\n</details>',
        }),
      },
    });

    const result = await handleClosed(issueClosedFixture, options);

    expect(result).toMatchObject({
      success: true,
      beadsId: 'forge-fromcomment',
      issueNumber: 42,
    });
    expect(linkStoreCalls.upsert).toHaveLength(1);
    expect(linkStoreCalls.upsert[0].forgeIssueId).toBe('forge-fromcomment');
    expect(bdCalls.close).toEqual([
      {
        id: 'forge-fromcomment',
        reason: 'Closed via GitHub issue #42',
      },
    ]);
  });

  it('skips when a sync comment exists but its tagged issue number does not match the closed issue', async () => {
    const { options, bdCalls, linkStoreCalls } = makeTrackedOptions({
      linkStore: {
        resolveCanonicalLink: () => null,
      },
      github: {
        findSyncComment: () => ({
          id: 12345,
          body: '<!-- beads-sync:99 -->\n**Beads:** `forge-fromcomment`\n<details>\n<summary>Sync details</summary>\n\n- Type: feature\n- Priority: 1\n- External ref: gh-99\n- Synced: 2026-03-21T00:00:00.000Z\n\n</details>',
        }),
      },
    });

    const result = await handleClosed(issueClosedFixture, options);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no beads link found');
    expect(linkStoreCalls.upsert).toHaveLength(0);
    expect(bdCalls.close).toHaveLength(0);
  });
});

// ===========================================================================
// Integration: Malicious input pipeline
// ===========================================================================
describe('integration: malicious input sanitization', () => {
  it('strips shell metacharacters and expression injection from title', async () => {
    const { options, bdCalls } = makeTrackedOptions();

    const result = await handleOpened(issueMaliciousFixture, options);

    expect(result.success).toBe(true);
    expect(result.beadsId).toBe('forge-integ001');

    // bd.create was called with sanitized title
    expect(bdCalls.create).toHaveLength(1);
    const title = bdCalls.create[0].title;

    // Shell metacharacters must be stripped: ; | & $ ` ( ) < >
    expect(title).not.toContain(';');
    expect(title).not.toContain('|');
    expect(title).not.toContain('&&');
    expect(title).not.toContain('$');
    expect(title).not.toContain('`');

    // The safe words should survive sanitization
    expect(title).toContain('Fix bug');
    expect(title).toContain('rm -rf');
    expect(title).toContain('curl');

    // Type should map from "bug" label
    expect(bdCalls.create[0].type).toBe('bug');
    expect(bdCalls.create[0].externalRef).toBe('gh-99');

    // Assignee should be null/undefined since fixture has assignee: null
    expect(bdCalls.create[0].assignee).toBeUndefined();
  });

  it('strips ${{ }} expression patterns from malicious body (used in description via htmlUrl)', async () => {
    // Note: handleOpened uses html_url as description, not body.
    // But the title sanitization is critical. Verify body content
    // is NOT passed to bd.create (only html_url is).
    const { options, bdCalls } = makeTrackedOptions();

    await handleOpened(issueMaliciousFixture, options);

    // Description should be the html_url, not the body
    expect(bdCalls.create[0].description).toBe(
      'https://github.com/test-owner/test-repo/issues/99',
    );
  });
});

// ===========================================================================
// Integration: Author association gate
// ===========================================================================
describe('integration: author_association gate', () => {
  it('skips issue from unauthorized author when publicRepoGate is enabled', async () => {
    const { options, bdCalls } = makeTrackedOptions(
      {},
      { publicRepoGate: 'author_association' },
    );

    // Malicious fixture has author_association: "NONE" — not in default gate list
    const result = await handleOpened(issueMaliciousFixture, options);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('author not authorized');

    // bd.create should NOT have been called
    expect(bdCalls.create).toHaveLength(0);
  });

  it('allows issue from authorized author when publicRepoGate is enabled', async () => {
    const { options, bdCalls } = makeTrackedOptions(
      {},
      { publicRepoGate: 'author_association' },
    );

    // Opened fixture has author_association: "MEMBER" — in default gate list
    const result = await handleOpened(issueOpenedFixture, options);

    expect(result.success).toBe(true);
    expect(bdCalls.create).toHaveLength(1);
  });
});
