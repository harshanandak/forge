'use strict';

const { afterEach, describe, test, expect } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const remember = require('../../lib/commands/remember');
const recall = require('../../lib/commands/recall');
const projectMemory = require('../../lib/project-memory');

const tempDirs = [];

// remember/recall now persist to the kernel store, whose default path resolves from the git
// common dir — so each temp project is a throwaway git repo. Notes land in .git/forge.
function makeProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-remember-cmd-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  tempDirs.push(dir);
  return dir;
}

// Windows can hold a transient WAL lock on the just-written kernel DB; close cached stores
// first, then retry the rm.
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

// The persisted notes, newest-first, as recall renders them (JSON mode → { notes, ... }).
async function recalledNotes(projectRoot) {
  const result = await recall.handler(['--json'], {}, projectRoot);
  return JSON.parse(result.output).notes;
}

afterEach(() => {
  projectMemory.closeAll();
  while (tempDirs.length > 0) {
    rmrfWithRetry(tempDirs.pop());
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
    // The store is the kernel table now, not a flat file.
    expect(remember.description).toContain('kernel');
  });

  test('persists a note and reports success', async () => {
    const projectRoot = makeProjectRoot();
    const result = await remember.handler(['Run /plan before /dev'], {}, projectRoot);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Run /plan before /dev');

    const notes = await recalledNotes(projectRoot);
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toBe('Run /plan before /dev');
  });

  test('joins multiple argument words into a single note', async () => {
    const projectRoot = makeProjectRoot();
    await remember.handler(['Prefer', 'Bun', 'over', 'npm'], {}, projectRoot);

    const notes = await recalledNotes(projectRoot);
    expect(notes[0].note).toBe('Prefer Bun over npm');
  });

  test('captures --tag values as tags', async () => {
    const projectRoot = makeProjectRoot();
    await remember.handler(['note body', '--tag', 'policy', '--tag', 'workflow'], {}, projectRoot);

    const notes = await recalledNotes(projectRoot);
    expect(notes[0].note).toBe('note body');
    expect(notes[0].tags).toEqual(['policy', 'workflow']);
  });

  test('fails clearly when no note is provided', async () => {
    const projectRoot = makeProjectRoot();
    const result = await remember.handler([], {}, projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toContain('note');
    expect(await recalledNotes(projectRoot)).toEqual([]);
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
    const [entry] = await recalledNotes(projectRoot);
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
    const [entry] = await recalledNotes(projectRoot);
    expect(entry.note).toBe('multi word note');
  });
});
