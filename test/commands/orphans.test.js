'use strict';

const { describe, test, expect } = require('bun:test');

const orphans = require('../../lib/commands/orphans');

describe('forge orphans command', () => {
  test('exports the orphans alias command', () => {
    expect(orphans.name).toBe('orphans');
    expect(typeof orphans.description).toBe('string');
    expect(typeof orphans.handler).toBe('function');
  });
});
