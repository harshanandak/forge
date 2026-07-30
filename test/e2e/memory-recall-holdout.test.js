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

afterEach(() => {
  while (drivers.length) drivers.pop().close();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('project-local memory recall holdout', () => {
  test('foreign rows cannot crowd an unseen local memory out of additionalContext', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-holdout-'));
    roots.push(root);
    const commonDir = path.join(root, '.git');
    fs.mkdirSync(commonDir);
    const projectId = commonDir.replaceAll('\\', '/').toLowerCase();
    const store = createBuiltinSQLiteDriver({ databasePath: path.join(root, 'kernel.sqlite') });
    drivers.push(store);

    for (let index = 0; index < fixture.foreign.count; index += 1) {
      projectMemory.write(root, {
        key: `foreign-${index}`,
        value: `auth token ${'auth '.repeat(20)}`,
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
    expect(context).not.toContain('foreign-');
  });

  test('keeps suggested authority separate and denies stale or superseded memories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-authority-'));
    roots.push(root);
    const commonDir = path.join(root, '.git');
    fs.mkdirSync(commonDir);
    const projectId = commonDir.replaceAll('\\', '/').toLowerCase();
    const store = createBuiltinSQLiteDriver({ databasePath: path.join(root, 'kernel.sqlite') });
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-privacy-'));
    roots.push(root);
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-lock-holdout-'));
    roots.push(root);
    const commonDir = path.join(root, '.git');
    fs.mkdirSync(commonDir);
    const databasePath = path.join(root, 'kernel.sqlite');
    const locker = createBuiltinSQLiteDriver({ databasePath });
    const reader = createBuiltinSQLiteDriver({ databasePath });
    drivers.push(locker, reader);
    projectMemory.write(root, {
      key: 'locked',
      value: fixture.projectLocal.content,
      sourceAgent: 'forge remember',
      tags: [],
    }, { store: locker });
    reader.countMemories();
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
});
