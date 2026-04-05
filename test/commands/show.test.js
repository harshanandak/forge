'use strict';

const { describe, test, expect } = require('bun:test');

const show = require('../../lib/commands/show');

describe('forge show command', () => {
  test('exports the show alias command', () => {
    expect(show.name).toBe('show');
    expect(typeof show.description).toBe('string');
    expect(typeof show.handler).toBe('function');
  });
});
