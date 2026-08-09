'use strict';

const { describe, expect, test } = require('bun:test');
const { BACKEND_METHODS, createMemoryBackendRegistry } = require('..');

function backend(overrides = {}) {
  return {
    add: value => ({ id: 'local-1', value }),
    recall: () => [{ id: 'local-1', value: 'local' }],
    search: () => [{ id: 'local-1', value: 'local' }],
    capture: value => ({ id: 'capture-1', value }),
    digest: () => ({ count: 1 }),
    ...overrides,
  };
}

describe('@forge/memory backend registry', () => {
  test('requires the complete stable MemoryBackend surface and defaults to local', () => {
    expect(BACKEND_METHODS).toEqual(['add', 'recall', 'search', 'capture', 'digest']);
    const registry = createMemoryBackendRegistry({ local: backend() });
    expect(registry.names()).toEqual(['local']);
    expect(registry.selected()).toBe('local');
    expect(registry.add('note').value).toEqual({ id: 'local-1', value: 'note' });
  });

  test('rejects incomplete adapters and unknown enabled selections', () => {
    expect(() => createMemoryBackendRegistry({ local: { add() {} } })).toThrow(/recall/);
    const registry = createMemoryBackendRegistry({ local: backend() });
    expect(() => registry.select('missing')).toThrow(/not registered/);
  });

  test('runs the local floor first and preserves its write when an enricher fails', () => {
    const calls = [];
    const registry = createMemoryBackendRegistry({
      local: backend({ add: value => { calls.push('local'); return { id: 'local', value }; } }),
    });
    registry.register('graphiti', backend({
      add: () => { calls.push('graphiti'); throw new Error('sidecar down'); },
    }));
    registry.select('graphiti');
    const result = registry.add('durable');
    expect(calls).toEqual(['local', 'graphiti']);
    expect(result.value).toEqual({ id: 'local', value: 'durable' });
    expect(result.receipt.status).toBe('degraded');
    expect(result.receipt.errors).toEqual([{
      backend: 'graphiti', code: 'MEMORY_BACKEND_FAILED', message: 'sidecar down',
    }]);
  });

  test('never removes local recall results when enrichment fails', () => {
    const registry = createMemoryBackendRegistry({ local: backend() });
    registry.register('graphiti', backend({ recall: () => { throw new Error('offline'); } }));
    registry.select('graphiti');
    const result = registry.recall({ query: 'local' });
    expect(result.value).toEqual([{ id: 'local-1', value: 'local' }]);
    expect(result.receipt.status).toBe('degraded');
  });

  test('emits a deterministic versioned receipt with selected backend and capabilities', () => {
    const registry = createMemoryBackendRegistry({ local: backend() });
    registry.register('zeta', backend());
    registry.select('zeta');
    const first = registry.digest();
    const second = registry.digest();
    expect(first.receipt).toEqual(second.receipt);
    expect(first.receipt).toEqual({
      schema_id: 'forge.memory.operation-receipt.v1', schema_version: 1,
      operation: 'digest', selected_backend: 'zeta', local_floor: 'local', status: 'ok',
      capabilities: ['add', 'capture', 'digest', 'recall', 'search'],
      backends: [{ backend: 'local', status: 'ok' }, { backend: 'zeta', status: 'ok' }],
      errors: [],
    });
  });
});
