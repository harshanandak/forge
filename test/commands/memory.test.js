'use strict';

const { afterEach, describe, test, expect } = require('bun:test');

const memory = require('../../lib/commands/memory');
const remember = require('../../lib/commands/remember');
const recall = require('../../lib/commands/recall');
const projectMemory = require('../../lib/project-memory');
const { createKernelProjectRoots } = require('../helpers/kernel-project-root');

// forge memory wraps the SAME kernel-backed store the standalone remember/recall
// commands use — so each temp project is a throwaway git repo (notes land in .git/forge).
const { makeProjectRoot, cleanup } = createKernelProjectRoots('forge-memory-cmd-');

async function recalledNotes(projectRoot, args = []) {
  const result = await recall.handler(['--json', ...args], {}, projectRoot);
  return JSON.parse(result.output).notes;
}

afterEach(() => {
  projectMemory.closeAll();
  cleanup();
});

describe('forge memory command surface (25362344)', () => {
  test('exports the registry command contract', () => {
    expect(memory.name).toBe('memory');
    expect(typeof memory.description).toBe('string');
    expect(memory.description.length).toBeGreaterThan(0);
    expect(memory.description.length).toBeLessThanOrEqual(1024);
    expect(typeof memory.handler).toBe('function');
    expect(memory.usage).toContain('memory');
  });

  test('no subcommand lists the available subcommands', async () => {
    const projectRoot = makeProjectRoot();
    const result = await memory.handler([], {}, projectRoot);
    expect(result.success).toBe(true);
    for (const sub of ['add', 'recall', 'search', 'insights']) {
      expect(result.output).toContain(sub);
    }
  });

  test('--help lists the available subcommands', async () => {
    const projectRoot = makeProjectRoot();
    const result = await memory.handler(['--help'], {}, projectRoot);
    expect(result.success).toBe(true);
    expect(result.output).toContain('add');
    expect(result.output).toContain('recall');
  });

  test('an unknown subcommand fails and points at the surface', async () => {
    const projectRoot = makeProjectRoot();
    const result = await memory.handler(['frobnicate'], {}, projectRoot);
    expect(result.success).toBe(false);
    expect(result.error).toContain('frobnicate');
    expect(result.error).toContain('add');
  });

  test('memory add persists a note through the same store as remember', async () => {
    const projectRoot = makeProjectRoot();
    const result = await memory.handler(['add', 'Run /plan before /dev'], {}, projectRoot);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Run /plan before /dev');

    const notes = await recalledNotes(projectRoot);
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toBe('Run /plan before /dev');
  });

  test('memory add joins multiple words into one note', async () => {
    const projectRoot = makeProjectRoot();
    await memory.handler(['add', 'Prefer', 'Bun', 'over', 'npm'], {}, projectRoot);
    const notes = await recalledNotes(projectRoot);
    expect(notes[0].note).toBe('Prefer Bun over npm');
  });

  test('memory recall reads notes back (JSON)', async () => {
    const projectRoot = makeProjectRoot();
    await memory.handler(['add', 'first note'], {}, projectRoot);
    const result = await memory.handler(['recall', '--json'], {}, projectRoot);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.notes[0].note).toBe('first note');
  });

  test('memory search finds a matching note by query', async () => {
    const projectRoot = makeProjectRoot();
    await memory.handler(['add', 'deploy with bun build compile'], {}, projectRoot);
    await memory.handler(['add', 'unrelated note about cats'], {}, projectRoot);
    const result = await memory.handler(['search', 'compile', '--json'], {}, projectRoot);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.notes.some(n => n.note.includes('compile'))).toBe(true);
    expect(parsed.notes.some(n => n.note.includes('cats'))).toBe(false);
  });

  test('memory insights routes to the insights analyzer', async () => {
    const projectRoot = makeProjectRoot();
    const result = await memory.handler(['insights', '--json'], {}, projectRoot);
    expect(result.success).toBe(true);
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });

  test('back-compat: forge remember still works as a standalone alias', async () => {
    const projectRoot = makeProjectRoot();
    const result = await remember.handler(['legacy path still works'], {}, projectRoot);
    expect(result.success).toBe(true);
    const notes = await recalledNotes(projectRoot);
    expect(notes[0].note).toBe('legacy path still works');
  });
});

describe('typed + structured memory notes (8cc1db4d)', () => {
  test('memory add --kind stores the type as a filterable tag', async () => {
    const projectRoot = makeProjectRoot();
    await memory.handler(['add', 'use CAS for concurrent writes', '--kind', 'decision'], {}, projectRoot);
    const notes = await recalledNotes(projectRoot);
    expect(notes[0].note).toContain('use CAS for concurrent writes');
    expect(notes[0].tags).toContain('type:decision');
    expect(notes[0].type).toBe('decision');
  });

  test('memory recall --kind filters to notes of that type', async () => {
    const projectRoot = makeProjectRoot();
    await memory.handler(['add', 'a decision note', '--kind', 'decision'], {}, projectRoot);
    await memory.handler(['add', 'a bugfix note', '--kind', 'bugfix'], {}, projectRoot);
    await memory.handler(['add', 'an untyped note'], {}, projectRoot);

    const notes = await recalledNotes(projectRoot, ['--kind', 'decision']);
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toContain('a decision note');
    expect(notes[0].type).toBe('decision');
  });

  test('memory search --kind filters query results by type', async () => {
    const projectRoot = makeProjectRoot();
    await memory.handler(['add', 'kernel lease broker gotcha', '--kind', 'gotcha'], {}, projectRoot);
    await memory.handler(['add', 'kernel lease broker decision', '--kind', 'decision'], {}, projectRoot);

    const result = await memory.handler(['search', 'kernel', '--kind', 'gotcha', '--json'], {}, projectRoot);
    const parsed = JSON.parse(result.output);
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0].note).toContain('gotcha');
  });

  test('structured What/Why/Where/Learned fields are stored in the note body', async () => {
    const projectRoot = makeProjectRoot();
    await memory.handler(
      ['add', 'switched to write-behind emit', '--kind', 'decision',
        '--what', 'graphiti emit is non-blocking',
        '--why', 'remember must never hang',
        '--where', 'lib/memory/router.js',
        '--learned', 'local kernel write is the floor'],
      {},
      projectRoot
    );
    const notes = await recalledNotes(projectRoot);
    const body = notes[0].note;
    expect(body).toContain('switched to write-behind emit');
    expect(body).toContain('What: graphiti emit is non-blocking');
    expect(body).toContain('Why: remember must never hang');
    expect(body).toContain('Where: lib/memory/router.js');
    expect(body).toContain('Learned: local kernel write is the floor');
  });

  test('back-compat: forge remember --kind gets the typed-note feature too', async () => {
    const projectRoot = makeProjectRoot();
    await remember.handler(['a typed legacy note', '--kind', 'gotcha'], {}, projectRoot);
    const notes = await recalledNotes(projectRoot, ['--kind', 'gotcha']);
    expect(notes).toHaveLength(1);
    expect(notes[0].tags).toContain('type:gotcha');
  });

  test('a note without a type is unaffected (type is optional)', async () => {
    const projectRoot = makeProjectRoot();
    await memory.handler(['add', 'plain note'], {}, projectRoot);
    const notes = await recalledNotes(projectRoot);
    expect(notes[0].note).toBe('plain note');
    expect(notes[0].tags).toEqual([]);
    expect(notes[0].type).toBeUndefined();
  });
});
