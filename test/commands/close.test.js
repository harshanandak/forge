'use strict';

const { describe, test, expect } = require('bun:test');

const close = require('../../lib/commands/close');

describe('forge close command', () => {
  test('exports the close alias command', () => {
    expect(close.name).toBe('close');
    expect(typeof close.description).toBe('string');
    expect(typeof close.handler).toBe('function');
  });
});
