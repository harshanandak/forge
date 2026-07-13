'use strict';

const { describe, test, expect } = require('bun:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildMemorySection,
  buildOrientationSections,
} = require('../lib/orientation');

// A hermetic in-memory store implementing the project-memory read seam
// ({ recentMemories, countMemories }) so the MEMORY section is tested WITHOUT a
// real kernel database. Entries use the kernel_memories entry shape that toNote maps.
function fakeStore(entries) {
  return {
    recentMemories: (limit) => entries.slice(0, limit),
    countMemories: () => entries.length,
  };
}

// A throwaway project root with no legacy JSONL store, so migrateJsonlNotesOnce is a
// no-op and only the injected store is consulted.
function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-orient-mem-'));
}

const NOTES = [
  { key: 'a', value: 'Kernel is the single source of truth', sourceAgent: 'forge remember', timestamp: '2026-07-10T09:00:00.000Z', tags: [] },
  { key: 'b', value: 'Push memory to agents via SessionStart', sourceAgent: 'forge remember', timestamp: '2026-07-11T09:00:00.000Z', tags: [] },
];

describe('buildMemorySection (orientation MEMORY / remembered notes)', () => {
  test('surfaces the newest remembered notes as a bounded section', () => {
    const root = tempRoot();
    const sections = buildMemorySection(root, { store: fakeStore(NOTES) });
    expect(sections.length).toBe(1);
    const section = sections[0];
    expect(section.id).toBe('remembered_notes');
    expect(section.content).toContain('Kernel is the single source of truth');
    expect(section.content).toContain('2026-07-11'); // date prefix rendered
    expect(section.preserve).toBe(false);
  });

  test('is absent when there are no remembered notes', () => {
    const root = tempRoot();
    expect(buildMemorySection(root, { store: fakeStore([]) })).toEqual([]);
  });

  test('never throws — a broken store yields no section (fail-open)', () => {
    const root = tempRoot();
    const brokenStore = { recentMemories: () => { throw new Error('kernel locked'); }, countMemories: () => 0 };
    expect(buildMemorySection(root, { store: brokenStore })).toEqual([]);
  });

  test('buildOrientationSections includes the MEMORY section when notes exist', () => {
    const root = tempRoot();
    const { sections } = buildOrientationSections(root, { store: fakeStore(NOTES) });
    expect(sections.some(s => s.id === 'remembered_notes')).toBe(true);
  });
});
