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
});

test('@forge/memory supports at least the runtime floor required by memory-contracts', () => {
  expect(manifest.engines.node).toBe('>=22.16.0');
});
