'use strict';

const { describe, test, expect } = require('bun:test');

const blocked = require('../../lib/commands/blocked');

describe('forge blocked command', () => {
  test('exports the blocked alias command', () => {
    expect(blocked.name).toBe('blocked');
    expect(typeof blocked.description).toBe('string');
    expect(typeof blocked.handler).toBe('function');
  });
});
