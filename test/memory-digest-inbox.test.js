'use strict';

const { describe, test, expect } = require('bun:test');

const { buildMemoryDigest, collectDigestData } = require('../lib/memory-digest');

const INBOX = [
  { comment_id: 'c1', issue_id: 'i1', basis: 'worktree', text: 'rename the verb to forge inbox' },
];
const NOTES = [{ note: 'Kernel is authoritative', timestamp: '2026-07-10T09:00:00.000Z' }];

describe('SessionStart digest — inbox is a third fenced section', () => {
  test('pending inbox comments appear, fenced as dashboard-comment DATA', () => {
    const { text, empty } = buildMemoryDigest({ notes: NOTES, ready: [], claimed: [], inbox: INBOX });
    expect(empty).toBe(false);
    expect(text).toContain('UNTRUSTED dashboard-comment'); // inbox fence banner
    expect(text).toContain('rename the verb to forge inbox');
    expect(text).toContain('END UNTRUSTED');
    // still carries the existing memory sections
    expect(text).toContain('Kernel is authoritative');
  });

  test('inbox (priority 5) is ordered before notes and issues', () => {
    const { text } = buildMemoryDigest({
      notes: NOTES,
      ready: [{ id: 'r1', title: 'ready one' }],
      claimed: [],
      inbox: INBOX,
    });
    expect(text.indexOf('rename the verb')).toBeLessThan(text.indexOf('Kernel is authoritative'));
    expect(text.indexOf('rename the verb')).toBeLessThan(text.indexOf('[ready] ready one'));
  });

  test('no inbox → digest unchanged (empty when nothing at all)', () => {
    expect(buildMemoryDigest({ notes: [], ready: [], claimed: [], inbox: [] }).empty).toBe(true);
  });

  test('budget-capped: the inbox fence close marker survives truncation', () => {
    const many = Array.from({ length: 300 }, (_v, i) => ({ comment_id: `c${i}`, issue_id: 'i1', basis: 'board', text: `directive ${i}` }));
    const { text } = buildMemoryDigest({ notes: [], ready: [], claimed: [], inbox: many }, { budgetTokens: 60 });
    expect(text).toContain('truncated');
    expect(text).toContain('END UNTRUSTED');
  });
});

describe('collectDigestData — inbox as a third source (injectable)', () => {
  test('gathers inbox via injected fetchInbox alongside notes + issues', async () => {
    const data = await collectDigestData('/root', {
      fetchNotes: () => NOTES,
      fetchIssues: () => [],
      fetchInbox: () => INBOX,
    });
    expect(data.inbox).toEqual(INBOX);
    expect(data.notes).toEqual(NOTES);
  });

  test('inbox source degrades to [] independently on failure', async () => {
    const data = await collectDigestData('/root', {
      fetchNotes: () => NOTES,
      fetchIssues: () => [],
      fetchInbox: () => { throw new Error('kernel down'); },
    });
    expect(data.inbox).toEqual([]);
    expect(data.notes).toEqual(NOTES);
  });
});
