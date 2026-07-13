'use strict';

const { describe, test, expect } = require('bun:test');

const {
  buildMemoryDigest,
  collectDigestData,
  extractIssues,
  DIGEST_HEADER,
} = require('../lib/memory-digest');
const { estimateTokens } = require('../lib/orientation');

const NOTES = [
  { note: 'Kernel is the single source of truth', timestamp: '2026-07-10T09:00:00.000Z' },
  { note: 'Push memory to agents via SessionStart', timestamp: '2026-07-11T09:00:00.000Z' },
];
const READY = [{ id: 'r1', title: 'Wire auto-file rail' }];
const CLAIMED = [{ id: 'c1', title: 'Memory push hook' }];

describe('buildMemoryDigest (pure, bounded)', () => {
  test('formats remembered notes + ready/claimed issues under a header', () => {
    const { text, empty } = buildMemoryDigest({ notes: NOTES, ready: READY, claimed: CLAIMED });
    expect(empty).toBe(false);
    expect(text).toContain(DIGEST_HEADER);
    expect(text).toContain('Push memory to agents via SessionStart');
    expect(text).toContain('2026-07-11'); // date prefix
    expect(text).toContain('[ready] Wire auto-file rail');
    expect(text).toContain('[claimed] Memory push hook');
  });

  test('empty inputs → empty digest (caller injects nothing)', () => {
    const result = buildMemoryDigest({ notes: [], ready: [], claimed: [] });
    expect(result.empty).toBe(true);
    expect(result.text).toBe('');
  });

  test('missing / malformed data never throws → empty digest', () => {
    expect(buildMemoryDigest().empty).toBe(true);
    expect(buildMemoryDigest({ notes: 'nope', ready: null }).empty).toBe(true);
  });

  test('never exceeds the token budget', () => {
    const many = Array.from({ length: 200 }, (_v, i) => ({ note: `note number ${i} with some words`, timestamp: '2026-07-11T00:00:00.000Z' }));
    const budgetTokens = 60;
    const { text, tokens } = buildMemoryDigest({ notes: many, ready: [], claimed: [] }, { budgetTokens });
    // Header is outside the budgeted sections; assert the budgeted BODY honours the cap.
    const body = text.slice(DIGEST_HEADER.length);
    expect(estimateTokens(body)).toBeLessThanOrEqual(budgetTokens + estimateTokens('\n\nRemembered notes:\n'));
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('extractIssues (defensive shape handling)', () => {
  test('reads a bare array, an { issues } object, or JSON output string', () => {
    expect(extractIssues({ data: [{ id: 'a' }] })).toHaveLength(1);
    expect(extractIssues({ data: { issues: [{ id: 'a' }, { id: 'b' }] } })).toHaveLength(2);
    expect(extractIssues({ output: JSON.stringify([{ id: 'x' }]) })).toHaveLength(1);
    expect(extractIssues({ output: 'not json' })).toEqual([]);
    expect(extractIssues({})).toEqual([]);
  });
});

describe('collectDigestData (best-effort, injectable)', () => {
  test('gathers notes + ready + claimed via injected fetchers', async () => {
    const data = await collectDigestData('/root', {
      fetchNotes: () => NOTES,
      fetchIssues: (_root, kind) => (kind === 'ready' ? READY : CLAIMED),
    });
    expect(data.notes).toEqual(NOTES);
    expect(data.ready).toEqual(READY);
    expect(data.claimed).toEqual(CLAIMED);
  });

  test('each source degrades to [] independently on failure', async () => {
    const data = await collectDigestData('/root', {
      fetchNotes: () => { throw new Error('kernel down'); },
      fetchIssues: (_root, kind) => { if (kind === 'ready') throw new Error('issue store down'); return CLAIMED; },
    });
    expect(data.notes).toEqual([]);
    expect(data.ready).toEqual([]);
    expect(data.claimed).toEqual(CLAIMED);
  });
});
