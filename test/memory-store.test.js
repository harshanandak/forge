'use strict';

const { afterEach, describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memoryStore = require('../lib/memory-store');

const tempDirs = [];

function makeProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('memory-store', () => {
  test('defaultStorePath points at a file-based location under .forge/memory', () => {
    const projectRoot = makeProjectRoot();
    const storePath = memoryStore.defaultStorePath(projectRoot);
    expect(storePath).toBe(path.join(projectRoot, '.forge', 'memory', 'notes.jsonl'));
  });

  test('append writes a note and returns the stored entry', () => {
    const projectRoot = makeProjectRoot();
    const entry = memoryStore.append(projectRoot, 'Run /plan before /dev');

    expect(entry.note).toBe('Run /plan before /dev');
    expect(typeof entry.id).toBe('string');
    expect(entry.id.length).toBeGreaterThan(0);
    expect(typeof entry.timestamp).toBe('string');
    expect(Array.isArray(entry.tags)).toBe(true);

    const storePath = memoryStore.defaultStorePath(projectRoot);
    expect(fs.existsSync(storePath)).toBe(true);
    const lines = fs.readFileSync(storePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).note).toBe('Run /plan before /dev');
  });

  test('append creates the memory directory when it does not exist', () => {
    const projectRoot = makeProjectRoot();
    expect(fs.existsSync(path.join(projectRoot, '.forge', 'memory'))).toBe(false);
    memoryStore.append(projectRoot, 'first note');
    expect(fs.existsSync(path.join(projectRoot, '.forge', 'memory'))).toBe(true);
  });

  test('append preserves tags and trims the note', () => {
    const projectRoot = makeProjectRoot();
    const entry = memoryStore.append(projectRoot, '  tagged note  ', { tags: ['policy', 'workflow'] });
    expect(entry.note).toBe('tagged note');
    expect(entry.tags).toEqual(['policy', 'workflow']);
  });

  test('append rejects empty notes', () => {
    const projectRoot = makeProjectRoot();
    expect(() => memoryStore.append(projectRoot, '   ')).toThrow();
    expect(() => memoryStore.append(projectRoot, '')).toThrow();
  });

  test('list returns entries newest first', () => {
    const projectRoot = makeProjectRoot();
    memoryStore.append(projectRoot, 'first');
    memoryStore.append(projectRoot, 'second');
    memoryStore.append(projectRoot, 'third');

    const entries = memoryStore.list(projectRoot);
    expect(entries.map(entry => entry.note)).toEqual(['third', 'second', 'first']);
  });

  test('list returns an empty array when nothing is stored', () => {
    const projectRoot = makeProjectRoot();
    expect(memoryStore.list(projectRoot)).toEqual([]);
  });

  test('list tolerates malformed lines without throwing', () => {
    const projectRoot = makeProjectRoot();
    const storePath = memoryStore.defaultStorePath(projectRoot);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      `${JSON.stringify({ id: 'a', note: 'valid', timestamp: '2026-01-01T00:00:00.000Z', tags: [] })}\nnot-json\n`,
      'utf8',
    );
    const entries = memoryStore.list(projectRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].note).toBe('valid');
  });

  test('search matches note text case-insensitively', () => {
    const projectRoot = makeProjectRoot();
    memoryStore.append(projectRoot, 'Use Bun for tests');
    memoryStore.append(projectRoot, 'Lint with eslint');

    const results = memoryStore.search(projectRoot, 'BUN');
    expect(results).toHaveLength(1);
    expect(results[0].note).toBe('Use Bun for tests');
  });

  test('search matches tags', () => {
    const projectRoot = makeProjectRoot();
    memoryStore.append(projectRoot, 'note with tag', { tags: ['security'] });
    memoryStore.append(projectRoot, 'note without', { tags: [] });

    const results = memoryStore.search(projectRoot, 'security');
    expect(results).toHaveLength(1);
    expect(results[0].note).toBe('note with tag');
  });

  test('search with empty query returns all entries', () => {
    const projectRoot = makeProjectRoot();
    memoryStore.append(projectRoot, 'alpha');
    memoryStore.append(projectRoot, 'beta');
    expect(memoryStore.search(projectRoot, '')).toHaveLength(2);
  });

  test('options.filePath overrides the storage location', () => {
    const projectRoot = makeProjectRoot();
    const custom = path.join(projectRoot, 'custom', 'memory.jsonl');
    memoryStore.append(projectRoot, 'custom location note', { filePath: custom });

    expect(fs.existsSync(custom)).toBe(true);
    expect(memoryStore.list(projectRoot, { filePath: custom })).toHaveLength(1);
    expect(fs.existsSync(memoryStore.defaultStorePath(projectRoot))).toBe(false);
  });

  test('entries carry unique ids', () => {
    const projectRoot = makeProjectRoot();
    const first = memoryStore.append(projectRoot, 'one');
    const second = memoryStore.append(projectRoot, 'two');
    expect(first.id).not.toBe(second.id);
  });
});
