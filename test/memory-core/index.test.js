'use strict';

const { expect, test } = require('bun:test');
const manifest = require('../../package.json');
const memory = require('../../lib/memory-core');

test('memory-core exposes the stable backend registry entrypoint', () => {
  expect(memory.BACKEND_METHODS).toEqual(['add', 'recall', 'search', 'capture', 'digest']);
  expect(typeof memory.createMemoryBackendRegistry).toBe('function');
  expect(typeof memory.createMonitorStore).toBe('function');
  expect(typeof memory.createUsageEvidenceStore).toBe('function');
  expect(typeof memory.appendUsageEvidence).toBe('function');
  expect(typeof memory.normalizeUsageEvidence).toBe('function');
});

test('memory-core supports at least the runtime floor required by contracts', () => {
  expect(manifest.engines.node).toBe('>=24.0.0');
});

test('memory-core validates usage evidence before delegating to a driver', () => {
  let calls = 0;
  const store = memory.createUsageEvidenceStore({
    appendUsageEvidence(event) { calls += 1; return event; },
    rebuildUsageProjection() {},
    loadUsageProjection() { return null; },
    loadUsageProjections() { return []; },
  });

  expect(() => store.append({ event_id: 'not enough' })).toThrow(/own data property/i);
  expect(calls).toBe(0);
});
