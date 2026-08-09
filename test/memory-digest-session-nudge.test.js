'use strict';

const { describe, expect, test } = require('bun:test');
const { buildMemoryDigest } = require('../lib/memory-digest');

describe('session-learning nudge', () => {
  test('a missing explicit summary emits one compact non-blocking reminder in SessionStart context', () => {
    const result = buildMemoryDigest({ notes: [], claimed: [{ id: 'i1', title: 'Hook lane' }] });
    expect(result.text.match(/forge remember --session-summary/g)).toHaveLength(1);
    expect(result.text).toMatch(/before ending this session/i);
    expect(result.text).not.toContain('PreCompact');
    expect(result.text).not.toContain('block');
  });

  test('an existing explicit session summary suppresses the reminder', () => {
    const result = buildMemoryDigest({
      notes: [{ note: 'Learned the hook contract.', tags: ['type:session-summary'] }],
      claimed: [{ id: 'i1', title: 'Hook lane' }],
    });
    expect(result.text).not.toContain('forge remember --session-summary');
  });
});
