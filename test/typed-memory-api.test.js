const { describe, test, expect } = require('bun:test');

const typedMemory = require('../lib/memory/typed-api');

function captureMemory() {
  const writes = [];
  return {
    writes,
    memory: {
      write(_projectRoot, entry) {
        writes.push(entry);
        return entry;
      },
      read(_projectRoot, key) {
        return { key, value: { category: 'preferences' }, tags: ['preferences'] };
      },
      search() {
        return [
          { key: 'preferences:editor', value: { category: 'preferences' }, tags: ['preferences'] },
          { key: 'decisions:editor', value: { category: 'decisions' }, tags: ['decisions'] },
        ];
      },
    },
  };
}

describe('typed memory API', () => {
  test('writes typed memories with category key prefixes and provenance', () => {
    const captured = captureMemory();

    const result = typedMemory.writePreference(process.cwd(), 'editor', 'Use vim keys', {
      provenance: {
        actor: 'Codex',
        reason: 'User preference',
        source: 'chat',
      },
      memory: captured.memory,
      tags: 'ui',
      beadsRefs: 'forge-besw.22',
    });

    expect(result.key).toBe('preferences:editor');
    expect(captured.writes[0]).toMatchObject({
      key: 'preferences:editor',
      sourceAgent: 'Codex',
      tags: ['preferences', 'ui'],
      beadsRefs: ['forge-besw.22'],
      value: {
        category: 'preferences',
        data: 'Use vim keys',
        provenance: {
          actor: 'Codex',
          reason: 'User preference',
          source: 'chat',
        },
      },
    });
  });

  test('rejects unknown categories and missing provenance', () => {
    expect(() => typedMemory.writeTyped(process.cwd(), 'unknown', 'x', 'value', {
      provenance: { actor: 'Codex', reason: 'test', source: 'test' },
    })).toThrow('Unknown memory category');

    expect(() => typedMemory.writeDecision(process.cwd(), 'routing', 'Use Beads')).toThrow('provenance');
    expect(() => typedMemory.writeDecision(process.cwd(), 'routing', 'Use Beads', {
      provenance: { actor: 'Codex', reason: 'test', source: 'test' },
      tags: [42],
    })).toThrow('tags');
  });

  test('reads and searches through the delegated memory adapter', () => {
    const captured = captureMemory();

    expect(typedMemory.readTyped(process.cwd(), 'preferences', 'editor', {
      memory: captured.memory,
    }).key).toBe('preferences:editor');
    expect(typedMemory.searchTyped(process.cwd(), 'preferences', 'editor', {
      memory: captured.memory,
    }).map(entry => entry.key)).toEqual(['preferences:editor']);
  });
});
