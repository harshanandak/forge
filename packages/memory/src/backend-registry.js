'use strict';

const BACKEND_METHODS = Object.freeze(['add', 'recall', 'search', 'capture', 'digest']);
const RECEIPT_SCHEMA_ID = 'forge.memory.operation-receipt.v1';
const RECEIPT_SCHEMA_VERSION = 1;

function assertBackendName(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw new TypeError('memory backend name must use lowercase letters, numbers, and hyphens');
  }
}

function assertBackend(adapter, name = 'memory') {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new TypeError(`${name} memory backend must be an object`);
  }
  for (const method of BACKEND_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`${name} memory backend must implement ${method}()`);
    }
  }
}

function errorRecord(backend, error) {
  return {
    backend,
    code: 'MEMORY_BACKEND_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}

function identity(value) {
  if (value && typeof value === 'object') {
    if (typeof value.id === 'string') return `id:${value.id}`;
    if (typeof value.key === 'string') return `key:${value.key}`;
  }
  return `value:${JSON.stringify(value)}`;
}

function enrichLocalValue(localValue, enrichedValue, operation) {
  if (!['recall', 'search', 'digest'].includes(operation)) return localValue;
  if (!Array.isArray(localValue) || !Array.isArray(enrichedValue)) return localValue;
  const seen = new Set(localValue.map(identity));
  return [...localValue, ...enrichedValue.filter(item => {
    const key = identity(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
}

function createMemoryBackendRegistry({ local, selected = 'local' } = {}) {
  assertBackend(local, 'local');
  const adapters = new Map([['local', local]]);
  let selectedBackend = 'local';

  function register(name, adapter) {
    assertBackendName(name);
    if (name === 'local') throw new Error('the local memory floor cannot be replaced');
    assertBackend(adapter, name);
    adapters.set(name, adapter);
    return api;
  }

  function unregister(name) {
    if (name === 'local') throw new Error('the local memory floor cannot be removed');
    adapters.delete(name);
    if (selectedBackend === name) selectedBackend = 'local';
    return api;
  }

  function select(name) {
    assertBackendName(name);
    if (!adapters.has(name)) throw new Error(`memory backend "${name}" is not registered`);
    selectedBackend = name;
    return api;
  }

  function execute(operation, args) {
    const localValue = adapters.get('local')[operation](...args);
    const backends = [{ backend: 'local', status: 'ok' }];
    const errors = [];
    let value = localValue;

    if (selectedBackend !== 'local') {
      try {
        const enrichedValue = adapters.get(selectedBackend)[operation](...args);
        value = enrichLocalValue(localValue, enrichedValue, operation);
        backends.push({ backend: selectedBackend, status: 'ok' });
      } catch (error) {
        backends.push({ backend: selectedBackend, status: 'failed' });
        errors.push(errorRecord(selectedBackend, error));
      }
    }

    return {
      value,
      receipt: {
        schema_id: RECEIPT_SCHEMA_ID,
        schema_version: RECEIPT_SCHEMA_VERSION,
        operation,
        selected_backend: selectedBackend,
        local_floor: 'local',
        status: errors.length === 0 ? 'ok' : 'degraded',
        capabilities: [...BACKEND_METHODS].sort(),
        backends,
        errors,
      },
    };
  }

  const api = {
    register,
    unregister,
    select,
    selected: () => selectedBackend,
    names: () => [...adapters.keys()].sort((a, b) => (a === 'local' ? -1 : b === 'local' ? 1 : a.localeCompare(b))),
  };
  for (const operation of BACKEND_METHODS) {
    api[operation] = (...args) => execute(operation, args);
  }
  select(selected);
  return Object.freeze(api);
}

module.exports = {
  BACKEND_METHODS,
  RECEIPT_SCHEMA_ID,
  RECEIPT_SCHEMA_VERSION,
  assertBackend,
  createMemoryBackendRegistry,
};
