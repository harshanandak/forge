'use strict';

const { describe, test, expect } = require('bun:test');

const {
  BUDGET_TYPES,
  renderDigestLines,
  collectDigest,
  readConsumerCursor,
  writeConsumerCursor,
} = require('../../lib/pr-monitor/digest');
const hooks = require('../../lib/commands/hooks');

// Gap 2 (epic c2d398e5, 33e1bbd3): the thin CONSUMER that surfaces NEW PR-monitor
// journal events into each turn. Pure digest core + a fail-open UserPromptSubmit
// hook. The CORE (events/journal/watch) is untouched.

const ev = (type, over = {}) => ({ type, pr: '12', seq: 1, data: {}, ...over });

describe('renderDigestLines — budget filter + cap (pure)', () => {
  test('keeps only budget event types', () => {
    const events = [
      ev('verdict.changed', { verdict: { verdict: 'BEHIND' } }),
      ev('head.pushed'),
      ev('checks.green'),
      ev('check.failed', { data: { name: 'eslint' } }),
      ev('thread.opened', { data: { author: 'coderabbitai' } }),
      ev('pr.merged'),
      ev('monitor.degraded'),
    ];
    const { lines, total } = renderDigestLines(events, { cap: 10 });
    expect(total).toBe(4); // verdict.changed, check.failed, thread.opened, pr.merged
    expect(lines.join('\n')).toContain('verdict.changed');
    expect(lines.join('\n')).toContain('BEHIND');
    expect(lines.join('\n')).toContain('eslint');
    expect(lines.join('\n')).not.toContain('head.pushed');
    expect(lines.join('\n')).not.toContain('checks.green');
  });

  test('caps the number of rendered lines', () => {
    const events = Array.from({ length: 20 }, (_, i) => ev('check.failed', { data: { name: `c${i}` } }));
    const { lines, total } = renderDigestLines(events, { cap: 5 });
    expect(lines).toHaveLength(5);
    expect(total).toBe(20);
  });

  test('BUDGET_TYPES is exactly the five actionable transitions', () => {
    expect([...BUDGET_TYPES].sort()).toEqual(
      ['check.failed', 'pr.closed', 'pr.merged', 'thread.opened', 'verdict.changed'],
    );
  });
});

describe('collectDigest — reads since cursor, advances cursor, fail-open', () => {
  // A fake journal + in-memory fs so no real .forge/pr-monitor is touched.
  function harness(events) {
    const cursors = {}; // dir -> seq
    const fsDeps = {
      readdirSync: () => [{ name: 'repo-12', isDirectory: () => true }],
      existsSync: () => true,
      readFileSync: (p) => {
        const dir = p.replace(/[/\\]consumer\.cursor$/, '');
        if (!(dir in cursors)) throw new Error('no cursor');
        return JSON.stringify({ seq: cursors[dir] });
      },
      writeFileSync: (p, body) => {
        const dir = p.replace(/[/\\]consumer\.cursor$/, '');
        cursors[dir] = JSON.parse(body).seq;
      },
    };
    const journal = { readEventsSince: (_dir, since) => events.filter((e) => e.seq > since) };
    return { fsDeps, journal, cursors };
  }

  test('surfaces new budget events and advances the cursor past everything read', () => {
    const events = [
      { type: 'head.pushed', pr: '12', seq: 1, data: {} },
      { type: 'check.failed', pr: '12', seq: 2, data: { name: 'eslint' } },
      { type: 'verdict.changed', pr: '12', seq: 3, verdict: { verdict: 'BLOCKED-CHECKS' }, data: {} },
    ];
    const { fsDeps, journal, cursors } = harness(events);
    const first = collectDigest({ root: '/r', journal, fsDeps });
    expect(first.total).toBe(2); // check.failed + verdict.changed (head.pushed skipped)
    expect(first.text).toContain('eslint');
    expect(first.text).toContain('BLOCKED-CHECKS');
    expect(first.prs).toEqual(['12']);
    // cursor advanced to the max seq READ (3), including the skipped head.pushed
    expect(Object.values(cursors)[0]).toBe(3);

    // Second call with no new events → empty, idempotent.
    const second = collectDigest({ root: '/r', journal, fsDeps });
    expect(second.total).toBe(0);
    expect(second.text).toBe('');
  });

  test('is fail-open when a journal read throws', () => {
    const fsDeps = {
      readdirSync: () => [{ name: 'repo-9', isDirectory: () => true }],
      existsSync: () => true,
      readFileSync: () => { throw new Error('no cursor'); },
      writeFileSync: () => {},
    };
    const journal = { readEventsSince: () => { throw new Error('corrupt journal'); } };
    const out = collectDigest({ root: '/r', journal, fsDeps });
    expect(out.total).toBe(0);
    expect(out.text).toBe('');
  });

  test('is fail-open when there is no .forge/pr-monitor at all', () => {
    const fsDeps = { readdirSync: () => { throw new Error('ENOENT'); } };
    const out = collectDigest({ root: '/nowhere', fsDeps });
    expect(out).toEqual({ text: '', total: 0, prs: [] });
  });

  test('cursor read defaults to 0 and write round-trips (injected fs)', () => {
    const store = {};
    const fsDeps = {
      readFileSync: (p) => { if (!(p in store)) throw new Error('missing'); return store[p]; },
      writeFileSync: (p, body) => { store[p] = body; },
    };
    expect(readConsumerCursor('/d', fsDeps)).toBe(0);
    writeConsumerCursor('/d', 7, fsDeps);
    expect(readConsumerCursor('/d', fsDeps)).toBe(7);
  });
});

describe('forge hooks shepherd-events — the UserPromptSubmit consumer hook', () => {
  test('claude: wraps a non-empty digest as UserPromptSubmit additionalContext', async () => {
    const res = await hooks.handler(['shepherd-events', '--harness', 'claude'], {}, '/r', {
      collectDigest: () => ({ text: '[forge PR shepherd] 1 new event(s) on PR(s) 12:\n- PR #12 pr.merged: merged', total: 1, prs: ['12'] }),
    });
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('pr.merged');
  });

  test('claude: empty digest → emits nothing (no injection)', async () => {
    const res = await hooks.handler(['shepherd-events', '--harness', 'claude'], {}, '/r', {
      collectDigest: () => ({ text: '', total: 0, prs: [] }),
    });
    expect(res).toEqual({ success: true, output: '' });
  });

  test('non-claude harness → emits nothing (honest capability matrix)', async () => {
    const res = await hooks.handler(['shepherd-events', '--harness', 'cursor'], {}, '/r', {
      collectDigest: () => ({ text: 'should not be used', total: 1, prs: ['12'] }),
    });
    expect(res.output).toBe('');
  });

  test('fail-open: a throwing collector never breaks the prompt', async () => {
    const res = await hooks.handler(['shepherd-events', '--harness', 'claude'], {}, '/r', {
      collectDigest: () => { throw new Error('boom'); },
    });
    expect(res).toEqual({ success: true, output: '' });
  });
});
