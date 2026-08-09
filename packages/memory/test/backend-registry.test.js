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
      backend: 'graphiti', code: 'MEMORY_BACKEND_FAILED',
    }]);
  });

  test('fails closed on async adapters without leaking an unhandled rejection', async () => {
    const unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      const registry = createMemoryBackendRegistry({ local: backend() });
      registry.register('async-sidecar', backend({
        recall: async () => { throw new Error('remote secret'); },
      }));
      registry.select('async-sidecar');

      const result = registry.recall();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(result.value).toEqual([{ id: 'local-1', value: 'local' }]);
      expect(result.receipt.status).toBe('degraded');
      expect(result.receipt.errors).toEqual([{
        backend: 'async-sidecar', code: 'MEMORY_BACKEND_ASYNC_UNSUPPORTED',
      }]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('fails closed when the mandatory local floor returns a promise', async () => {
    const unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      const registry = createMemoryBackendRegistry({
        local: backend({ add: async () => { throw new Error('local async failure'); } }),
      });
      expect(() => registry.add('note')).toThrow(/synchronous/i);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('isolates and freezes enricher input so it cannot mutate the local floor', () => {
    const input = { note: 'original', nested: { tags: ['safe'] } };
    const registry = createMemoryBackendRegistry({
      local: backend({ add: value => value }),
    });
    let enricherInput;
    registry.register('mutator', backend({
      add: value => {
        enricherInput = value;
        expect(() => { value.note = 'mutated'; }).toThrow();
        expect(() => { value.nested.tags.push('mutated'); }).toThrow();
        return null;
      },
    }));
    registry.select('mutator');

    const result = registry.add(input);
    expect(result.value).toEqual({ note: 'original', nested: { tags: ['safe'] } });
    expect(result.value).not.toBe(input);
    expect(enricherInput).not.toBe(input);
    expect(input).toEqual({ note: 'original', nested: { tags: ['safe'] } });
  });

  test('never includes backend exception text in a receipt', () => {
    const registry = createMemoryBackendRegistry({ local: backend() });
    registry.register('remote', backend({
      add: () => { throw new Error('token=sk_live_secret C:/Users/alice/private'); },
    }));
    registry.select('remote');

    const serialized = JSON.stringify(registry.add('note').receipt);
    expect(serialized).not.toContain('sk_live_secret');
    expect(serialized).not.toContain('C:/Users');
    expect(serialized.length).toBeLessThan(1024);
  });

  test('does not inspect properties on an untrusted thrown value', () => {
    const registry = createMemoryBackendRegistry({ local: backend() });
    const hostileError = Object.defineProperty({}, 'code', {
      get() { throw new Error('getter must not run'); },
    });
    registry.register('remote', backend({ add: () => { throw hostileError; } }));
    registry.select('remote');

    expect(registry.add('note').receipt.errors).toEqual([{
      backend: 'remote', code: 'MEMORY_BACKEND_FAILED',
    }]);
  });

  test('rejects duplicate custom backend registration until explicitly unregistered', () => {
    const registry = createMemoryBackendRegistry({ local: backend() });
    registry.register('custom', backend());
    expect(() => registry.register('custom', backend())).toThrow(/already registered/i);
    registry.unregister('custom');
    expect(() => registry.register('custom', backend())).not.toThrow();
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
