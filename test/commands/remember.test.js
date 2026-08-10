'use strict';

const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { afterEach, describe, test, expect } = require('bun:test');

const remember = require('../../lib/commands/remember');
const recall = require('../../lib/commands/recall');
const projectMemory = require('../../lib/project-memory');
const { createKernelProjectRoots } = require('../helpers/kernel-project-root');
const { createPhaseWatchdog } = require('../helpers/phase-watchdog');
const { seedMemoryEntries } = require('../helpers/seed-memory');

// remember/recall now persist to the kernel store, whose default path resolves from the git
// common dir — so each temp project is a throwaway git repo. Notes land in .git/forge.
const { makeProjectRoot, cleanup } = createKernelProjectRoots('forge-remember-cmd-');

// The persisted notes, newest-first, as recall renders them (JSON mode → { notes, ... }).
async function recalledNotes(projectRoot) {
  const result = await recall.handler(['--json'], {}, projectRoot);
  return JSON.parse(result.output).notes;
}

async function withPhaseDiagnostics(phases, operation) {
  try {
    return await operation();
  } catch (error) {
    const detail = Object.entries(phases)
      .map(([name, elapsedMs]) => `${name}=${elapsedMs.toFixed(1)}ms`)
      .join(', ');
    error.message = `${error.message} (phase timings: ${detail || 'unavailable'})`;
    throw error;
  }
}

async function timedPhase(phases, watchdog, name, operation) {
  const started = performance.now();
  watchdog.enter(name);
  try {
    return await operation();
  } finally {
    phases[name] = performance.now() - started;
    watchdog.complete(name);
  }
}

afterEach(() => {
  projectMemory.closeAll();
  cleanup();
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

  // Explicit session-summary path (kernel 3867b9c2): `--session-summary` is the memorable
  // one-flag alias for `--kind session-summary`, so an agent can capture on the way out with
  // the same #392 structured fields (--what/--why/--learned). Surfaced via `forge memory add`.
  test('--session-summary writes a retrievable type:session-summary typed note', async () => {
    const projectRoot = makeProjectRoot();
    const result = await remember.handler(
      ['--session-summary', 'wrapped the capture hook', '--what', 'added PreCompact/Stop capture',
        '--why', 'memory was pull-only', '--learned', 'trigger rides as a CLI arg', '--json'],
      {},
      projectRoot
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output);
    expect(payload.type).toBe('session-summary');

    const [entry] = await recalledNotes(projectRoot);
    expect(entry.tags).toContain('type:session-summary');
    // Structured fields are folded into the body so they stay FTS-searchable.
    expect(entry.note).toContain('What: added PreCompact/Stop capture');
    expect(entry.note).toContain('Learned: trigger rides as a CLI arg');
  });

  test('--session-summary is advertised in the command flags', () => {
    expect(remember.flags['--session-summary']).toBeDefined();
  });

  test('repeated identical session summaries are idempotent and carry deterministic metadata', async () => {
    const projectRoot = makeProjectRoot();
    const args = ['--session-summary', '--what', 'implemented hook', '--why', 'preserve learnings',
      '--where', 'lib/hook-renderer.js', '--learned', 'supported hooks only', '--json'];
    const first = JSON.parse((await remember.handler(args, {}, projectRoot)).output);
    const second = JSON.parse((await remember.handler(args, {}, projectRoot)).output);
    const notes = await recalledNotes(projectRoot);
    expect(notes).toHaveLength(1);
    expect(first.id).toBeString();
    expect(second.id).toBe(first.id);
    expect(second.type).toBe('session-summary');
    expect(second.metadata).toEqual(first.metadata);
    expect(second.metadata).toEqual({
      kind: 'session-summary',
      content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test('session-summary metadata canonicalizes tags with locale-aware ordering', async () => {
    const projectRoot = makeProjectRoot();
    const payload = JSON.parse((await remember.handler(
      ['--session-summary', '--what', 'implemented hook', '--tag', 'z', '--tag', 'ä', '--json'],
      {},
      projectRoot
    )).output);
    const expected = crypto.createHash('sha256').update(JSON.stringify({
      body: 'What: implemented hook',
      tags: ['ä', 'z'],
      type: 'session-summary',
    }), 'utf8').digest('hex');
    expect(payload.metadata.content_hash).toBe(expected);
  });

  test('session-summary idempotency is not limited to the newest 100 memories', async () => {
    const phases = {};
    const watchdog = createPhaseWatchdog();
    try {
      await withPhaseDiagnostics(phases, async () => {
        watchdog.start();
        const setupStarted = performance.now();
        watchdog.enter('project setup');
        let projectRoot;
        try {
          projectRoot = makeProjectRoot();
        } finally {
          phases['project setup'] = performance.now() - setupStarted;
          watchdog.complete('project setup');
        }
        const args = ['--session-summary', '--what', 'implemented hook', '--json'];
        const first = JSON.parse((await timedPhase(
          phases,
          watchdog,
          'initial remember',
          () => remember.handler(args, {}, projectRoot),
        )).output);
        const seeded = await timedPhase(
          phases,
          watchdog,
          'fixture seeding',
          () => seedMemoryEntries(projectRoot, Array.from({ length: 101 }, (_, index) => ({
            key: `newer-${index}`,
            value: `newer note ${index}`,
            sourceAgent: 'forge remember',
            tags: [],
            timestamp: `2099-08-09T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
          }))),
        );
        expect(seeded.count).toBe(102);
        expect(seeded.newestKey).toBe('newer-59');

        const repeated = JSON.parse((await timedPhase(
          phases,
          watchdog,
          'final remember/recall',
          () => remember.handler(args, {}, projectRoot),
        )).output);
        expect(repeated.id).toBe(first.id);
      });
    } finally {
      watchdog.stop();
    }
  });
});
