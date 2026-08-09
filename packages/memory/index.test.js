'use strict';

const { expect, test } = require('bun:test');
const memory = require('./index');

test('@forge/memory exposes the stable backend registry entrypoint', () => {
  expect(memory.BACKEND_METHODS).toEqual(['add', 'recall', 'search', 'capture', 'digest']);
  expect(typeof memory.createMemoryBackendRegistry).toBe('function');
});
