// forge-test-resource: exclusive
'use strict';

const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const hooks = require('../../lib/commands/hooks');
const projectMemory = require('../../lib/project-memory');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const fixture = require('../fixtures/memory-recall-holdouts.json');

const roots = [];
const drivers = [];
const rootCaseLabels = new Map();
const phaseTimings = new Map();
const timingOutputPath = path.join(
  process.cwd(),
  'test-results',
  `memory-recall-holdout-timing-${process.pid}-${Date.now()}.json`,
);
let activeCaseLabel = null;
let activeCaseTiming = null;
let timingRecordFailed = false;

function beginProfileCase(caseLabel) {
  activeCaseLabel = caseLabel;
  activeCaseTiming = {
    wallStartedAt: performance.now(),
    cpuStartedAt: process.cpuUsage(),
  };
}

function trackRoot(root, caseLabel = activeCaseLabel) {
  roots.push(root);
  rootCaseLabels.set(root, caseLabel);
  return root;
}

function recordPhase(caseLabel, phase, wallMs, cpuUsage) {
  const key = `${caseLabel}:${phase}`;
  const current = phaseTimings.get(key) || {
    caseLabel,
    phase,
    count: 0,
    wallMs: 0,
    cpuMs: 0,
  };
  current.count += 1;
  current.wallMs += wallMs;
  current.cpuMs += (cpuUsage.user + cpuUsage.system) / 1_000;
  phaseTimings.set(key, current);
}

function measureSync(caseLabel, phase, operation) {
  const wallStartedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();
  try {
    return operation();
  } finally {
    try {
      recordPhase(
        caseLabel,
        phase,
        performance.now() - wallStartedAt,
        process.cpuUsage(cpuStartedAt),
      );
    } catch {
      timingRecordFailed = true;
    }
  }
}

function createProfiledDriver(caseLabel, options) {
  const store = createBuiltinSQLiteDriver(options);
  let recordCount = 0;
  const phases = new Map([
    ['recordMemory', () => (recordCount++ === 0 ? 'record.first' : 'record.later')],
    ['searchMemoriesRankedScored', () => 'search'],
    ['close', () => 'close'],
  ]);
  for (const [method, phaseForCall] of phases) {
    const original = store[method];
    if (typeof original !== 'function') continue;
    store[method] = function profiledDriverMethod(...args) {
      return measureSync(caseLabel, phaseForCall(), () => original.apply(this, args));
    };
  }
  return store;
}

function timingSummary() {
  const cases = {};
  const entries = [...phaseTimings.values()].sort((left, right) => (
    left.caseLabel.localeCompare(right.caseLabel) || left.phase.localeCompare(right.phase)
  ));
  for (const entry of entries) {
    const caseSummary = cases[entry.caseLabel] || {};
    caseSummary[entry.phase] = {
      count: entry.count,
      wallMs: Number(entry.wallMs.toFixed(3)),
      cpuMs: Number(entry.cpuMs.toFixed(3)),
    };
    cases[entry.caseLabel] = caseSummary;
  }
  return {
    schema: 'forge.memory-recall-holdout-timing.v1',
    timingRecordFailed,
    hardKillLimit: 'A hard process termination can prevent the active case from reaching afterEach.',
    cases,
  };
}

function flushTimingSummary() {
  const outputDirectory = path.dirname(timingOutputPath);
  const temporaryPath = `${timingOutputPath}.tmp`;
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(timingSummary(), null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, timingOutputPath);
}

function createRecallContext(prefix = 'forge-memory-holdout-', caseLabel = activeCaseLabel) {
  const root = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), caseLabel);
  const commonDir = path.join(root, '.git');
  fs.mkdirSync(commonDir);
  const projectId = commonDir.replaceAll('\\', '/').toLowerCase();
  const store = createProfiledDriver(caseLabel, {
    databasePath: path.join(root, 'kernel.sqlite'),
  });
  drivers.push(store);
  return { root, commonDir, projectId, store };
}

function writeMemory(context, entry) {
  projectMemory.write(context.root, {
    sourceAgent: 'forge remember',
    tags: [],
    scope: context.projectId,
    ...entry,
  }, { store: context.store });
}

async function runAssembledRecall(context, options = {}) {
  const harness = options.harness || 'claude';
  return hooks.handler(['memory-recall', '--harness', harness], {}, options.root || context.root, {
    railEnabled: () => options.railEnabled ?? true,
    readInput: () => JSON.stringify({
      session_id: options.sessionId || 'holdout',
      prompt: options.prompt || fixture.projectLocal.prompt,
    }),
    search: (_root, query, limit, searchOptions) => projectMemory.searchRankedScored(
      options.root || context.root,
      query,
      limit,
      {
        ...searchOptions,
        ...(options.now ? { now: options.now } : {}),
        store: context.store,
        gitCommonDir: context.commonDir,
        realpath: value => value,
        platform: 'win32',
      },
    ),
    loadSeen: () => options.seenKeys || [],
    saveSeen: options.saveSeen || (() => {}),
    appendShadow: options.appendShadow || (() => {}),
    recordRecallEvent: () => {},
    ...(options.tokenBudget ? { tokenBudget: options.tokenBudget } : {}),
  });
}

function additionalContext(result) {
  return JSON.parse(result.output).hookSpecificOutput.additionalContext;
}

afterEach(() => {
  let firstError = null;
  while (drivers.length) {
    const store = drivers.pop();
    try {
      store.close();
    } catch (error) {
      firstError ||= error;
    }
  }
  while (roots.length) {
    const root = roots.pop();
    const caseLabel = rootCaseLabels.get(root) || activeCaseLabel;
    rootCaseLabels.delete(root);
    try {
      measureSync(caseLabel, 'cleanup', () => fs.rmSync(root, { recursive: true, force: true }));
    } catch (error) {
      firstError ||= error;
    }
  }
  if (activeCaseTiming) {
    try {
      recordPhase(
        activeCaseLabel,
        'total',
        performance.now() - activeCaseTiming.wallStartedAt,
        process.cpuUsage(activeCaseTiming.cpuStartedAt),
      );
    } catch {
      timingRecordFailed = true;
    }
  }
  try {
    flushTimingSummary();
  } catch {
    timingRecordFailed = true;
    try {
      process.stderr.write('memory-recall holdout timing diagnostic flush failed\n');
    } catch {
      // An unavailable diagnostic stream must not mask the original test or cleanup failure.
    }
  }
  activeCaseLabel = null;
  activeCaseTiming = null;
  if (firstError) throw firstError;
});

describe('project-local memory recall holdout', () => {
  test('foreign rows cannot crowd an unseen local memory out of additionalContext', async () => {
    beginProfileCase('foreign-crowding');
    const root = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-holdout-')));
    const commonDir = path.join(root, '.git');
    fs.mkdirSync(commonDir);
    const projectId = commonDir.replaceAll('\\', '/').toLowerCase();
    const store = createProfiledDriver(activeCaseLabel, {
      databasePath: path.join(root, 'kernel.sqlite'),
    });
    drivers.push(store);

    for (let index = 0; index < fixture.foreign.count; index += 1) {
      projectMemory.write(root, {
        key: `foreign-${index}`,
        value: `FOREIGN-RECALL-LEAK-MARKER auth token ${'auth '.repeat(20)}`,
        sourceAgent: 'forge remember',
        scope: fixture.foreign.scope,
        tags: [],
      }, { store });
    }
    projectMemory.write(root, {
      key: fixture.projectLocal.memoryId,
      value: fixture.projectLocal.content,
      sourceAgent: 'forge remember',
      tags: [],
    }, { store });

    const result = await hooks.handler(
      ['memory-recall', '--harness', 'claude'],
      {},
      root,
      {
        railEnabled: () => true,
        readInput: () => JSON.stringify({
          session_id: 'holdout',
          prompt: fixture.projectLocal.prompt,
        }),
        search: (_root, query, limit, options) => projectMemory.searchRankedScored(
          root,
          query,
          limit,
          {
            ...options,
            store,
            gitCommonDir: commonDir,
            realpath: value => value,
            platform: 'win32',
          },
        ),
        loadSeen: () => [],
        saveSeen: () => {},
        appendShadow: () => {},
        recordRecallEvent: () => {},
      },
    );

    const context = JSON.parse(result.output).hookSpecificOutput.additionalContext;
    expect(projectId).not.toBe(fixture.foreign.scope);
    expect(context).toContain(fixture.projectLocal.content);
    expect(context).not.toContain('FOREIGN-RECALL-LEAK-MARKER');
  });

  test('keeps suggested authority separate and denies stale or superseded memories', async () => {
    beginProfileCase('authority-filtering');
    const root = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-authority-')));
    const commonDir = path.join(root, '.git');
    fs.mkdirSync(commonDir);
    const projectId = commonDir.replaceAll('\\', '/').toLowerCase();
    const store = createProfiledDriver(activeCaseLabel, {
      databasePath: path.join(root, 'kernel.sqlite'),
    });
    drivers.push(store);
    const records = [
      ['confirmed', fixture.authorityDenial.confirmed, 'forge remember', [], null, '2026-07-30T00:00:00.000Z'],
      ['suggested', fixture.authorityDenial.suggested, 'forge remember', ['trust:suggested'], null, '2026-07-30T00:00:00.000Z'],
      ['stale', fixture.authorityDenial.stale, 'forge insights', [], null, '2026-07-01T00:00:00.000Z'],
      ['old', fixture.authorityDenial.superseded, 'forge remember', [], null, '2026-07-30T00:00:00.000Z'],
      ['replacement', fixture.authorityDenial.replacement, 'forge remember', [], ['old'], '2026-07-30T00:00:00.000Z'],
    ];
    for (const [key, value, sourceAgent, tags, supersedes, timestamp] of records) {
      projectMemory.write(root, {
        key, value, sourceAgent, tags, timestamp, scope: projectId,
        ...(supersedes ? { supersedes } : {}),
      }, { store });
    }
    const result = await hooks.handler(['memory-recall', '--harness', 'claude'], {}, root, {
      railEnabled: () => true,
      readInput: () => JSON.stringify({
        session_id: 'authority',
        prompt: fixture.authorityDenial.prompt,
      }),
      search: (_root, query, limit, options) => projectMemory.searchRankedScored(root, query, limit, {
        ...options,
        now: '2026-07-30T12:00:00.000Z',
        store,
        gitCommonDir: commonDir,
        realpath: value => value,
        platform: 'win32',
      }),
      loadSeen: () => [],
      saveSeen: () => {},
      appendShadow: () => {},
      recordRecallEvent: () => {},
    });
    const context = JSON.parse(result.output).hookSpecificOutput.additionalContext;
    expect(context).toContain('Confirmed memory');
    expect(context).toContain('Suggested memory — verify before relying');
    expect(context).toContain(fixture.authorityDenial.confirmed);
    expect(context).toContain(fixture.authorityDenial.suggested);
    expect(context).toContain(fixture.authorityDenial.replacement);
    expect(context).not.toContain(fixture.authorityDenial.stale);
    expect(context).not.toContain(fixture.authorityDenial.superseded);
  });

  test('shadow evidence is content-free and disabled or failed Kernel paths fail open', async () => {
    beginProfileCase('privacy-fail-open');
    const root = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-privacy-')));
    const options = {
      readInput: () => JSON.stringify({
        session_id: fixture.privacy.sessionId,
        prompt: fixture.privacy.prompt,
      }),
      search: () => [{
        memory_id: 'private-memory-id',
        content: fixture.privacy.body,
        score: -3,
        trust_status: 'confirmed',
        provenance: { source_agent: 'forge remember', source_refs: ['C:/Users/private/note'] },
        updated_at: '2026-07-30T00:00:00.000Z',
      }],
      loadSeen: () => [],
      saveSeen: () => {},
      recordRecallEvent: () => {},
    };
    expect((await hooks.handler(['memory-recall', '--harness', 'claude'], {}, root, {
      ...options,
      railEnabled: () => false,
    })).output).toBe('');
    expect((await hooks.handler(['memory-recall', '--harness', 'claude'], {}, root, {
      ...options,
      railEnabled: () => true,
      search: () => { throw new Error('kernel unavailable'); },
    })).output).toBe('');
    const selected = await hooks.handler(['memory-recall', '--harness', 'claude'], {}, root, {
      ...options,
      railEnabled: () => true,
    });
    expect(selected.output).not.toBe('');
    const serialized = fs.readFileSync(
      path.join(root, '.forge', 'memory-recall', 'shadow.jsonl'),
      'utf8',
    );
    expect(serialized).not.toContain(fixture.privacy.prompt);
    expect(serialized).not.toContain(fixture.privacy.body);
    expect(serialized).not.toContain(fixture.privacy.sessionId);
    expect(serialized).not.toContain('private-memory-id');
    expect(serialized).not.toContain('C:/Users/private');
  });

  test('real locked SQLite prompt recall fails open below its deadline', async () => {
    beginProfileCase('locked-database');
    const root = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-lock-holdout-')));
    const commonDir = path.join(root, '.git');
    fs.mkdirSync(commonDir);
    const databasePath = path.join(root, 'kernel.sqlite');
    const locker = createProfiledDriver(activeCaseLabel, { databasePath });
    const reader = createProfiledDriver(activeCaseLabel, { databasePath });
    drivers.push(locker, reader);
    projectMemory.write(root, {
      key: 'locked',
      value: fixture.projectLocal.content,
      sourceAgent: 'forge remember',
      tags: [],
    }, { store: locker });
    await locker.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
    const startedAt = performance.now();
    const result = await hooks.handler(['memory-recall', '--harness', 'claude'], {}, root, {
      railEnabled: () => true,
      readInput: () => JSON.stringify({ session_id: 'lock', prompt: fixture.projectLocal.prompt }),
      search: (_root, query, limit, options) => projectMemory.searchRankedScored(root, query, limit, {
        ...options,
        store: reader,
        gitCommonDir: commonDir,
        realpath: value => value,
        platform: 'win32',
      }),
      loadSeen: () => [],
      appendShadow: () => {},
      recordRecallEvent: () => {},
    });
    const elapsedMs = performance.now() - startedAt;
    await locker.exec('ROLLBACK;');
    expect(result.output).toBe('');
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test('26 stronger seen rows are excluded before rank and an unseen local row survives', async () => {
    beginProfileCase('seen-row-filtering');
    const context = createRecallContext('forge-memory-seen-');
    const seenKeys = [];
    await context.store.exec('BEGIN;');
    try {
      for (let index = 0; index < fixture.seen.count; index += 1) {
        const key = `seen-cache-${index}`;
        seenKeys.push(key);
        writeMemory(context, {
          key,
          value: `cache eviction policy ${'cache '.repeat(20)}`,
        });
      }
      writeMemory(context, {
        key: fixture.seen.eligibleId,
        value: fixture.seen.eligibleContent,
      });
    } catch (error) {
      try {
        await context.store.exec('ROLLBACK;');
      } catch {
        // A rollback failure must not mask the original fixture error.
      }
      throw error;
    }
    await context.store.exec('COMMIT;');

    const output = additionalContext(await runAssembledRecall(context, {
      prompt: fixture.seen.prompt,
      seenKeys,
    }));
    expect(output).toContain(fixture.seen.eligibleContent);
    for (const key of seenKeys) expect(output).not.toContain(key);
  });

  test('foreign and suggested superseders cannot erase eligible confirmed memories', async () => {
    beginProfileCase('supersession-filtering');
    const context = createRecallContext('forge-memory-supersession-');
    writeMemory(context, {
      key: 'foreign-protected',
      value: fixture.supersession.foreignProtected,
    });
    writeMemory(context, {
      key: 'foreign-superseder',
      value: 'Foreign release rollback guard.',
      scope: fixture.foreign.scope,
      supersedes: ['foreign-protected'],
    });
    writeMemory(context, {
      key: 'confirmed-protected',
      value: fixture.supersession.confirmedProtected,
    });
    writeMemory(context, {
      key: 'suggested-superseder',
      value: 'Suggested release rollback replacement.',
      sourceAgent: 'forge insights',
      tags: ['trust:suggested'],
      supersedes: ['confirmed-protected'],
      timestamp: '2026-07-30T00:00:00.000Z',
    });

    const output = additionalContext(await runAssembledRecall(context, {
      prompt: fixture.supersession.prompt,
      now: '2026-07-30T12:00:00.000Z',
    }));
    expect(output).toContain(fixture.supersession.foreignProtected);
    expect(output).toContain(fixture.supersession.confirmedProtected);
    expect(output).not.toContain('Foreign release rollback guard.');
  });

  test('duplicate recall is excluded and an oversized first hit does not starve a fitting hit', async () => {
    beginProfileCase('packing-and-deduplication');
    const context = createRecallContext('forge-memory-packing-');
    writeMemory(context, {
      key: 'oversized-retry',
      value: `database retry policy ${'retry '.repeat(1_000)}`,
    });
    writeMemory(context, {
      key: 'fitting-retry',
      value: fixture.oversized.fitting,
    });
    const seen = [];
    const first = await runAssembledRecall(context, {
      prompt: fixture.oversized.prompt,
      tokenBudget: 100,
      saveSeen: (_root, _session, keys) => seen.push(...keys),
    });
    const firstContext = additionalContext(first);
    expect(firstContext).toContain(fixture.oversized.fitting);
    expect(firstContext).not.toContain('retry retry retry');
    expect(Math.ceil(firstContext.length / 4)).toBeLessThanOrEqual(100);

    const second = await runAssembledRecall(context, {
      prompt: fixture.oversized.prompt,
      tokenBudget: 100,
      seenKeys: seen,
    });
    expect(second.output).toBe('');
  });

  test('common-dir identity is deterministic and trust/type precedence survives the assembled path', async () => {
    beginProfileCase('common-dir-identity');
    const context = createRecallContext('forge-memory-identity-');
    const siblingRoot = trackRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-sibling-')));
    expect(projectMemory.resolveProjectId(context.root, {
      gitCommonDir: context.commonDir,
      realpath: value => value,
      platform: 'win32',
    })).toBe(projectMemory.resolveProjectId(siblingRoot, {
      gitCommonDir: context.commonDir,
      realpath: value => value,
      platform: 'win32',
    }));

    const entries = [
      {
        key: 'human-typed',
        value: fixture.precedence.humanTyped,
        tags: ['type:decision'],
      },
      {
        key: 'tagged-type',
        value: { category: 'gotcha', data: 'worker lease policy tagged' },
        sourceAgent: 'forge insights',
        tags: ['type:decision'],
      },
      {
        key: 'category-type',
        value: { category: 'gotcha', data: 'worker lease policy category' },
        sourceAgent: 'forge insights',
      },
      {
        key: 'machine-type',
        value: { data: 'worker lease policy machine' },
        sourceAgent: 'forge insights',
      },
      {
        key: 'explicit-confirmed',
        value: { data: fixture.precedence.explicitConfirmed },
        sourceAgent: 'forge insights',
        tags: ['trust:confirmed'],
      },
    ];
    for (const entry of entries) writeMemory(context, entry);
    const hits = projectMemory.searchRankedScored(
      siblingRoot,
      fixture.precedence.prompt,
      25,
      {
        store: context.store,
        gitCommonDir: context.commonDir,
        realpath: value => value,
        platform: 'win32',
        now: '2026-07-30T12:00:00.000Z',
      },
    );
    const byId = Object.fromEntries(hits.map(hit => [hit.memory_id, hit]));
    expect(byId['human-typed'].trust_status).toBe('confirmed');
    expect(byId['tagged-type'].type).toBe('decision');
    expect(byId['tagged-type'].trust_status).toBe('suggested');
    expect(byId['category-type'].type).toBe('gotcha');
    expect(byId['machine-type'].type).toBe('machine-record');
    expect(byId['explicit-confirmed'].trust_status).toBe('confirmed');

    const output = additionalContext(await runAssembledRecall(context, {
      root: siblingRoot,
      prompt: fixture.precedence.prompt,
      now: '2026-07-30T12:00:00.000Z',
    }));
    expect(output).toContain(fixture.precedence.humanTyped);
    expect(output).toContain(fixture.precedence.explicitConfirmed);
    expect(output).toContain('Confirmed memory');
    expect(output).toContain('Suggested memory');
  });

  test('assembled 1,000-row recall keeps 100-sample p95 within 250ms', async () => {
    beginProfileCase('performance-sampling');
    const context = createRecallContext('forge-memory-performance-');
    await context.store.exec('BEGIN;');
    try {
      for (let index = 0; index < fixture.performance.count; index += 1) {
        writeMemory(context, {
          key: `performance-${index}`,
          value: `routing cache policy record ${index}`,
          timestamp: '2026-07-30T00:00:00.000Z',
        });
      }
    } catch (error) {
      await context.store.exec('ROLLBACK;');
      throw error;
    }
    await context.store.exec('COMMIT;');
    const search = () => projectMemory.searchRankedScored(
      context.root,
      fixture.performance.prompt,
      25,
      {
        store: context.store,
        gitCommonDir: context.commonDir,
        realpath: value => value,
        platform: 'win32',
        now: '2026-07-30T12:00:00.000Z',
      },
    );
    for (let index = 0; index < 10; index += 1) search();
    const samples = [];
    for (let index = 0; index < fixture.performance.samples; index += 1) {
      const startedAt = performance.now();
      expect(search()).toHaveLength(25);
      samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    expect(p95).toBeLessThanOrEqual(fixture.performance.p95LimitMs);
  }, 20_000);

  test('harness matrix renders Claude JSON and fails open cleanly elsewhere', async () => {
    beginProfileCase('harness-matrix');
    const context = createRecallContext('forge-memory-harness-');
    writeMemory(context, {
      key: fixture.projectLocal.memoryId,
      value: fixture.projectLocal.content,
    });
    const claude = await runAssembledRecall(context, { harness: 'claude' });
    expect(claude.success).toBe(true);
    expect(additionalContext(claude)).toContain(fixture.projectLocal.content);

    for (const harness of ['codex', 'cursor', 'hermes']) {
      const result = await runAssembledRecall(context, { harness });
      expect(result.success).toBe(true);
      expect(result.output).toBe('');
      expect(typeof result.reason).toBe('string');
    }
  });
});
