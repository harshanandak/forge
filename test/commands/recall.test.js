'use strict';

const { afterEach, describe, test, expect } = require('bun:test');

const recall = require('../../lib/commands/recall');
const remember = require('../../lib/commands/remember');
const projectMemory = require('../../lib/project-memory');
const { OPEN, CLOSE } = require('../../lib/untrusted-content');
const { createKernelProjectRoots } = require('../helpers/kernel-project-root');
const { seedRecallMemories } = require('../helpers/recall-memory-fixture');
const { createRecallPhaseWatchdog } = require('../helpers/recall-phase-watchdog');

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
  test('labels trust/source/update, separates suggestions, and skips an oversized note', async () => {
    const watchdog = createRecallPhaseWatchdog();
    let result;
    const observations = [];
    try {
      watchdog.enter('project setup');
      const projectRoot = makeProjectRoot();
      watchdog.enter('fixture seeding');
      await seedRecallMemories(projectRoot, [
        {
          key: 'small-confirmed',
          value: 'small confirmed memory',
          sourceAgent: 'forge remember',
          tags: [],
          timestamp: '2026-07-30T00:00:00.000Z',
        },
        {
          key: 'small-suggested',
          value: 'small suggested memory',
          sourceAgent: 'forge remember (imported)',
          tags: ['trust:suggested'],
          timestamp: '2026-07-29T00:00:00.000Z',
        },
        {
          key: 'oversized',
          value: `oversized ${'x'.repeat(6000)}`,
          sourceAgent: 'forge remember',
          tags: [],
          timestamp: '2026-07-31T00:00:00.000Z',
        },
      ]);
      watchdog.enter('recall');
      result = await recall.handler([], {}, projectRoot, {
        onUsageEvidence: observation => observations.push(observation),
      });
    } finally {
      watchdog.stop();
    }

    expect(result.output).toContain('Confirmed memory');
    expect(result.output).toContain('Suggested memory — verify before relying');
    expect(result.output).toContain('source=forge remember');
    expect(result.output).toContain('trust=confirmed');
    expect(result.output).toContain('updated=2026-07-30');
    expect(result.output).toContain('small confirmed memory');
    expect(result.output).toContain('small suggested memory');
    expect(result.output).not.toContain('oversized ');
    expect(Math.ceil(result.output.length / 4)).toBeLessThanOrEqual(1200);
    expect(observations).toEqual([{ attempted: 2, appended: 2, failed: 0 }]);
  });

  test('recall fixture watchdog reports only a threshold breach with the active phase', () => {
    let now = 0;
    let callback;
    const diagnostics = [];
    const cleared = [];
    const watchdog = createRecallPhaseWatchdog({
      thresholdMs: 10,
      now: () => now,
      emit: message => diagnostics.push(message),
      setTimeoutImpl: scheduled => {
        callback = scheduled;
        return 1;
      },
      clearTimeoutImpl: handle => cleared.push(handle),
    });

    watchdog.enter('project setup');
    now = 2;
    watchdog.enter('fixture seeding');
    now = 12;
    callback();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('active phase: fixture seeding');
    expect(diagnostics[0]).toContain('project setup=2.0ms');
    expect(diagnostics[0]).toContain('fixture seeding=10.0ms');
    watchdog.stop();
    expect(cleared).toHaveLength(0);

    const quietDiagnostics = [];
    const quietCleared = [];
    let quietCallback;
    const quiet = createRecallPhaseWatchdog({
      thresholdMs: 10,
      emit: message => quietDiagnostics.push(message),
      setTimeoutImpl: scheduled => {
        quietCallback = scheduled;
        return 2;
      },
      clearTimeoutImpl: handle => quietCleared.push(handle),
    });
    quiet.enter('recall');
    quiet.stop();
    quietCallback();
    expect(quietDiagnostics).toEqual([]);
    expect(quietCleared).toEqual([2]);
  });

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

  test('durably records JSON-surfaced notes and keeps output unchanged when evidence fails', async () => {
    const projectRoot = makeProjectRoot();
    await seed(projectRoot, 'small surfaced note');
    const observations = [];

    const result = await recall.handler(['--json'], {}, projectRoot, {
      invocationId: 'test-recall-invocation',
      onUsageEvidence: observation => observations.push(observation),
    });

    expect(JSON.parse(result.output).notes).toHaveLength(1);
    expect(observations).toEqual([{ attempted: 1, appended: 1, failed: 0 }]);
    const outputBeforeFailure = await recall.handler([], {}, projectRoot);
    const outputAfterFailure = await recall.handler([], {}, projectRoot, {
      invocationId: 'failure-is-advisory',
      usageStore: { appendUsageEvidence() { throw new Error('private write failure'); } },
    });
    expect(outputAfterFailure).toEqual(outputBeforeFailure);
  });

  test('hostile private command options never invoke accessors or alter recall output', async () => {
    const projectRoot = makeProjectRoot();
    await seed(projectRoot, 'safe recall output');
    let getterCalls = 0;
    const commandOpts = {};
    for (const field of ['invocationId', 'usageStore', 'onUsageEvidence', 'invocationStartedAt', 'now']) {
      Object.defineProperty(commandOpts, field, { get() { getterCalls += 1; return null; } });
    }
    const normal = await recall.handler(['--json'], {}, projectRoot);
    const hostile = await recall.handler(['--json'], {}, projectRoot, commandOpts);
    expect(hostile.output).toEqual(normal.output);
    expect(getterCalls).toBe(0);

    let trapCalls = 0;
    const proxyOpts = new Proxy({}, { getOwnPropertyDescriptor() { trapCalls += 1; } });
    const proxied = await recall.handler(['--json'], {}, projectRoot, proxyOpts);
    expect(proxied.output).toEqual(normal.output);
    expect(trapCalls).toBe(0);

    let callbackTraps = 0;
    const hostileCallback = new Proxy(() => {}, { apply() { callbackTraps += 1; } });
    const withHostileCallback = await recall.handler(['--json'], {}, projectRoot, { onUsageEvidence: hostileCallback });
    expect(withHostileCallback.output).toEqual(normal.output);
    expect(callbackTraps).toBe(0);
  });

  test('a stable injected invocation retries idempotently with the same real start timestamp', async () => {
    const projectRoot = makeProjectRoot();
    await seed(projectRoot, 'retry-safe evidence');
    const first = [];
    const second = [];
    await recall.handler(['--json'], {}, projectRoot, {
      invocationId: 'stable-retry', now: '2026-08-10T00:00:00.000Z', onUsageEvidence: value => first.push(value),
    });
    await recall.handler(['--json'], {}, projectRoot, {
      invocationId: 'stable-retry', now: '2026-08-10T00:00:00.000Z', onUsageEvidence: value => second.push(value),
    });
    expect(first).toEqual([{ attempted: 1, appended: 1, failed: 0 }]);
    expect(second).toEqual([{ attempted: 1, appended: 0, failed: 0 }]);
  });

  test('divergent invocation start timestamps conflict only advisory evidence and retain useful recall output', async () => {
    const projectRoot = makeProjectRoot();
    await seed(projectRoot, 'real timestamp evidence');
    const first = await recall.handler(['--json'], {}, projectRoot, {
      invocationId: 'stable-conflict', now: '2026-08-10T00:00:00.000Z',
    });
    const observed = [];
    const second = await recall.handler(['--json'], {}, projectRoot, {
      invocationId: 'stable-conflict', now: '2026-08-11T00:00:00.000Z', onUsageEvidence: value => observed.push(value),
    });
    const [{ id }] = JSON.parse(first.output).notes;
    expect(projectMemory.usageProjection(projectRoot, id)).toMatchObject({ last_used_at: '2026-08-10T00:00:00.000Z' });
    expect(second.output).toEqual(first.output);
    expect(observed).toEqual([{ attempted: 1, appended: 0, failed: 1 }]);
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

  test('fences budgeted notes after truncation and reports only rendered entries', async () => {
    const projectRoot = makeProjectRoot();
    for (let index = 0; index < 3; index += 1) {
      projectMemory.write(projectRoot, {
        key: `budgeted-${index}`,
        value: `note ${index} ${'x'.repeat(2400)}`,
        sourceAgent: 'forge remember',
        tags: [],
        timestamp: `2026-07-${30 - index}T00:00:00.000Z`,
      });
    }

    const result = await recall.handler([], {}, projectRoot);

    expect(result.output).toContain('Showing 2 of 3 remembered note(s) (newest first):');
    expect((result.output.match(new RegExp(OPEN, 'g')) || [])).toHaveLength(4);
    expect((result.output.match(new RegExp(CLOSE, 'g')) || [])).toHaveLength(4);
    expect((result.output.match(/END UNTRUSTED/g) || [])).toHaveLength(2);
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
