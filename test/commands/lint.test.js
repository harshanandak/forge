'use strict';

const { describe, test, expect } = require('bun:test');

const lint = require('../../lib/commands/lint');

describe('forge lint command', () => {
  test('exports the lint alias command', () => {
    expect(lint.name).toBe('lint');
    expect(typeof lint.description).toBe('string');
    expect(typeof lint.handler).toBe('function');
  });
});
