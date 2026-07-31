'use strict';

const { afterEach, describe, expect, test } = require('bun:test');
const path = require('node:path');

const {
  buildRecallEventPayload,
  launchMemoryRecallEvent,
  recordMemoryRecallEvent,
  recordMemoryRecallPayload,
} = require('../lib/memory-recall-events');
const hooks = require('../lib/commands/hooks');
const projectMemory = require('../lib/project-memory');
const { createLocalBroker } = require('../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../lib/kernel/sqlite-driver');
const { resolveKernelDatabasePath } = require('../lib/kernel/cli-broker-factory');
const { createKernelProjectRoots } = require('./helpers/kernel-project-root');

const { makeProjectRoot, cleanup } = createKernelProjectRoots('forge-recall-events-');

afterEach(() => {
  projectMemory.closeAll();
  cleanup();
});

describe('memory.recall.observed events', () => {
  test('launches the sanitized event writer detached from the prompt process', () => {
    const calls = [];
    let errorListener = null;
    let unrefed = false;
    const child = {
      on: (event, listener) => { if (event === 'error') errorListener = listener; },
      unref: () => { unrefed = true; },
    };

    const result = launchMemoryRecallEvent('/project', {
      outcome: 'selected',
      selectedIds: ['memory-1'],
      prompt: 'private prompt terms must not leave the hook',
    }, {
      spawn: (...args) => { calls.push(args); return child; },
    });

    expect(result).toEqual({ launched: true });
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(calls[0][0]).toBe(process.execPath);
    expect(calls[0][1].join(' ')).not.toContain('private prompt terms');
    expect(unrefed).toBe(true);
    expect(typeof errorListener).toBe('function');
  });

  test.each(['selected', 'empty', 'filtered', 'unsupported', 'timeout', 'error'])(
    'persists the bounded %s outcome through the real non-projecting event seam',
    async outcome => {
      const projectRoot = makeProjectRoot();
      const databasePath = resolveKernelDatabasePath({ projectRoot });
      const driver = createBuiltinSQLiteDriver({ databasePath });
      const broker = createLocalBroker({
        projectRoot,
        databasePath,
        driver,
        execFileSync: () => path.join(projectRoot, '.git'),
      });
      await broker.initialize();

      const result = await recordMemoryRecallEvent(projectRoot, {
        outcome,
        candidateCount: 3,
        eligibleCount: 2,
        selectedIds: ['memory-1'],
        sourceMix: { 'forge remember': 1 },
        trustMix: { confirmed: 1 },
        tokenEstimate: 42,
        elapsedMs: 17,
        harness: 'claude',
      }, {
        now: '2026-07-30T12:00:00.000Z',
        randomUUID: () => `event-${outcome}`,
        store: driver,
      });

      expect(result.recorded).toBe(true);
      const rows = await driver.listKernelEvents(
        'project',
        projectMemory.resolveProjectId(projectRoot)
      );
      const outbox = await driver.listProjectionOutbox();

      const event = rows.find(row => row.id === `event-${outcome}`);
      expect(event.event_type).toBe('memory.recall.observed');
      expect(JSON.parse(event.payload_json)).toMatchObject({
        outcome,
        selected_ids: ['memory-1'],
        counts: { candidates: 3, eligible: 2, selected: 1 },
        source_mix: { 'forge remember': 1 },
        trust_mix: { confirmed: 1 },
        token_estimate: 42,
        elapsed_ms: 17,
        harness: 'claude',
      });
      expect(outbox).toEqual([]);
      driver.close();
    }
  );

  test('serializes no query, prompt, memory body, snippet, fingerprint, key, or salt', () => {
    const payload = buildRecallEventPayload({
      outcome: 'selected',
      candidateCount: 1,
      eligibleCount: 1,
      selectedIds: ['memory-private'],
      sourceMix: { imported: 1 },
      trustMix: { suggested: 1 },
      tokenEstimate: 10,
      elapsedMs: 2,
      harness: 'claude',
      prompt: 'meaningful secret search terms',
      query: 'private query',
      memoryBody: 'private memory body',
      snippet: 'private snippet',
      fingerprint: 'query-fingerprint',
      key: 'secret-key',
      salt: 'secret-salt',
    });
    const serialized = JSON.stringify(payload);

    for (const forbidden of [
      'meaningful secret search terms',
      'private query',
      'private memory body',
      'private snippet',
      'query-fingerprint',
      'secret-key',
      'secret-salt',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('bounds identifiers, aggregate labels, counts, and numeric evidence', () => {
    const payload = buildRecallEventPayload({
      outcome: 'selected',
      candidateCount: -10,
      eligibleCount: Number.MAX_SAFE_INTEGER,
      selectedIds: Array.from({ length: 40 }, (_value, index) => `id-${index}-${'x'.repeat(200)}`),
      sourceMix: Object.fromEntries(
        Array.from({ length: 20 }, (_value, index) => [`source-${index}-${'x'.repeat(80)}`, 1])
      ),
      trustMix: { confirmed: 999999999, suggested: -1, unknown: 3 },
      tokenEstimate: Number.POSITIVE_INFINITY,
      elapsedMs: 999999999,
      harness: 'claude-with-an-unreasonably-long-name',
    });

    expect(payload.selected_ids).toHaveLength(20);
    expect(payload.selected_ids.every(id => id.length <= 128)).toBe(true);
    expect(Object.keys(payload.source_mix)).toHaveLength(10);
    expect(Object.keys(payload.source_mix).every(label => label.length <= 64)).toBe(true);
    expect(payload.counts.candidates).toBe(0);
    expect(payload.counts.eligible).toBe(1_000_000);
    expect(payload.trust_mix).toEqual({ confirmed: 1_000_000, unknown: 3 });
    expect(payload.token_estimate).toBe(0);
    expect(payload.elapsed_ms).toBe(1_000_000);
    expect(payload.harness.length).toBeLessThanOrEqual(32);
  });

  test('telemetry failure is best-effort and never blocks recall', async () => {
    const result = await recordMemoryRecallEvent('/project', {
      outcome: 'error',
      harness: 'claude',
    }, {
      projectId: '/project/.git',
      store: {
        insertKernelEvent: async () => {
          throw new Error('kernel unavailable');
        },
      },
    });

    expect(result).toEqual({ recorded: false, reason: 'kernel unavailable' });
  });

  test.each([
    ['null', null],
    ['malformed', { get outcome() { throw new Error('malformed payload'); } }],
  ])('direct %s payload failure is best-effort', async (_name, payload) => {
    const result = await recordMemoryRecallPayload('/project', payload);

    expect(result).toEqual({ recorded: false, reason: expect.any(String) });
  });

  test('the prompt hook reports selected ids and aggregate mix without prompt content', async () => {
    const observations = [];
    const result = await hooks.handler(
      ['memory-recall', '--harness', 'claude'],
      {},
      '/repo',
      {
        railEnabled: () => true,
        readInput: () => JSON.stringify({
          session_id: 'session-1',
          prompt: 'private auth refresh prompt',
        }),
        search: () => [{
          memory_id: 'memory-1',
          content: 'Auth refresh uses the shared helper.',
          trust_status: 'confirmed',
          provenance: { source_agent: 'forge remember' },
          score: -3,
        }],
        loadSeen: () => [],
        saveSeen: () => {},
        appendShadow: () => {},
        scoreFloor: -1,
        recordRecallEvent: (_root, observation) => observations.push(observation),
      }
    );

    expect(result.output).toContain('Auth refresh uses the shared helper.');
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      outcome: 'selected',
      candidateCount: 1,
      eligibleCount: 1,
      selectedIds: ['memory-1'],
      sourceMix: { 'forge remember': 1 },
      trustMix: { confirmed: 1 },
      harness: 'claude',
    });
    expect(JSON.stringify(buildRecallEventPayload(observations[0])))
      .not.toContain('private auth refresh prompt');
  });

  test.each([
    ['empty', { search: () => [] }],
    ['filtered', { railEnabled: () => false }],
    ['unsupported', { harness: 'codex' }],
    ['timeout', { search: () => new Promise(() => {}), promptRecallDeadlineMs: 10 }],
    ['error', { search: () => { throw new Error('kernel unavailable'); } }],
  ])('the prompt hook reports the %s outcome', async (outcome, overrides) => {
    const observations = [];
    const harness = overrides.harness || 'claude';
    await hooks.handler(
      ['memory-recall', '--harness', harness],
      {},
      '/repo',
      {
        railEnabled: () => true,
        readInput: () => JSON.stringify({
          session_id: 'session-1',
          prompt: 'auth refresh failure',
        }),
        search: () => [],
        loadSeen: () => [],
        saveSeen: () => {},
        appendShadow: () => {},
        recordRecallEvent: (_root, observation) => observations.push(observation),
        ...overrides,
      }
    );

    expect(observations).toHaveLength(1);
    expect(observations[0].outcome).toBe(outcome);
  });

  test('a rejecting event recorder never suppresses selected memory', async () => {
    const result = await hooks.handler(
      ['memory-recall', '--harness', 'claude'],
      {},
      '/repo',
      {
        railEnabled: () => true,
        readInput: () => JSON.stringify({
          session_id: 'session-1',
          prompt: 'auth refresh failure',
        }),
        search: () => [{
          memory_id: 'memory-1',
          content: 'Selected memory remains available.',
          trust_status: 'confirmed',
          score: -3,
        }],
        loadSeen: () => [],
        saveSeen: () => {},
        appendShadow: () => {},
        scoreFloor: -1,
        recordRecallEvent: () => Promise.reject(new Error('telemetry unavailable')),
      }
    );

    expect(result.output).toContain('Selected memory remains available.');
  });
});
