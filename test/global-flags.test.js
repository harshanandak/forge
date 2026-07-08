'use strict';

const { describe, test, expect } = require('bun:test');

const { stripGlobalFlags } = require('../lib/global-flags');

describe('stripGlobalFlags', () => {
  test('strips -p and its value (kernel c1e090ff regression)', () => {
    expect(stripGlobalFlags(['remember this', '-p', 'C:\\some\\dir']))
      .toEqual(['remember this']);
  });

  test('strips --path with a separate value', () => {
    expect(stripGlobalFlags(['note', 'text', '--path', '/tmp/project']))
      .toEqual(['note', 'text']);
  });

  test('strips the --path=<dir> form', () => {
    expect(stripGlobalFlags(['note', '--path=/tmp/project'])).toEqual(['note']);
  });

  test('strips boolean global flags without eating following words', () => {
    expect(stripGlobalFlags(['--verbose', 'keep', '--dry-run', 'these', '-y']))
      .toEqual(['keep', 'these']);
  });

  test('strips other value-taking global flags with their values', () => {
    expect(stripGlobalFlags(['note', '--agents', 'claude', '--type', 'bug']))
      .toEqual(['note']);
  });

  test('does not consume a following flag as a value', () => {
    expect(stripGlobalFlags(['note', '-p', '--verbose'])).toEqual(['note']);
  });

  test('leaves non-global flags (e.g. --tag) untouched', () => {
    expect(stripGlobalFlags(['note', '--tag', 'infra', '--json']))
      .toEqual(['note', '--tag', 'infra', '--json']);
  });

  test('leaves plain words that resemble flag names untouched', () => {
    expect(stripGlobalFlags(['force', 'sync', 'path'])).toEqual(['force', 'sync', 'path']);
  });
});
