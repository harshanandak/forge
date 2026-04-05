'use strict';

const { describe, test, expect } = require('bun:test');

const ready = require('../../lib/commands/ready');

describe('forge ready command', () => {
  test('exports the ready alias command', () => {
    expect(ready.name).toBe('ready');
    expect(typeof ready.description).toBe('string');
    expect(typeof ready.handler).toBe('function');
  });
});
