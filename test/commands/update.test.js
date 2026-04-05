'use strict';

const { describe, test, expect } = require('bun:test');

const update = require('../../lib/commands/update');

describe('forge update command', () => {
  test('exports the update alias command', () => {
    expect(update.name).toBe('update');
    expect(typeof update.description).toBe('string');
    expect(typeof update.handler).toBe('function');
  });
});
