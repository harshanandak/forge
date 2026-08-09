'use strict';

const { expect, mock, test } = require('bun:test');
const contracts = require('../memory-contracts');
mock.module('@forge/memory-contracts', () => contracts);
const memory = require('./index');

test('@forge/memory exposes the stable backend registry entrypoint', () => {
  expect(memory.BACKEND_METHODS).toEqual(['add', 'recall', 'search', 'capture', 'digest']);
  expect(typeof memory.createMemoryBackendRegistry).toBe('function');
});
