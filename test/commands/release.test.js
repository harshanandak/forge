'use strict';

const { describe, expect, test } = require('bun:test');

const release = require('../../lib/commands/release');

describe('forge release command', () => {
  test('exports the release alias command', () => {
    expect(release.name).toBe('release');
    expect(typeof release.description).toBe('string');
    expect(typeof release.handler).toBe('function');
  });
});
