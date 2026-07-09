'use strict';

const { afterEach, describe, test, expect } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const recall = require('../../lib/commands/recall');
const remember = require('../../lib/commands/remember');
const projectMemory = require('../../lib/project-memory');

const tempDirs = [];

// recall reads the kernel store, whose default path resolves from the git common dir — so
// each temp project is a throwaway git repo. Notes are seeded through the real remember path.
function makeProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-recall-cmd-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  tempDirs.push(dir);
  return dir;
}

function rmrfWithRetry(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4 || (error.code !== 'EBUSY' && error.code !== 'EPERM')) return;
      const until = Date.now() + 100;
      while (Date.now() < until) { /* brief spin before retry */ }
    }
  }
}

async function seed(projectRoot, note) {
  await remember.handler([note], {}, projectRoot);
}

afterEach(() => {
  projectMemory.closeAll();
  while (tempDirs.length > 0) {
    rmrfWithRetry(tempDirs.pop());
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
    await seed(projectRoot, 'first note');
    await seed(projectRoot, 'second note');

    const result = await recall.handler([], {}, projectRoot);
    expect(result.success).toBe(true);
    expect(result.output).toContain('first note');
    expect(result.output).toContain('second note');
  });

  test('filters notes by query (FTS token-AND)', async () => {
    const projectRoot = makeProjectRoot();
    await seed(projectRoot, 'Use Bun for tests');
    await seed(projectRoot, 'Lint with eslint');

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
    await seed(projectRoot, 'something');
    const result = await recall.handler(['nonexistent'], {}, projectRoot);
    expect(result.success).toBe(true);
    expect(result.output.toLowerCase()).toContain('no');
  });

  test('emits JSON output with --json', async () => {
    const projectRoot = makeProjectRoot();
    await seed(projectRoot, 'alpha note');

    const result = await recall.handler(['--json'], {}, projectRoot);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].note).toBe('alpha note');
  });

  test('honors --limit', async () => {
    const projectRoot = makeProjectRoot();
    await seed(projectRoot, 'one');
    await seed(projectRoot, 'two');
    await seed(projectRoot, 'three');

    const result = await recall.handler(['--json', '--limit', '2'], {}, projectRoot);
    const parsed = JSON.parse(result.output);
    expect(parsed).toHaveLength(2);
  });

  test('does not treat the -p global flag as part of the query (kernel c1e090ff)', async () => {
    const projectRoot = makeProjectRoot();
    await seed(projectRoot, 'ship the fix');

    const result = await recall.handler(
      ['ship the fix', '-p', 'C:\\some\\project'],
      { path: 'C:\\some\\project' },
      projectRoot
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('ship the fix');
    expect(result.output).not.toContain('No notes match');
  });
});
