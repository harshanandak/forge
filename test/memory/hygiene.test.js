'use strict';

const { describe, expect, test } = require('bun:test');
const { reviewMemories } = require('../../lib/memory/hygiene');

describe('memory hygiene review', () => {
  test('duplicate ids are stable across input, object-key, and volatile-field ordering', () => {
    const first = reviewMemories([
      { id: 'new-id', updated_at: '2026-08-10', value: { why: 'fast', what: 'Use Bun' } },
      { id: 'old-id', updated_at: '2026-01-01', value: { what: 'Use Bun', why: 'fast' } },
    ]);
    const second = reviewMemories([
      { updated_at: 'tomorrow', id: 'changed-a', value: { what: 'Use Bun', why: 'fast' } },
      { value: { why: 'fast', what: 'Use Bun' }, id: 'changed-b', updated_at: 'yesterday' },
    ].reverse());

    expect(first.findings).toHaveLength(1);
    expect(first.findings[0].kind).toBe('duplicate');
    expect(first.findings[0].review_id).toBe(second.findings[0].review_id);
  });

  test('uses locale-independent code-unit ordering for deterministic Unicode review ids', () => {
    const first = ['z', 'ä'];
    const second = ['ä', 'z'];

    const review = reviewMemories([{ value: first }, { value: second }]);

    expect(review.findings).toHaveLength(1);
    expect(review.findings[0].review_id).toBe('memory-duplicate-e3cb5a300bbc3b85');
  });

  test('explicit positive and negative claims produce a stable contradiction id', () => {
    const first = reviewMemories([{ note: 'Use Bun for installs' }, { note: 'Do not use Bun for installs' }]);
    const second = reviewMemories([{ timestamp: 'volatile', note: 'do NOT use bun for installs.' }, { note: 'use bun for installs' }]);

    expect(first.findings).toHaveLength(1);
    expect(first.findings[0].kind).toBe('contradiction');
    expect(first.findings[0].review_id).toBe(second.findings[0].review_id);
  });

  test('review is bounded before pair analysis and caps findings', () => {
    const entries = Array.from({ length: 12 }, () => ({ note: 'same claim' }));
    const review = reviewMemories(entries, { entryLimit: 5, findingLimit: 1 });

    expect(review.scanned).toBe(5);
    expect(review.total).toBe(12);
    expect(review.truncated).toBe(true);
    expect(review.findings).toHaveLength(1);
  });
});
