'use strict';

const { describe, test, expect } = require('bun:test');

const prime = require('../../lib/commands/prime');

describe('forge prime command', () => {
  test('exports the session-entry orientation command', () => {
    expect(prime.name).toBe('prime');
    expect(typeof prime.description).toBe('string');
    expect(typeof prime.handler).toBe('function');
    expect(prime.usage).toContain('--json');
  });
});
