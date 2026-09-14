'use strict';

const { runProxyEntrypoint } = require('../../bin/forge-gh-proxy');

describe('Forge GitHub proxy entrypoint', () => {
  test('normalizes Node and Bun argv', () => {
    const calls = [];
    for (const args of [['--', 'pr', 'view', '--json', 'title'], ['pr', 'view', '--json', 'title']]) {
      expect(runProxyEntrypoint(args, '/work', {
        runProxy: (forwarded, root) => { calls.push({ args: forwarded, root }); return 9; },
      })).toBe(9);
    }
    expect(calls).toEqual([
      { args: ['pr', 'view', '--json', 'title'], root: '/work' },
      { args: ['pr', 'view', '--json', 'title'], root: '/work' },
    ]);
  });

  test('keeps local-only calls on the lightweight native path', () => {
    const calls = [];
    expect(runProxyEntrypoint(['--', '--help'], '/work', {
      runNative: (args, root) => { calls.push({ args, root }); return 4; },
      runProxy: () => { throw new Error('full proxy must not load'); },
    })).toBe(4);
    expect(calls).toEqual([{ args: ['--help'], root: '/work' }]);
  });

  test.each([
    ['api', '-fhello=world', 'rate_limit'],
    ['issue', 'create', '--title', 'test', '--body', '--help'],
    ['api', 'graphql', '--', '-h'],
    ['my-alias', '--help'],
  ])('does not bypass routing for help-looking command data: %j', (...args) => {
    expect(runProxyEntrypoint(args, '/work', {
      runNative: () => { throw new Error('native fast path must not run'); },
      runProxy: () => 9,
    })).toBe(9);
  });
});
