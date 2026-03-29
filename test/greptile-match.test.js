const { describe, test, expect } = require('bun:test');

// Module under test
const { matchThreadsToCommits } = require('../lib/greptile-match');

describe('greptile-match', () => {
  describe('matchThreadsToCommits', () => {
    test('should export matchThreadsToCommits as a function', () => {
      expect(typeof matchThreadsToCommits).toBe('function');
    });

    test('should return empty array for empty threads input', () => {
      const mockExec = () => '';
      const result = matchThreadsToCommits([], '/fake/root', { _exec: mockExec });
      expect(result).toEqual([]);
    });

    test('should mark file as resolved when git log finds matching commits', () => {
      const mockExec = (_cmd, args) => {
        // Simulate git log returning a commit that touched the file
        if (args.includes('log')) {
          return 'abc1234 fix: update component\ndef5678 feat: initial add\n';
        }
        return '';
      };

      const threads = [{ file: 'src/index.js', line: 42 }];
      const result = matchThreadsToCommits(threads, '/fake/root', { _exec: mockExec });

      expect(result).toEqual([
        { file: 'src/index.js', line: 42, resolved: true, sha: 'abc1234' }
      ]);
    });

    test('should mark file as unresolved when git log finds no commits', () => {
      const mockExec = (_cmd, _args) => {
        // Simulate git log returning empty (no commits touched this file)
        return '';
      };

      const threads = [{ file: 'src/untouched.js', line: 10 }];
      const result = matchThreadsToCommits(threads, '/fake/root', { _exec: mockExec });

      expect(result).toEqual([
        { file: 'src/untouched.js', line: 10, resolved: false, reason: 'no matching commit' }
      ]);
    });

    test('should handle multiple threads with mixed results', () => {
      const mockExec = (_cmd, args) => {
        // Check which file is being queried by looking at the last arg
        const fileArg = args[args.length - 1];
        if (fileArg === 'src/changed.js') {
          return 'aaa1111 fix: changed file\n';
        }
        return '';
      };

      const threads = [
        { file: 'src/changed.js', line: 5 },
        { file: 'src/unchanged.js', line: 20 }
      ];
      const result = matchThreadsToCommits(threads, '/fake/root', { _exec: mockExec });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ file: 'src/changed.js', line: 5, resolved: true, sha: 'aaa1111' });
      expect(result[1]).toEqual({ file: 'src/unchanged.js', line: 20, resolved: false, reason: 'no matching commit' });
    });

    test('should use --follow flag to handle renamed files', () => {
      const capturedArgs = [];
      const mockExec = (_cmd, args) => {
        capturedArgs.push([...args]);
        return 'bbb2222 refactor: rename file\n';
      };

      const threads = [{ file: 'src/renamed.js', line: 1 }];
      matchThreadsToCommits(threads, '/fake/root', { _exec: mockExec });

      // Verify --follow was passed to git log (may not be the first call due to merge-base)
      const gitLogCall = capturedArgs.find(a => a.includes('log'));
      expect(gitLogCall).toBeTruthy();
      expect(gitLogCall).toContain('--follow');
    });

    test('should use execFileSync with -C flag for projectRoot', () => {
      const capturedArgs = [];
      const mockExec = (cmd, args) => {
        capturedArgs.push({ cmd, args: [...args] });
        return '';
      };

      const threads = [{ file: 'src/test.js', line: 1 }];
      matchThreadsToCommits(threads, '/my/project', { _exec: mockExec });

      const call = capturedArgs[0];
      expect(call.cmd).toBe('git');
      expect(call.args).toContain('-C');
      expect(call.args).toContain('/my/project');
    });

    test('should handle git log output with various formats gracefully', () => {
      const mockExec = () => {
        // Single commit, no trailing newline
        return 'ccc3333 feat: single commit';
      };

      const threads = [{ file: 'src/file.js', line: 1 }];
      const result = matchThreadsToCommits(threads, '/fake/root', { _exec: mockExec });

      expect(result[0].resolved).toBe(true);
      expect(result[0].sha).toBe('ccc3333');
    });

    test('should handle execFileSync throwing an error gracefully', () => {
      const mockExec = () => {
        throw new Error('git not found');
      };

      const threads = [{ file: 'src/broken.js', line: 1 }];
      const result = matchThreadsToCommits(threads, '/fake/root', { _exec: mockExec });

      expect(result[0]).toEqual({
        file: 'src/broken.js',
        line: 1,
        resolved: false,
        reason: 'no matching commit'
      });
    });
  });
});
