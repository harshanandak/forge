'use strict';

const { afterEach, describe, test, expect } = require('bun:test');

const recall = require('../../lib/commands/recall');
const remember = require('../../lib/commands/remember');
const projectMemory = require('../../lib/project-memory');
const { createKernelProjectRoots } = require('../helpers/kernel-project-root');

// recall reads the kernel store, whose default path resolves from the git common dir — so
// each temp project is a throwaway git repo. Notes are seeded through the real remember path.
const { makeProjectRoot, cleanup } = createKernelProjectRoots('forge-recall-cmd-');

async function seed(projectRoot, note) {
  await remember.handler([note], {}, projectRoot);
}

afterEach(() => {
  projectMemory.closeAll();
  cleanup();
});

describe('forge recall command', () => {
  test('exports the registry command contract', () => {
    expect(recall.name).toBe('recall');
    expect(typeof recall.description).toBe('string');
    expect(recall.description.length).toBeGreaterThan(0);
    expect(typeof recall.handler).toBe('function');
    expect(recall.usage).toContain('recall');
    expect(recall.usage).toContain('[query]');
    // The store is the kernel table now, not a flat file.
    expect(recall.description).toContain('kernel');
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

  test('emits JSON output with --json (object carrying total + capped)', async () => {
    const projectRoot = makeProjectRoot();
    await seed(projectRoot, 'alpha note');

    const result = await recall.handler(['--json'], {}, projectRoot);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    // An object (not a bare array) so consumers can detect truncation.
    expect(Array.isArray(parsed.notes)).toBe(true);
    expect(parsed.notes[0].note).toBe('alpha note');
    expect(parsed.total).toBe(1);
    expect(parsed.capped).toBe(false);
  });

  test('honors --limit and signals truncation in --json', async () => {
    const projectRoot = makeProjectRoot();
    await seed(projectRoot, 'one');
    await seed(projectRoot, 'two');
    await seed(projectRoot, 'three');

    const result = await recall.handler(['--json', '--limit', '2'], {}, projectRoot);
    const parsed = JSON.parse(result.output);
    expect(parsed.notes).toHaveLength(2);
    // The programmatic consumer can see the result was truncated below the true total.
    expect(parsed.total).toBe(3);
    expect(parsed.capped).toBe(true);
  });

  test('renders the capped human header "Showing N of TOTAL"', async () => {
    const projectRoot = makeProjectRoot();
    await seed(projectRoot, 'one');
    await seed(projectRoot, 'two');
    await seed(projectRoot, 'three');

    const result = await recall.handler(['--limit', '2'], {}, projectRoot);
    expect(result.output).toContain('Showing 2 of 3 remembered note(s) (newest first):');
  });

  test('finds a note by its tag (tags are indexed for recall)', async () => {
    const projectRoot = makeProjectRoot();
    await remember.handler(['rotate the signing key', '--tag', 'security'], {}, projectRoot);
    await seed(projectRoot, 'unrelated note');

    const result = await recall.handler(['security'], {}, projectRoot);
    expect(result.success).toBe(true);
    expect(result.output).toContain('rotate the signing key');
    expect(result.output).not.toContain('unrelated note');
  });

  test('surfaces an insights-written kernel_memories row via query and --all, readably', async () => {
    const projectRoot = makeProjectRoot();
    await seed(projectRoot, 'plain human note');
    // Mimic `forge insights`: a skill record written straight to kernel_memories (object
    // value + insights tags), NOT through `remember`. recall reads the same table.
    projectMemory.write(projectRoot, {
      key: 'insights:skill.cand-42',
      value: { candidateId: 'cand-42', status: 'accepted', note: 'recurring lint gate' },
      sourceAgent: 'forge insights',
      tags: ['insights', 'accepted'],
    });

    // Discoverable by its tokens via FTS (query searches the WHOLE store)...
    const byToken = await recall.handler(['accepted'], {}, projectRoot);
    expect(byToken.success).toBe(true);
    expect(byToken.output).toContain('cand-42');
    // ...rendered readably and LABELED with its source, never a raw JSON blob.
    expect(byToken.output).toContain('(forge insights)');
    expect(byToken.output).not.toContain('{"candidateId"');

    // The DEFAULT no-query listing shows only human notes — the machine record is excluded
    // and does NOT inflate the "remembered note(s)" count.
    const defaultListing = await recall.handler(['--json'], {}, projectRoot);
    const defaultParsed = JSON.parse(defaultListing.output);
    expect(defaultParsed.total).toBe(1);
    expect(defaultParsed.notes.some(note => note.note.includes('cand-42'))).toBe(false);

    // `--all` widens the no-query listing to include machine/insights records.
    const allListing = await recall.handler(['--all', '--json'], {}, projectRoot);
    const allParsed = JSON.parse(allListing.output);
    expect(allParsed.notes.some(note => note.note.includes('cand-42'))).toBe(true);
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
