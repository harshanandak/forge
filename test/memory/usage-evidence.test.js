'use strict';

const { describe, expect, test } = require('bun:test');
const { Database } = require('bun:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  appendUsageEvidence,
  installUsageEvidenceSchema,
  rebuildUsageProjection,
  UsageIdempotencyConflictError,
} = require('../../lib/memory/usage-evidence');

function createStore({ databasePath = ':memory:', failProjectionWrite = false } = {}) {
  const database = new Database(databasePath);
  return {
    exec(sql) { database.exec(sql); },
    run(sql, params = []) {
      if (failProjectionWrite && sql.includes('INSERT INTO memory_usage_projection')) {
        throw new Error('simulated projection crash');
      }
      return database.query(sql).run(...params);
    },
    all(sql, params = []) { return database.query(sql).all(...params); },
    one(sql, params = []) { return database.query(sql).get(...params); },
    transaction(callback) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = callback();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    close() { database.close(); },
  };
}

function event(overrides = {}) {
  return {
    event_id: 'event-1',
    memory_id: 'memory-1',
    scope: 'project-7f2d',
    use_kind: 'cli-recall',
    consumer_id: 'session-1',
    selection_digest: 'a'.repeat(64),
    observed_at: '2026-08-10T00:00:00.000Z',
    idempotency_key: 'selection-1',
    ...overrides,
  };
}

function withTransactionFailures(store, codes) {
  let attempts = 0;
  return {
    ...store,
    transaction(callback) {
      const code = codes[attempts];
      attempts += 1;
      if (code) {
        const error = new Error(`simulated ${code}`);
        error.code = code;
        throw error;
      }
      return store.transaction(callback);
    },
    attempts() { return attempts; },
  };
}

describe('memory usage evidence', () => {
  test('records only bounded opaque fields and derives usage projection atomically', () => {
    const store = createStore();
    try {
      installUsageEvidenceSchema(store);
      expect(appendUsageEvidence(store, event({
        query: 'never persisted', prompt: 'never persisted', note: 'never persisted', secret: 'never persisted',
      }))).toMatchObject({ appended: true, use_count: 1 });
      expect(store.all('SELECT * FROM memory_usage_events')).toEqual([event()]);
      expect(store.one('SELECT scope, memory_id, last_used_at, use_count FROM memory_usage_projection'))
        .toEqual({
          scope: 'project-7f2d',
          memory_id: 'memory-1',
          last_used_at: '2026-08-10T00:00:00.000Z',
          use_count: 1,
        });
    } finally {
      store.close();
    }
  });

  test('same retry is a no-op, divergent reuse conflicts, and later use advances last_used_at', () => {
    const store = createStore();
    try {
      installUsageEvidenceSchema(store);
      appendUsageEvidence(store, event());
      expect(appendUsageEvidence(store, event())).toMatchObject({ appended: false, use_count: 1 });
      expect(() => appendUsageEvidence(store, event({ memory_id: 'other-memory' })))
        .toThrow(UsageIdempotencyConflictError);
      appendUsageEvidence(store, event({
        event_id: 'event-2',
        idempotency_key: 'selection-2',
        observed_at: '2026-08-11T00:00:00.000Z',
      }));
      expect(store.one('SELECT last_used_at, use_count FROM memory_usage_projection'))
        .toEqual({ last_used_at: '2026-08-11T00:00:00.000Z', use_count: 2 });
    } finally {
      store.close();
    }
  });

  test('rejects a scope conflict for a globally unique memory id', () => {
    const store = createStore();
    try {
      installUsageEvidenceSchema(store);
      appendUsageEvidence(store, event());
      expect(() => appendUsageEvidence(store, event({
        event_id: 'event-2',
        idempotency_key: 'selection-2',
        scope: 'project-other',
      }))).toThrow(/scope/i);
      expect(store.all('SELECT scope, memory_id, use_count FROM memory_usage_projection'))
        .toEqual([{ scope: 'project-7f2d', memory_id: 'memory-1', use_count: 1 }]);
      expect(store.all('SELECT event_id FROM memory_usage_events')).toEqual([{ event_id: 'event-1' }]);
    } finally {
      store.close();
    }
  });

  test('rejects a cross-scope append from authoritative events when the projection is missing', () => {
    const store = createStore();
    try {
      installUsageEvidenceSchema(store);
      appendUsageEvidence(store, event());
      store.exec('DELETE FROM memory_usage_projection');
      expect(() => appendUsageEvidence(store, event({
        event_id: 'event-2',
        idempotency_key: 'selection-2',
        scope: 'project-other',
      }))).toThrow(/scope/i);
      expect(store.all('SELECT event_id, scope FROM memory_usage_events'))
        .toEqual([{ event_id: 'event-1', scope: 'project-7f2d' }]);
    } finally {
      store.close();
    }
  });

  test('rebuild restores projection from append-only events without fabricating historical use', () => {
    const store = createStore();
    try {
      installUsageEvidenceSchema(store);
      appendUsageEvidence(store, event());
      appendUsageEvidence(store, event({
        event_id: 'event-2',
        idempotency_key: 'selection-2',
        observed_at: '2026-08-11T00:00:00.000Z',
      }));
      store.exec('DELETE FROM memory_usage_projection');
      expect(rebuildUsageProjection(store)).toEqual({ projections: 1 });
      expect(store.one('SELECT last_used_at, use_count FROM memory_usage_projection'))
        .toEqual({ last_used_at: '2026-08-11T00:00:00.000Z', use_count: 2 });
    } finally {
      store.close();
    }
  });

  test('projection failure rolls back the event, and the additive schema carries required indexes', () => {
    const store = createStore({ failProjectionWrite: true });
    try {
      installUsageEvidenceSchema(store);
      expect(() => appendUsageEvidence(store, event())).toThrow('simulated projection crash');
      expect(store.all('SELECT * FROM memory_usage_events')).toEqual([]);
      expect(store.all("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name"))
        .toEqual(expect.arrayContaining([
          { name: 'idx_memory_usage_events_memory_observed' },
          { name: 'idx_memory_usage_projection_scope_last_used_memory' },
          { name: 'sqlite_autoindex_memory_usage_events_2' },
        ]));
      expect(store.all('PRAGMA table_info(memory_usage_events)')
        .find(column => column.name === 'event_id')).toMatchObject({ notnull: 1, pk: 1 });
      expect(store.all('PRAGMA table_info(memory_usage_projection)')
        .find(column => column.name === 'memory_id')).toMatchObject({ notnull: 1, pk: 1 });
    } finally {
      store.close();
    }
  });

  test('a retry through a separate SQLite connection still counts the surfaced selection once', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-usage-evidence-'));
    const databasePath = path.join(directory, 'kernel.sqlite');
    const first = createStore({ databasePath });
    const second = createStore({ databasePath });
    try {
      installUsageEvidenceSchema(first);
      expect(appendUsageEvidence(first, event())).toMatchObject({ appended: true, use_count: 1 });
      expect(appendUsageEvidence(second, event())).toMatchObject({ appended: false, use_count: 1 });
      expect(second.one('SELECT use_count FROM memory_usage_projection')).toEqual({ use_count: 1 });
    } finally {
      first.close();
      second.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each(['SQLITE_BUSY', 'SQLITE_LOCKED'])(
    'retries one transient %s transaction contention failure without sleeping',
    code => {
      const baseStore = createStore();
      const store = withTransactionFailures(baseStore, [code]);
      try {
        installUsageEvidenceSchema(store);
        expect(appendUsageEvidence(store, event())).toMatchObject({ appended: true, use_count: 1 });
        expect(store.attempts()).toBe(2);
      } finally {
        store.close();
      }
    },
  );

  test('propagates a second contention failure after exactly one bounded retry', () => {
    const baseStore = createStore();
    const store = withTransactionFailures(baseStore, ['SQLITE_BUSY', 'SQLITE_BUSY']);
    try {
      installUsageEvidenceSchema(store);
      expect(() => appendUsageEvidence(store, event())).toThrow('simulated SQLITE_BUSY');
      expect(store.attempts()).toBe(2);
      expect(store.all('SELECT * FROM memory_usage_events')).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('rebuild retries one transient contention failure and no more', () => {
    const baseStore = createStore();
    try {
      installUsageEvidenceSchema(baseStore);
      appendUsageEvidence(baseStore, event());
      baseStore.exec('DELETE FROM memory_usage_projection');

      const recovered = withTransactionFailures(baseStore, ['SQLITE_LOCKED']);
      expect(rebuildUsageProjection(recovered)).toEqual({ projections: 1 });
      expect(recovered.attempts()).toBe(2);

      baseStore.exec('DELETE FROM memory_usage_projection');
      const blocked = withTransactionFailures(baseStore, ['SQLITE_BUSY', 'SQLITE_BUSY']);
      expect(() => rebuildUsageProjection(blocked)).toThrow('simulated SQLITE_BUSY');
      expect(blocked.attempts()).toBe(2);
    } finally {
      baseStore.close();
    }
  });

  test('rejects inherited and accessor evidence without invoking getters', () => {
    const store = createStore();
    let getterCalls = 0;
    const inherited = Object.create(event());
    const accessor = event();
    Object.defineProperty(accessor, 'event_id', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'event-accessor';
      },
    });
    try {
      installUsageEvidenceSchema(store);
      expect(() => appendUsageEvidence(store, inherited)).toThrow(/own data property/i);
      expect(() => appendUsageEvidence(store, accessor)).toThrow(/own data property/i);
      expect(getterCalls).toBe(0);
      expect(store.all('SELECT * FROM memory_usage_events')).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('rejects raw path-like identifiers and unsupported use kinds before persistence', () => {
    const store = createStore();
    try {
      installUsageEvidenceSchema(store);
      expect(() => appendUsageEvidence(store, event({ consumer_id: 'C:\\Users\\private' })))
        .toThrow(/opaque/i);
      expect(() => appendUsageEvidence(store, event({ use_kind: 'raw-prompt' })))
        .toThrow(/use_kind/i);
      expect(store.all('SELECT * FROM memory_usage_events')).toEqual([]);
    } finally {
      store.close();
    }
  });
});
