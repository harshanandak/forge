'use strict';

const { describe, test, expect } = require('bun:test');

const list = require('../../lib/commands/list');

describe('forge list command', () => {
  test('exports the list alias command', () => {
    expect(list.name).toBe('list');
    expect(typeof list.description).toBe('string');
    expect(typeof list.handler).toBe('function');
  });
});
