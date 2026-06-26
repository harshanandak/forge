const { describe, test, expect } = require('bun:test');

const projectMemory = require('../lib/project-memory');

// A driver-like store stub: project-memory speaks the memory entry shape to the store
// (entry-in / entry-out), so the stub keeps everything in a Map and mirrors the real
// kernel driver's token-AND search semantics.
function fakeStore(seed = {}) {
  const records = [];
  const memories = new Map(Object.entries(seed));
  return {
    records,
    memories,
    recordMemory(entry) {
      records.push(entry);
      memories.set(entry.key, entry);
      return entry;
    },
    loadMemory(key) {
      return memories.has(key) ? memories.get(key) : null;
    },
    searchMemories(query) {
      const tokens = query.split(/\s+/).filter(Boolean);
      return [...memories.values()].filter(entry => {
        const hay = `${entry.key} ${JSON.stringify(entry.value)}`.toLowerCase();
        return tokens.every(token => hay.includes(token.toLowerCase()));
      });
    },
    listMemories() {
      return [...memories.values()];
    },
  };
}

describe('project memory kernel adapter', () => {
  test('writes a canonical entry to the store and returns it', () => {
    const store = fakeStore();

    const entry = projectMemory.write(process.cwd(), {
      key: ' policy.memory ',
      value: 'Use the kernel for durable memory.',
      sourceAgent: 'Codex',
      tags: ['memory'],
      timestamp: '2026-05-16T10:00:00.000Z',
      scope: 'project',
    }, { store });

    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toEqual({
      key: 'policy.memory',
      value: 'Use the kernel for durable memory.',
      sourceAgent: 'Codex',
      tags: ['memory'],
      timestamp: '2026-05-16T10:00:00.000Z',
      scope: 'project',
    });
    expect(entry.key).toBe('policy.memory');
    expect(entry.value).toBe('Use the kernel for durable memory.');
  });

  test('reads an entry by trimmed key and returns null when missing', () => {
    const store = fakeStore({
      'policy.memory': {
        key: 'policy.memory',
        value: 'stored',
        sourceAgent: 'Codex',
        tags: ['memory'],
        timestamp: '2026-05-16T10:00:00.000Z',
      },
    });

    expect(projectMemory.read(process.cwd(), ' policy.memory ', { store })).toMatchObject({
      key: 'policy.memory',
      value: 'stored',
      sourceAgent: 'Codex',
      tags: ['memory'],
    });
    expect(projectMemory.read(process.cwd(), 'missing.key', { store })).toBe(null);
  });

  test('searches and lists entries through the store', () => {
    const store = fakeStore({
      'decision.one': { key: 'decision.one', value: 'one', sourceAgent: 'Codex', tags: ['decision'] },
      'decision.two': { key: 'decision.two', value: 'two', sourceAgent: 'Claude', tags: ['decision'] },
    });

    expect(projectMemory.search(process.cwd(), 'decision', { store }).map(entry => entry.key)).toEqual([
      'decision.one',
      'decision.two',
    ]);
    // An empty / whitespace query short-circuits to [] without touching the store.
    expect(projectMemory.search(process.cwd(), '   ', { store })).toEqual([]);
    expect(projectMemory.list(process.cwd(), { store })).toHaveLength(2);
  });

  test('adds a timestamp and a tags array to writes when omitted', () => {
    const store = fakeStore();

    projectMemory.write(process.cwd(), {
      key: 'decision.timestamped',
      value: 'timestamp should be generated',
      sourceAgent: 'Codex',
    }, { store });

    const entry = store.records[0];
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
    expect(entry.tags).toEqual([]);
  });

  test('carries optional fields (object value, confidence, supersedes, beadsRefs) through', () => {
    const store = fakeStore();

    const entry = projectMemory.write(process.cwd(), {
      key: 'decision.full',
      value: { category: 'decisions', data: { choice: 'kernel' } },
      sourceAgent: 'forge insights',
      tags: ['decisions'],
      confidence: 0.5,
      supersedes: ['decision.old'],
      beadsRefs: ['forge-1gry'],
    }, { store });

    expect(entry).toMatchObject({
      key: 'decision.full',
      confidence: 0.5,
      supersedes: ['decision.old'],
      beadsRefs: ['forge-1gry'],
    });
    expect(store.records[0].value).toEqual({ category: 'decisions', data: { choice: 'kernel' } });
  });

  test('validates the beads-refs alias before writing', () => {
    const store = fakeStore();

    expect(() => projectMemory.write(process.cwd(), {
      key: 'decision.bad-ref',
      value: 'invalid alias refs must fail',
      sourceAgent: 'Codex',
      'beads-refs': ['forge-1gry', 42],
    }, { store })).toThrow('beads-refs');
    expect(store.records).toHaveLength(0);
  });

  test('validates compatibility metadata before writing', () => {
    const store = fakeStore();

    expect(() => projectMemory.write(process.cwd(), {
      key: 'decision.bad-confidence',
      value: 'bad confidence must fail',
      sourceAgent: 'Codex',
      confidence: Number.POSITIVE_INFINITY,
    }, { store })).toThrow('confidence');

    expect(() => projectMemory.write(process.cwd(), {
      key: 'decision.bad-scope',
      value: 'bad scope must fail',
      sourceAgent: 'Codex',
      scope: '',
    }, { store })).toThrow('scope');

    expect(() => projectMemory.write(process.cwd(), {
      key: 'decision.bad-timestamp',
      value: 'bad timestamp must fail',
      sourceAgent: 'Codex',
      timestamp: 'not-a-date',
    }, { store })).toThrow('timestamp');

    expect(store.records).toHaveLength(0);
  });
});
