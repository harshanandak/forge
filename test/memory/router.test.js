'use strict';

const { afterEach, describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const router = require('../../lib/memory/router');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

const tempDirs = [];
const drivers = [];

function makeProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-router-'));
  tempDirs.push(dir);
  return dir;
}

// A real kernel driver over an explicit DB path inside the temp project — hermetic (no git
// rev-parse) and closed before the temp dir is removed so Windows releases the WAL lock.
function makeStore(projectRoot) {
  const driver = createBuiltinSQLiteDriver({ databasePath: path.join(projectRoot, 'kernel.sqlite') });
  drivers.push(driver);
  return driver;
}

function writeConfig(projectRoot, yaml) {
  const dir = path.join(projectRoot, '.forge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), yaml, 'utf8');
}

function writeLegacyJsonl(projectRoot, entries) {
  const dir = path.join(projectRoot, '.forge', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'notes.jsonl'),
    `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );
}

afterEach(() => {
  while (drivers.length > 0) {
    try {
      drivers.pop().close();
    } catch {
      // best-effort close
    }
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('memory-router: backend resolution', () => {
  test('defaults to local when no config, env, or deps signal is present', () => {
    const projectRoot = makeProjectRoot();
    expect(router.resolveMemoryBackend({ projectRoot, env: {} })).toBe('local');
  });

  test('MEMORY_BACKENDS enumerates only the public backends (local, graphiti)', () => {
    expect(router.MEMORY_BACKENDS).toEqual(['local', 'graphiti']);
    expect(router.DEFAULT_MEMORY_BACKEND).toBe('local');
  });

  test('reads memory.backend from .forge/config.yaml', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(projectRoot, 'memory:\n  backend: graphiti\n');
    expect(router.resolveMemoryBackend({ projectRoot, env: {} })).toBe('graphiti');
  });

  test('kernel is NOT a public backend — it falls back to local with a warning', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(projectRoot, 'memory:\n  backend: kernel\n');
    const warnings = [];
    expect(
      router.resolveMemoryBackend({ projectRoot, env: {}, warn: m => warnings.push(m) }),
    ).toBe('local');
    expect(warnings.length).toBe(1);
  });

  test('env FORGE_MEMORY_BACKEND overrides config', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(projectRoot, 'memory:\n  backend: local\n');
    expect(
      router.resolveMemoryBackend({ projectRoot, env: { FORGE_MEMORY_BACKEND: 'graphiti' } }),
    ).toBe('graphiti');
  });

  test('deps.memoryBackend has highest precedence', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(projectRoot, 'memory:\n  backend: graphiti\n');
    expect(
      router.resolveMemoryBackend({
        projectRoot,
        env: { FORGE_MEMORY_BACKEND: 'graphiti' },
        deps: { memoryBackend: 'local' },
      }),
    ).toBe('local');
  });

  test('unknown backend value warns and falls back to local (never breaks commands)', () => {
    const projectRoot = makeProjectRoot();
    const warnings = [];
    const backend = router.resolveMemoryBackend({
      projectRoot,
      env: { FORGE_MEMORY_BACKEND: 'redis' },
      warn: msg => warnings.push(msg),
    });
    expect(backend).toBe('local');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('redis');
  });

  test('malformed config file does not throw; falls back to local', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(projectRoot, ':::not: valid: yaml:::\n');
    expect(router.resolveMemoryBackend({ projectRoot, env: {} })).toBe('local');
  });
});

describe('memory-router: config validation', () => {
  test('local backend needs no extra configuration', () => {
    const projectRoot = makeProjectRoot();
    expect(() => router.assertMemoryConfigValid({ projectRoot, env: {} })).not.toThrow();
  });

  test('graphiti selected but not configured throws a clear error', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(projectRoot, 'memory:\n  backend: graphiti\n');
    expect(() => router.assertMemoryConfigValid({ projectRoot, env: {} })).toThrow(/graphiti/i);
  });

  test('graphiti fully configured validates', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(
      projectRoot,
      'memory:\n  backend: graphiti\n  graphiti:\n    mcpServerPath: /opt/graphiti/mcp_server\n',
    );
    const result = router.assertMemoryConfigValid({ projectRoot, env: {} });
    expect(result.backend).toBe('graphiti');
    expect(result.graphiti.mcpServerPath).toBe('/opt/graphiti/mcp_server');
  });
});

describe('memory-router: kernel-backed dispatch (local default)', () => {
  test('append persists to kernel_memories and round-trips through recall', () => {
    const projectRoot = makeProjectRoot();
    const store = makeStore(projectRoot);

    const entry = router.append(projectRoot, 'Run /plan before /dev', { tags: ['workflow'], store });
    expect(entry.note).toBe('Run /plan before /dev');
    expect(entry.tags).toEqual(['workflow']);
    expect(typeof entry.id).toBe('string');

    const { notes } = router.recall(projectRoot, {}, { store });
    expect(notes.map(note => note.note)).toContain('Run /plan before /dev');
    expect(notes.find(note => note.note === 'Run /plan before /dev').tags).toEqual(['workflow']);
  });

  test('recall with a query does token-AND BM25 matching (order-independent)', () => {
    const projectRoot = makeProjectRoot();
    const store = makeStore(projectRoot);
    router.append(projectRoot, 'auth bug in the login flow', { store });
    router.append(projectRoot, 'export command bug', { store });
    router.append(projectRoot, 'auth token refresh', { store });

    const { notes } = router.recall(projectRoot, { query: 'bug auth' }, { store });
    expect(notes.map(note => note.note)).toEqual(['auth bug in the login flow']);
  });

  test('recall with no query caps to newest-N and reports the true total (no bare dump)', () => {
    const projectRoot = makeProjectRoot();
    const store = makeStore(projectRoot);
    router.append(projectRoot, 'note one', { store });
    router.append(projectRoot, 'note two', { store });
    router.append(projectRoot, 'note three', { store });

    const result = router.recall(projectRoot, { limit: 2 }, { store });
    expect(result.notes).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.capped).toBe(true);
  });

  test('recall returns no notes when a query matches nothing', () => {
    const projectRoot = makeProjectRoot();
    const store = makeStore(projectRoot);
    router.append(projectRoot, 'something', { store });
    expect(router.recall(projectRoot, { query: 'nonexistent' }, { store }).notes).toEqual([]);
  });
});

describe('memory-router: graphiti backend (experimental — local kernel is always the floor)', () => {
  const GRAPHITI_CONFIG = 'memory:\n  backend: graphiti\n  graphiti:\n    mcpServerPath: /opt/graphiti/mcp_server\n';

  test('graphiti writes the local kernel floor for CLI writes (never breaks remember)', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(projectRoot, GRAPHITI_CONFIG);
    const store = makeStore(projectRoot);

    const entry = router.append(projectRoot, 'graph note', { store });
    expect(entry.note).toBe('graph note');
    expect(router.recall(projectRoot, {}, { store }).total).toBe(1);
  });

  test('graphiti append fires the emitter best-effort (fire-and-forget)', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(projectRoot, GRAPHITI_CONFIG);
    const store = makeStore(projectRoot);

    let received = null;
    router.append(projectRoot, 'graph note', {
      store,
      graphitiEmitter: { emit: e => { received = e; } },
    });
    expect(received).not.toBeNull();
    expect(received.note).toBe('graph note');
  });

  test('a throwing/rejecting emitter never breaks remember (hard fallback to the kernel floor)', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(projectRoot, GRAPHITI_CONFIG);
    const store = makeStore(projectRoot);

    const throwing = { emit: () => { throw new Error('sidecar down'); } };
    const rejecting = { emit: () => Promise.reject(new Error('timeout')) };
    expect(() => router.append(projectRoot, 'note a', { store, graphitiEmitter: throwing })).not.toThrow();
    expect(() => router.append(projectRoot, 'note b', { store, graphitiEmitter: rejecting })).not.toThrow();
    expect(router.recall(projectRoot, {}, { store }).total).toBe(2);
  });
});

describe('memory-router: one-time JSONL import onto the kernel', () => {
  test('imports a legacy notes.jsonl on first use and renames it so it never re-imports', () => {
    const projectRoot = makeProjectRoot();
    const store = makeStore(projectRoot);
    writeLegacyJsonl(projectRoot, [
      { id: 'legacy-1', note: 'legacy alpha note', timestamp: '2026-01-01T00:00:00.000Z', tags: ['old'] },
      { id: 'legacy-2', note: 'legacy beta note', timestamp: '2026-01-02T00:00:00.000Z', tags: [] },
    ]);

    const { notes, total } = router.recall(projectRoot, {}, { store });
    expect(total).toBe(2);
    expect(notes.map(note => note.note).sort()).toEqual(['legacy alpha note', 'legacy beta note']);

    // The JSONL file is renamed so it is never read or written again.
    expect(fs.existsSync(path.join(projectRoot, '.forge', 'memory', 'notes.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.forge', 'memory', 'notes.jsonl.migrated'))).toBe(true);
  });

  test('the import is idempotent — a second pass does not duplicate rows', () => {
    const projectRoot = makeProjectRoot();
    const store = makeStore(projectRoot);
    writeLegacyJsonl(projectRoot, [
      { id: 'legacy-1', note: 'only note', timestamp: '2026-01-01T00:00:00.000Z', tags: [] },
    ]);

    router.migrateJsonlNotesOnce(projectRoot, { store });
    // Re-writing the same file (same ids) and re-importing upserts, never duplicates.
    writeLegacyJsonl(projectRoot, [
      { id: 'legacy-1', note: 'only note', timestamp: '2026-01-01T00:00:00.000Z', tags: [] },
    ]);
    router.migrateJsonlNotesOnce(projectRoot, { store });

    expect(router.recall(projectRoot, {}, { store }).total).toBe(1);
  });

  test('tolerates malformed and empty JSONL lines (skips them, imports the good ones)', () => {
    const projectRoot = makeProjectRoot();
    const store = makeStore(projectRoot);
    const dir = path.join(projectRoot, '.forge', 'memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'notes.jsonl'),
      [
        '',
        '{ not valid json',
        JSON.stringify({ id: 'good-1', note: 'a good note', timestamp: '2026-01-01T00:00:00.000Z', tags: [] }),
        '   ',
        '{"note": ""}',
        JSON.stringify({ id: 'good-2', note: 'another good note', timestamp: '2026-01-02T00:00:00.000Z', tags: [] }),
      ].join('\n'),
      'utf8',
    );

    const { notes, total } = router.recall(projectRoot, {}, { store });
    expect(total).toBe(2);
    expect(notes.map(note => note.note).sort()).toEqual(['a good note', 'another good note']);
  });

  test('an id-less legacy record dedupes by content across re-imports (no double-insert)', () => {
    const projectRoot = makeProjectRoot();
    const store = makeStore(projectRoot);
    // No `id` field — a re-run must key off content, not a fresh random UUID.
    const record = { note: 'note without an id', timestamp: '2026-01-01T00:00:00.000Z', tags: ['x'] };

    writeLegacyJsonl(projectRoot, [record]);
    router.migrateJsonlNotesOnce(projectRoot, { store });
    writeLegacyJsonl(projectRoot, [record]);
    router.migrateJsonlNotesOnce(projectRoot, { store });

    expect(router.recall(projectRoot, {}, { store }).total).toBe(1);
  });
});
