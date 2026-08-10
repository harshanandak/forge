'use strict';

const { describe, test, expect } = require('bun:test');

const {
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_CHECKS,
  MAX_SUMMARY_THREADS,
  renderSummary,
} = require('../../lib/pr-monitor/render-summary');

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
    const { body, evidenceStatus, threadState } = renderSummary(makeBundle(), { now: NOW, verdict: 'CLEAN-MERGEABLE' });
    expect(body).toContain('Forge PR Monitor');
    expect(body).toContain('clean-mergeable');
    expect(body).toContain('Updated 2026-07-15T10:00:00.000Z');
    expect(body).toContain('Detailed JSON: `forge shepherd 123 --pull --json`');
    expect(body).not.toContain('<!-- forge-pr-monitor -->');
    expect(body.toLowerCase()).not.toContain('sticky comment');
    expect(body.toLowerCase()).toContain('does not merge');
    expect(evidenceStatus).toBe('COMPLETE');
    expect(threadState).toBe('ZERO');
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
    const { body, evidenceStatus, threadState } = renderSummary(bundle, { now: NOW });
    expect(body.toLowerCase()).toContain('unreadable');
    expect(body).toContain('GraphQL 502');
    expect(body.toLowerCase()).not.toContain('no unresolved review threads');
    expect(evidenceStatus).toBe('INCOMPLETE');
    expect(threadState).toBe('INCOMPLETE');
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

  test('marks over-limit thread evidence incomplete while keeping its summary bounded', () => {
    const secret = 'ghp_123456789012345678901234567890';
    const unresolvedComments = Array.from({ length: MAX_SUMMARY_THREADS + 1 }, (_, index) => ({
      author: `reviewer-${index}-${secret}`,
      path: `C:\\Users\\alice\\private-${index}.js`,
      line: index,
      threadId: `thread-${index}`,
      comments: [],
    }));
    const first = renderSummary(makeBundle({
      unresolvedComments,
    }), { now: NOW, verdict: 'BLOCKED-THREADS' });
    const second = renderSummary(makeBundle({
      unresolvedComments,
    }), { now: NOW, verdict: 'BLOCKED-THREADS' });

    expect(first.body.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(first.body).not.toContain(secret);
    expect(first.body).not.toContain('alice');
    expect(first.body).toContain('more');
    expect(first.evidenceStatus).toBe('INCOMPLETE');
    expect(first.threadState).toBe('INCOMPLETE');
    expect(first).toEqual(second);
  });

  test('marks every over-limit check array incomplete', () => {
    for (const surface of ['checks', 'failing', 'pending']) {
      const ci = { checks: [], failing: [], pending: [] };
      ci[surface] = Array.from({ length: MAX_SUMMARY_CHECKS + 1 }, (_, index) => ({
        name: `${surface}-${index}`,
      }));

      expect(renderSummary(makeBundle({ ci }), { now: NOW })).toMatchObject({
        evidenceStatus: 'INCOMPLETE',
        threadState: 'ZERO',
      });
    }
  });

  test('redacts hostile check evidence', () => {
    const secret = 'ghp_123456789012345678901234567890';
    const { body, evidenceStatus } = renderSummary(makeBundle({
      ci: { checks: [], failing: [{ name: `check-${secret}` }], pending: [] },
    }), { now: NOW });

    expect(body).not.toContain(secret);
    expect(body).toContain('[REDACTED]');
    expect(evidenceStatus).toBe('COMPLETE');
  });

  test('marks malformed thread and check items incomplete instead of rendering them', () => {
    expect(renderSummary(makeBundle({ unresolvedComments: [{}] }), { now: NOW })).toMatchObject({
      evidenceStatus: 'INCOMPLETE',
      threadState: 'INCOMPLETE',
    });

    for (const surface of ['checks', 'failing', 'pending']) {
      const ci = { checks: [], failing: [], pending: [] };
      ci[surface] = [{}];
      expect(renderSummary(makeBundle({ ci }), { now: NOW })).toMatchObject({
        evidenceStatus: 'INCOMPLETE',
        threadState: 'ZERO',
      });
    }
  });

  test('keeps untrusted thread locators and check names inside safe code fences', () => {
    const { body } = renderSummary(makeBundle({
      unresolvedComments: [
        {
          author: 'qodo-code-review',
          path: 'src/``danger\nfile.js',
          line: 7,
          threadId: 'thread-1',
          comments: [],
        },
      ],
      ci: {
        checks: [],
        failing: [{ name: 'CI `` failure\r\nname' }],
        pending: [],
      },
    }), { now: NOW });

    expect(body).toContain('```src/``danger file.js:7```');
    expect(body).toContain('```CI `` failure name```');
    expect(body).not.toContain('`src/``danger\nfile.js:7`');
    expect(body).not.toContain('`CI `` failure\r\nname`');
  });

  test('keeps unreadable reasons, signal names, and CLI hints safe in code spans', () => {
    const unreadableThreads = renderSummary(makeBundle({
      unresolvedCommentsAvailable: false,
      unresolvedCommentsError: 'GraphQL `502`\r\nretry',
    }), { now: NOW }).body;
    expect(unreadableThreads).toContain('``GraphQL `502` retry``');

    const { body } = renderSummary(makeBundle({ pr: '123`\n456' }), {
      now: NOW,
      verdict: 'UNKNOWN',
      unreadable: ['required`Checks\nstatus'],
    });
    expect(body).toContain('``required`Checks status``');
    expect(body).toContain('``forge shepherd 123` 456 --pull --json``');
    expect(body).not.toContain('`required`Checks\nstatus`');
    expect(body).not.toContain('`forge shepherd 123`\n456 --pull --json`');
  });

  test('separates code fences from endpoint backticks, including all-backtick values', () => {
    const { body } = renderSummary(makeBundle({
      ci: {
        checks: [],
        failing: [
          { name: '`leading' },
          { name: 'trailing`' },
          { name: '`both`' },
          { name: '```' },
        ],
        pending: [],
      },
    }), { now: NOW });

    expect(body).toContain('- ❌ **Failing (4):** `` `leading ``, `` trailing` ``, `` `both` ``, ```` ``` ````');
  });
});
