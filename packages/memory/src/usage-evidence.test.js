'use strict';

const { expect, test } = require('bun:test');
const { createUsageEvidenceStore } = require('./usage-evidence');
const { appendUsageEvidence, installUsageEvidenceSchema, rebuildUsageProjection } = require('./usage-evidence');

function event() {
  return {
    event_id: 'a'.repeat(64), memory_id: 'b'.repeat(64), scope: 'c'.repeat(64),
    use_kind: 'cli-recall', consumer_id: 'cli-recall', selection_digest: 'd'.repeat(64),
    observed_at: '2026-08-10T00:00:00.000Z', idempotency_key: 'e'.repeat(64),
  };
}

test('usage evidence public store validates input before invoking the driver', () => {
  let calls = 0;
  const store = createUsageEvidenceStore({
    appendUsageEvidence(event) { calls += 1; return event; },
    rebuildUsageProjection() {},
    loadUsageProjection() { return null; },
    loadUsageProjections() { return []; },
  });

  expect(() => store.append({ event_id: 'not enough' })).toThrow(/own data property/i);
  expect(calls).toBe(0);
});

test('usage evidence store rejects accessor and Proxy adapters without invoking them', () => {
  let getterCalls = 0;
  const accessorAdapter = {
    rebuildUsageProjection() {}, loadUsageProjection() { return null; }, loadUsageProjections() { return []; },
  };
  Object.defineProperty(accessorAdapter, 'appendUsageEvidence', {
    get() { getterCalls += 1; return () => {}; },
  });
  expect(() => createUsageEvidenceStore(accessorAdapter)).toThrow(/own data property/i);
  expect(getterCalls).toBe(0);

  let trapCalls = 0;
  const proxyAdapter = new Proxy({}, {
    getOwnPropertyDescriptor() { trapCalls += 1; return undefined; },
    get() { trapCalls += 1; return undefined; },
  });
  expect(() => createUsageEvidenceStore(proxyAdapter)).toThrow(/adapter/i);
  expect(trapCalls).toBe(0);
});

test('usage evidence store captures validated driver methods without later accessor reads', () => {
  let getterCalls = 0;
  const driver = {
    appendUsageEvidence() { return { appended: true }; },
    rebuildUsageProjection() { return { projections: 0 }; },
    loadUsageProjection() { return null; },
    loadUsageProjections() { return []; },
  };
  const store = createUsageEvidenceStore(driver);
  for (const method of ['appendUsageEvidence', 'rebuildUsageProjection', 'loadUsageProjection', 'loadUsageProjections']) {
    Object.defineProperty(driver, method, { get() { getterCalls += 1; return () => null; } });
  }
  expect(store.append(event())).toEqual({ appended: true });
  expect(store.rebuild()).toEqual({ projections: 0 });
  expect(store.projection('b'.repeat(64))).toBeNull();
  expect(store.projections(['b'.repeat(64)])).toEqual([]);
  expect(getterCalls).toBe(0);
});

test('low-level usage helpers reject hostile adapters before getters or Proxy traps run', () => {
  let getterCalls = 0;
  const accessorStore = { one() {}, run() {}, transaction() {} };
  Object.defineProperty(accessorStore, 'exec', { get() { getterCalls += 1; return () => {}; } });
  expect(() => installUsageEvidenceSchema(accessorStore)).toThrow(/own data property/i);
  expect(getterCalls).toBe(0);

  let trapCalls = 0;
  const proxyStore = new Proxy({}, { getOwnPropertyDescriptor() { trapCalls += 1; } });
  expect(() => installUsageEvidenceSchema(proxyStore)).toThrow(/plain record/i);
  expect(() => appendUsageEvidence(proxyStore, event())).toThrow(/plain record/i);
  expect(() => rebuildUsageProjection(proxyStore)).toThrow(/plain record/i);
  expect(trapCalls).toBe(0);
});

test('low-level usage helpers retain captured adapter methods during a transaction', () => {
  let getterCalls = 0;
  const replaceWithAccessors = store => {
    for (const method of ['one', 'run', 'exec', 'assertUsageWriterEnabled']) {
      Object.defineProperty(store, method, { get() { getterCalls += 1; return () => null; } });
    }
  };
  const appendStore = {
    transaction(callback) { replaceWithAccessors(this); return callback(); },
    one(sql) { return sql.includes('last_used_at') ? { last_used_at: event().observed_at, use_count: 1 } : null; },
    run() {},
    assertUsageWriterEnabled() {},
  };
  expect(appendUsageEvidence(appendStore, event())).toMatchObject({ appended: true, use_count: 1 });

  const rebuildStore = {
    transaction(callback) { replaceWithAccessors(this); return callback(); },
    one(sql) { return sql.includes('COUNT(*)') ? { count: 3 } : null; },
    exec() {},
    assertUsageWriterEnabled() {},
  };
  expect(rebuildUsageProjection(rebuildStore)).toEqual({ projections: 3 });
  expect(getterCalls).toBe(0);
});
