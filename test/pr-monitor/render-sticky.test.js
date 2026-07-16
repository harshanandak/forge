'use strict';

const { describe, test, expect } = require('bun:test');

const {
  renderStickyComment,
  STICKY_MARKER,
} = require('../../lib/pr-monitor/render-sticky');

/**
 * Build a minimal bundle in the exact shape gatherPrBundle emits
 * (see lib/pr-bundle.js). Only the fields the sticky renderer reads are
 * required; overrides let each test isolate one surface.
 */
function makeBundle(overrides = {}) {
  return {
    pr: '123',
    owner: 'acme',
    repo: 'forge',
    unresolvedComments: [],
    unresolvedCommentsAvailable: true,
    unresolvedCommentsError: null,
    mergeState: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', state: 'OPEN' },
    ciAvailable: true,
    ci: { checks: [], failing: [], pending: [] },
    branch: { ahead: 1, behind: 0 },
    conflicts: { supported: true, conflicted: false },
    ...overrides,
  };
}

const NOW = new Date('2026-07-15T10:00:00Z');

describe('renderStickyComment', () => {
  test('body begins with the hidden sticky marker so it can be updated in place', () => {
    const { body, marker } = renderStickyComment(makeBundle(), { now: NOW });
    expect(marker).toBe(STICKY_MARKER);
    expect(body.startsWith(STICKY_MARKER)).toBe(true);
  });

  test('groups unresolved threads BY AUTHOR across all authors (agnostic)', () => {
    const bundle = makeBundle({
      unresolvedComments: [
        { author: 'coderabbitai', path: 'a.js', line: 4, body: 'nit', threadId: 'T1', comments: [] },
        { author: 'coderabbitai', path: 'b.js', line: 9, body: 'fix', threadId: 'T2', comments: [] },
        { author: 'greptile-apps', path: 'c.js', line: 2, body: 'leak', threadId: 'T3', comments: [] },
        { author: 'a-human', path: 'd.js', line: null, body: 'change', threadId: 'T4', comments: [] },
      ],
    });
    const { body } = renderStickyComment(bundle, { now: NOW });
    // total surfaced
    expect(body).toContain('4');
    // every author is surfaced, none privileged
    expect(body).toContain('coderabbitai');
    expect(body).toContain('greptile-apps');
    expect(body).toContain('a-human');
    // per-author count for the author with two threads
    expect(body).toMatch(/coderabbitai[^\n]*2/);
  });

  test('lists failing and pending checks by name', () => {
    const bundle = makeBundle({
      ci: {
        checks: [],
        failing: [{ name: 'unit' }, { name: 'lint' }],
        pending: [{ name: 'bench' }],
      },
    });
    const { body } = renderStickyComment(bundle, { now: NOW });
    expect(body).toContain('unit');
    expect(body).toContain('lint');
    expect(body).toContain('bench');
  });

  test('unreadable review threads are surfaced as degraded, never as zero', () => {
    const bundle = makeBundle({
      unresolvedComments: [],
      unresolvedCommentsAvailable: false,
      unresolvedCommentsError: 'GraphQL 502',
    });
    const { body } = renderStickyComment(bundle, { now: NOW });
    expect(body.toLowerCase()).toContain('unreadable');
    expect(body).toContain('GraphQL 502');
    // must NOT claim a clean/zero state on unreadable data
    expect(body.toLowerCase()).not.toContain('no unresolved review threads');
  });

  test('unread CI (ciAvailable false) renders degraded, never a false "no failing checks"', () => {
    // Mirror of the thread bypass on the CHECK side: on a gather outage the
    // fallback bundle carries empty ci arrays. Without a guard renderChecks would
    // print "No failing or pending checks" for CI that was NEVER read — a literal
    // false-green claim in the monitor's own output.
    const bundle = makeBundle({ ciAvailable: false, ci: { checks: [], failing: [], pending: [] } });
    const { body } = renderStickyComment(bundle, { now: NOW });
    expect(body.toLowerCase()).not.toContain('no failing or pending checks');
    expect(body.toLowerCase()).toContain('checks were **unreadable**'.toLowerCase());
  });

  test('CI with a missing availability flag is treated as unread (producer-proof, fail-closed)', () => {
    const bundle = makeBundle();
    delete bundle.ciAvailable;
    const { body } = renderStickyComment(bundle, { now: NOW });
    expect(body.toLowerCase()).not.toContain('no failing or pending checks');
    expect(body.toLowerCase()).toContain('unreadable');
  });

  test('unavailable thread read with NO error string (capability absent) still renders degraded, never zero', () => {
    // The bypass: gatherUnresolvedComments returns { available:false, error:null }
    // when the adapter cannot read comments at all. A guard that also required a
    // truthy error would fall through to the empty-list "clean" render — a
    // misleading zero on data we genuinely could not read.
    const bundle = makeBundle({
      unresolvedComments: [],
      unresolvedCommentsAvailable: false,
      unresolvedCommentsError: null,
    });
    const { body } = renderStickyComment(bundle, { now: NOW });
    expect(body.toLowerCase()).not.toContain('no unresolved review threads');
    expect(body.toLowerCase()).toContain('unreadable');
  });

  test('leads with the actionable verdict headline from the passed-in --pull verdict', () => {
    // The verdict VALUE comes from pr-pull (opts.verdict); render-sticky only displays it.
    const cleanBody = renderStickyComment(makeBundle(), { now: NOW, verdict: 'CLEAN-MERGEABLE' }).body;
    expect(cleanBody).toContain('Verdict:');
    expect(cleanBody).toContain('clean-mergeable');
    const failBody = renderStickyComment(
      makeBundle({ ci: { checks: [], failing: [{ name: 'unit' }], pending: [] } }),
      { now: NOW, verdict: 'BLOCKED-CHECKS' },
    ).body;
    expect(failBody).toContain('blocked-checks');
    expect(failBody).toContain('unit'); // failing check is still named in the Checks section
  });

  test('a missing verdict falls closed to the unknown headline', () => {
    const body = renderStickyComment(makeBundle(), { now: NOW }).body;
    expect(body).toContain('unknown');
  });

  test('surfaces state but never a MERGE action — labels only, never merges/approves', () => {
    const { body } = renderStickyComment(makeBundle(), { now: NOW });
    expect(body.toLowerCase()).toContain('no unresolved review threads');
    // honest guarantee: it labels state but never claims to have merged/approved
    expect(body.toLowerCase()).not.toContain('approved');
    expect(body).not.toContain('✅ Ready to merge');
    expect(body.toLowerCase()).toContain('does not merge');
    expect(body.toLowerCase()).toContain('never resolves review threads');
  });

  test('output is deterministic for a fixed clock', () => {
    const a = renderStickyComment(makeBundle(), { now: NOW }).body;
    const b = renderStickyComment(makeBundle(), { now: NOW }).body;
    expect(a).toBe(b);
  });
});
