'use strict';

const { describe, test, expect } = require('bun:test');

const stale = require('../../lib/commands/stale');

describe('forge stale command', () => {
  test('exports the stale alias command', () => {
    expect(stale.name).toBe('stale');
    expect(typeof stale.description).toBe('string');
    expect(typeof stale.handler).toBe('function');
  });
});
