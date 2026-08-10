'use strict';

const { describe, expect, test } = require('bun:test');
const { reviewMemories, stalenessForMemory } = require('../../lib/memory/hygiene');

describe('memory hygiene review', () => {
  test('uses durable last use when present and created_at only for never-used age', () => {
    const now = '2026-08-10T00:00:00.000Z';
    expect(stalenessForMemory({ memory_id: 'one', created_at: '2026-01-01T00:00:00.000Z' }, null, { now }))
      .toMatchObject({ baseline_at: '2026-01-01T00:00:00.000Z', stale: true, demote: true, use_count: 0 });
    expect(stalenessForMemory(
      { memory_id: 'one', created_at: '2026-01-01T00:00:00.000Z' },
      { last_used_at: '2026-05-12T00:00:00.000Z', use_count: 2 },
      { now },
    )).toMatchObject({ baseline_at: '2026-05-12T00:00:00.000Z', stale: false, demote: false, use_count: 2 });
  });

  test('demotes only after the exact 90-day staleness boundary', () => {
    const memory = { memory_id: 'one', created_at: '2026-05-12T00:00:00.000Z' };
    expect(stalenessForMemory(memory, null, { now: '2026-08-10T00:00:00.000Z' }))
      .toMatchObject({ age_days: 90, stale: false, demote: false });
    expect(stalenessForMemory(memory, null, { now: '2026-08-10T00:00:00.001Z' }))
      .toMatchObject({ age_days: 90, stale: true, demote: true });
  });

  test('rejects non-canonical timestamps and malformed durable usage counts', () => {
    const memory = { memory_id: 'one', created_at: '2026-01-01T00:00:00.000Z' };
    const now = '2026-08-10T00:00:00.000Z';

    expect(() => stalenessForMemory({ ...memory, created_at: '1' }, null, { now }))
      .toThrow(/canonical ISO/i);
    expect(() => stalenessForMemory(memory, { last_used_at: '2026-05-12', use_count: 2 }, { now }))
      .toThrow(/canonical ISO/i);
    expect(() => stalenessForMemory(memory, { last_used_at: '2026-05-12T00:00:00.000Z', use_count: 'oops' }, { now }))
      .toThrow(/use_count/i);
    expect(() => stalenessForMemory(memory, { last_used_at: '2026-05-12T00:00:00.000Z', use_count: -1 }, { now }))
      .toThrow(/use_count/i);
  });

  test('rejects inherited or accessor staleness fields without invoking getters', () => {
    let getterCalls = 0;
    const memory = { memory_id: 'one' };
    Object.defineProperty(memory, 'created_at', {
      get() {
        getterCalls += 1;
        return '2026-01-01T00:00:00.000Z';
      },
    });
    expect(() => stalenessForMemory(memory, null, { now: '2026-08-10T00:00:00.000Z' }))
      .toThrow(/own data property/i);
    expect(getterCalls).toBe(0);
    expect(() => stalenessForMemory(
      Object.create({ created_at: '2026-01-01T00:00:00.000Z' }),
      null,
      { now: '2026-08-10T00:00:00.000Z' },
    )).toThrow(/own data property/i);
  });

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
