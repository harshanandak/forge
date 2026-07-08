'use strict';

const { afterEach, describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const remember = require('../../lib/commands/remember');
const memoryStore = require('../../lib/memory-store');

const tempDirs = [];

function makeProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-remember-cmd-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('forge remember command', () => {
  test('exports the registry command contract', () => {
    expect(remember.name).toBe('remember');
    expect(typeof remember.description).toBe('string');
    expect(remember.description.length).toBeGreaterThan(0);
    expect(typeof remember.handler).toBe('function');
    expect(remember.usage).toContain('remember');
    expect(remember.usage).toContain('<note>');
  });

  test('persists a note and reports success', async () => {
    const projectRoot = makeProjectRoot();
    const result = await remember.handler(['Run /plan before /dev'], {}, projectRoot);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Run /plan before /dev');

    const entries = memoryStore.list(projectRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].note).toBe('Run /plan before /dev');
  });

  test('joins multiple argument words into a single note', async () => {
    const projectRoot = makeProjectRoot();
    await remember.handler(['Prefer', 'Bun', 'over', 'npm'], {}, projectRoot);

    const entries = memoryStore.list(projectRoot);
    expect(entries[0].note).toBe('Prefer Bun over npm');
  });

  test('captures --tag values as tags', async () => {
    const projectRoot = makeProjectRoot();
    await remember.handler(['note body', '--tag', 'policy', '--tag', 'workflow'], {}, projectRoot);

    const entries = memoryStore.list(projectRoot);
    expect(entries[0].note).toBe('note body');
    expect(entries[0].tags).toEqual(['policy', 'workflow']);
  });

  test('fails clearly when no note is provided', async () => {
    const projectRoot = makeProjectRoot();
    const result = await remember.handler([], {}, projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toContain('note');
    expect(memoryStore.list(projectRoot)).toEqual([]);
  });

  test('emits JSON output with --json', async () => {
    const projectRoot = makeProjectRoot();
    const result = await remember.handler(['json note', '--json'], {}, projectRoot);

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.note).toBe('json note');
  });

  test('does not store the -p global flag and its value in the note (kernel c1e090ff)', async () => {
    const projectRoot = makeProjectRoot();
    const result = await remember.handler(
      ['ship the fix', '-p', 'C:\\some\\project'],
      { path: 'C:\\some\\project' },
      projectRoot
    );

    expect(result.success).toBe(true);
    const [entry] = memoryStore.list(projectRoot);
    expect(entry.note).toBe('ship the fix');
  });

  test('strips --path= and other global flags from the note content', async () => {
    const projectRoot = makeProjectRoot();
    const result = await remember.handler(
      ['multi', 'word', 'note', '--path=/tmp/project', '--verbose'],
      {},
      projectRoot
    );

    expect(result.success).toBe(true);
    const [entry] = memoryStore.list(projectRoot);
    expect(entry.note).toBe('multi word note');
  });
});
