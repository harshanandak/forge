'use strict';

const { describe, test, expect } = require('bun:test');

const { buildBdArgs } = require('../../lib/commands/_issue');

describe('forge issue helpers', () => {
  test('buildBdArgs maps create to bd create passthrough', () => {
    expect(buildBdArgs('create', ['--title', 'Test', '--type', 'feature']))
      .toEqual(['create', '--title', 'Test', '--type', 'feature']);
  });

  test('buildBdArgs maps claim to bd update --claim', () => {
    expect(buildBdArgs('claim', ['forge-abc']))
      .toEqual(['update', 'forge-abc', '--claim']);
  });

  test('buildBdArgs rejects claim without an issue id', () => {
    expect(buildBdArgs('claim', [])).toEqual({
      error: 'Missing issue id. Usage: forge claim <id> [bd-update-flags]',
    });
  });
});
