'use strict';

const { describe, test, expect } = require('bun:test');

const create = require('../../lib/commands/create');

describe('forge create command', () => {
  test('exports the create alias command', () => {
    expect(create.name).toBe('create');
    expect(typeof create.description).toBe('string');
    expect(typeof create.handler).toBe('function');
  });
});
