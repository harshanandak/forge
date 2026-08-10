'use strict';

const { expect, mock, test } = require('bun:test');
const contracts = require('../memory-contracts');
const manifest = require('./package.json');
mock.module('@forge/memory-contracts', () => contracts);
const memory = require('./index');

test('@forge/memory exposes the stable backend registry entrypoint', () => {
  expect(memory.BACKEND_METHODS).toEqual(['add', 'recall', 'search', 'capture', 'digest']);
  expect(typeof memory.createMemoryBackendRegistry).toBe('function');
  expect(typeof memory.createMonitorStore).toBe('function');
  expect(typeof memory.createUsageEvidenceStore).toBe('function');
  expect(typeof memory.appendUsageEvidence).toBe('function');
  expect(typeof memory.normalizeUsageEvidence).toBe('function');
});

test('@forge/memory supports at least the runtime floor required by memory-contracts', () => {
  expect(manifest.engines.node).toBe('>=22.16.0');
});

test('@forge/memory validates usage evidence before delegating to a driver', () => {
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
