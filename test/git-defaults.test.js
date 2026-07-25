const { describe, test, expect } = require('bun:test');

const { detectDefaultBranch } = require('../lib/git-defaults');

describe('detectDefaultBranch', () => {
  test('parses branch from symbolic-ref output (origin/HEAD = main)', () => {
    const mockExec = (_cmd, args, _opts) => {
      if (args[0] === 'symbolic-ref') {
        return Buffer.from('refs/remotes/origin/main\n');
      }
      throw new Error('unexpected call');
    };
    const result = detectDefaultBranch('/fake/project', { _exec: mockExec });
    expect(result).toBe('main');
  });

  test('preserves slashes in the default branch name (release/2026)', () => {
    const mockExec = (_cmd, args, _opts) => {
      if (args[0] === 'symbolic-ref') {
        return Buffer.from('refs/remotes/origin/release/2026\n');
      }
      throw new Error('unexpected call');
    };
    const result = detectDefaultBranch('/fake/project', { _exec: mockExec });
    expect(result).toBe('release/2026');
  });

  test('falls back to remote show when symbolic-ref fails, parses develop', () => {
    const mockExec = (_cmd, args, _opts) => {
      if (args[0] === 'symbolic-ref') {
        throw new Error('not a symbolic ref');
      }
      if (args[0] === 'remote' && args[1] === 'show') {
        return Buffer.from(
          'Remote origin\n  HEAD branch: develop\n  Remote branches:\n'
        );
      }
      throw new Error('unexpected call');
    };
    const result = detectDefaultBranch('/fake/project', { _exec: mockExec });
    expect(result).toBe('develop');
  });

  test('falls back to main when all git commands fail', () => {
    const mockExec = (_cmd, _args, _opts) => {
      throw new Error('git not available');
    };
    const result = detectDefaultBranch('/fake/project', { _exec: mockExec });
    expect(result).toBe('main');
  });
});
