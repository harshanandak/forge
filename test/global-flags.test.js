'use strict';

const { describe, test, expect } = require('bun:test');

const { stripGlobalFlags, firstPositionalIndex } = require('../lib/global-flags');

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

describe('firstPositionalIndex', () => {
  test('returns 0 when the first token is already positional', () => {
    expect(firstPositionalIndex(['ship', 'slug'])).toBe(0);
  });

  test('skips a value-taking global flag and its value', () => {
    // ['pr', '--path', '/tmp', 'ship'] scanned from index 1 → 'ship' at index 3.
    expect(firstPositionalIndex(['pr', '--path', '/tmp', 'ship'], 1)).toBe(3);
  });

  test('skips the --path=<dir> form and boolean global flags', () => {
    expect(firstPositionalIndex(['pr', '--path=/tmp', '--verbose', 'ship'], 1)).toBe(3);
  });

  test('skips non-global flags too (only bare words are positional)', () => {
    expect(firstPositionalIndex(['pr', '--json', 'ship'], 1)).toBe(2);
  });

  test('returns -1 when there is no positional token', () => {
    expect(firstPositionalIndex(['pr', '--path', '/tmp'], 1)).toBe(-1);
  });
});
