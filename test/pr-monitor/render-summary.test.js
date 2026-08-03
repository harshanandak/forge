'use strict';

const { describe, test, expect } = require('bun:test');

const { renderSummary } = require('../../lib/pr-monitor/render-summary');

/**
 * Build a minimal bundle in the exact shape gatherPrBundle emits
 * (see lib/pr-bundle.js). Only the fields the summary renderer reads are
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

describe('renderSummary', () => {
  test('renders a deterministic Actions summary without a sticky marker or comment API language', () => {
    const { body } = renderSummary(makeBundle(), { now: NOW, verdict: 'CLEAN-MERGEABLE' });
    expect(body).toContain('Forge PR Monitor');
    expect(body).toContain('clean-mergeable');
    expect(body).toContain('Updated 2026-07-15T10:00:00.000Z');
    expect(body).not.toContain('<!-- forge-pr-monitor -->');
    expect(body.toLowerCase()).not.toContain('sticky comment');
    expect(body.toLowerCase()).toContain('does not merge');
  });

  test('an UNKNOWN verdict names which signal(s) were unreadable', () => {
    const { body } = renderSummary(makeBundle(), {
      now: NOW,
      verdict: 'UNKNOWN',
      unreadable: ['requiredChecks'],
    });
    expect(body).toContain('requiredChecks');
    expect(body).toMatch(/[Uu]nreadable/);
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
    const { body } = renderSummary(bundle, { now: NOW });
    expect(body).toContain('4');
    expect(body).toContain('coderabbitai');
    expect(body).toContain('greptile-apps');
    expect(body).toContain('a-human');
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
    const { body } = renderSummary(bundle, { now: NOW });
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
    const { body } = renderSummary(bundle, { now: NOW });
    expect(body.toLowerCase()).toContain('unreadable');
    expect(body).toContain('GraphQL 502');
    expect(body.toLowerCase()).not.toContain('no unresolved review threads');
  });

  test('unread CI never renders a false clean check state', () => {
    const bundle = makeBundle({ ciAvailable: false, ci: { checks: [], failing: [], pending: [] } });
    const { body } = renderSummary(bundle, { now: NOW });
    expect(body.toLowerCase()).not.toContain('no failing or pending checks');
    expect(body.toLowerCase()).toContain('checks were **unreadable**'.toLowerCase());
  });

  test('missing availability flags remain fail-closed', () => {
    const bundle = makeBundle();
    delete bundle.ciAvailable;
    delete bundle.unresolvedCommentsAvailable;
    const { body } = renderSummary(bundle, { now: NOW });
    expect(body.toLowerCase()).not.toContain('no failing or pending checks');
    expect(body.toLowerCase()).not.toContain('no unresolved review threads');
    expect(body.toLowerCase()).toContain('unreadable');
  });

  test('surfaces branch lag and never presents merge authority', () => {
    const { body } = renderSummary(makeBundle({ branch: { ahead: 0, behind: 2 } }), { now: NOW });
    expect(body).toContain('2');
    expect(body.toLowerCase()).toContain('does not merge');
    expect(body.toLowerCase()).not.toContain('approved');
  });

  test('output is deterministic for a fixed clock', () => {
    const a = renderSummary(makeBundle(), { now: NOW }).body;
    const b = renderSummary(makeBundle(), { now: NOW }).body;
    expect(a).toBe(b);
  });
});
