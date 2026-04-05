'use strict';

const { describe, test, expect } = require('bun:test');

const claim = require('../../lib/commands/claim');

describe('forge claim command', () => {
  test('exports the claim alias command', () => {
    expect(claim.name).toBe('claim');
    expect(typeof claim.description).toBe('string');
    expect(typeof claim.handler).toBe('function');
  });
});
