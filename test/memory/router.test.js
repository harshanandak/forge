'use strict';

const { afterEach, describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const router = require('../../lib/memory/router');
const memoryStore = require('../../lib/memory-store');

const tempDirs = [];

function makeProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-router-'));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(projectRoot, yaml) {
  const dir = path.join(projectRoot, '.forge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), yaml, 'utf8');
}

afterEach(() => {
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

describe('memory-router: local dispatch is byte-identical to memory-store', () => {
  test('append routes to the local JSONL store by default', () => {
    const projectRoot = makeProjectRoot();
    const entry = router.append(projectRoot, 'Run /plan before /dev', { tags: ['workflow'] });
    expect(entry.note).toBe('Run /plan before /dev');
    expect(entry.tags).toEqual(['workflow']);

    // Written to the exact same location the local store uses.
    const storePath = memoryStore.defaultStorePath(projectRoot);
    expect(fs.existsSync(storePath)).toBe(true);
    expect(memoryStore.list(projectRoot)).toHaveLength(1);
  });

  test('list and search route to the local store by default', () => {
    const projectRoot = makeProjectRoot();
    router.append(projectRoot, 'alpha note', { tags: ['x'] });
    router.append(projectRoot, 'beta note', { tags: ['y'] });

    expect(router.list(projectRoot).map(e => e.note)).toEqual(['beta note', 'alpha note']);
    expect(router.search(projectRoot, 'alpha')).toHaveLength(1);
  });

  test('graphiti backend still writes the local floor for CLI writes (never breaks remember)', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(
      projectRoot,
      'memory:\n  backend: graphiti\n  graphiti:\n    mcpServerPath: /opt/graphiti/mcp_server\n',
    );
    const entry = router.append(projectRoot, 'graph note');
    expect(entry.note).toBe('graph note');
    // The local JSONL store remains the guaranteed floor.
    expect(memoryStore.list(projectRoot)).toHaveLength(1);
  });

  test('graphiti append fires the emitter best-effort (fire-and-forget)', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(
      projectRoot,
      'memory:\n  backend: graphiti\n  graphiti:\n    mcpServerPath: /opt/graphiti/mcp_server\n',
    );
    let received = null;
    router.append(projectRoot, 'graph note', {
      graphitiEmitter: { emit: e => { received = e; } },
    });
    expect(received).not.toBeNull();
    expect(received.note).toBe('graph note');
  });

  test('a throwing/rejecting emitter never breaks remember (hard fallback to local)', () => {
    const projectRoot = makeProjectRoot();
    writeConfig(
      projectRoot,
      'memory:\n  backend: graphiti\n  graphiti:\n    mcpServerPath: /opt/graphiti/mcp_server\n',
    );
    const throwing = { emit: () => { throw new Error('sidecar down'); } };
    const rejecting = { emit: () => Promise.reject(new Error('timeout')) };
    // Neither must throw; both must still persist to the local floor.
    expect(() => router.append(projectRoot, 'note a', { graphitiEmitter: throwing })).not.toThrow();
    expect(() => router.append(projectRoot, 'note b', { graphitiEmitter: rejecting })).not.toThrow();
    expect(memoryStore.list(projectRoot)).toHaveLength(2);
  });
});
