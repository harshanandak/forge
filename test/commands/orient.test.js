'use strict';

const { describe, test, expect } = require('bun:test');

const orient = require('../../lib/commands/orient');

describe('forge orient command', () => {
  test('exports the bounded orientation command', () => {
    expect(orient.name).toBe('orient');
    expect(typeof orient.description).toBe('string');
    expect(typeof orient.handler).toBe('function');
    expect(orient.usage).toContain('--json');
  });
});
