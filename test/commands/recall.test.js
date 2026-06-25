'use strict';

const { afterEach, describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const recall = require('../../lib/commands/recall');
const memoryStore = require('../../lib/memory-store');

const tempDirs = [];

function makeProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-recall-cmd-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('forge recall command', () => {
  test('exports the registry command contract', () => {
    expect(recall.name).toBe('recall');
    expect(typeof recall.description).toBe('string');
    expect(recall.description.length).toBeGreaterThan(0);
    expect(typeof recall.handler).toBe('function');
    expect(recall.usage).toContain('recall');
    expect(recall.usage).toContain('[query]');
  });

  test('lists all stored notes when no query is given', async () => {
    const projectRoot = makeProjectRoot();
    memoryStore.append(projectRoot, 'first note');
    memoryStore.append(projectRoot, 'second note');

    const result = await recall.handler([], {}, projectRoot);
    expect(result.success).toBe(true);
    expect(result.output).toContain('first note');
    expect(result.output).toContain('second note');
  });

  test('filters notes by query', async () => {
    const projectRoot = makeProjectRoot();
    memoryStore.append(projectRoot, 'Use Bun for tests');
    memoryStore.append(projectRoot, 'Lint with eslint');

    const result = await recall.handler(['bun'], {}, projectRoot);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Use Bun for tests');
    expect(result.output).not.toContain('Lint with eslint');
  });

  test('reports an empty store gracefully', async () => {
    const projectRoot = makeProjectRoot();
    const result = await recall.handler([], {}, projectRoot);
    expect(result.success).toBe(true);
    expect(result.output.toLowerCase()).toContain('no');
  });

  test('reports when a query matches nothing', async () => {
    const projectRoot = makeProjectRoot();
    memoryStore.append(projectRoot, 'something');
    const result = await recall.handler(['nonexistent'], {}, projectRoot);
    expect(result.success).toBe(true);
    expect(result.output.toLowerCase()).toContain('no');
  });

  test('emits JSON output with --json', async () => {
    const projectRoot = makeProjectRoot();
    memoryStore.append(projectRoot, 'alpha note');

    const result = await recall.handler(['--json'], {}, projectRoot);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].note).toBe('alpha note');
  });

  test('honors --limit', async () => {
    const projectRoot = makeProjectRoot();
    memoryStore.append(projectRoot, 'one');
    memoryStore.append(projectRoot, 'two');
    memoryStore.append(projectRoot, 'three');

    const result = await recall.handler(['--json', '--limit', '2'], {}, projectRoot);
    const parsed = JSON.parse(result.output);
    expect(parsed).toHaveLength(2);
  });
});
