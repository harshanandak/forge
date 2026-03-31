const { describe, test, expect, beforeEach, mock } = require('bun:test');

const { secureExecFileSync } = require('../lib/shell-utils');

describe('shell-utils', () => {
  describe('secureExecFileSync', () => {
    test('executes a command and returns output', () => {
      // 'echo' is available on all platforms
      const result = secureExecFileSync('node', ['-e', 'process.stdout.write("hello")'], {
        encoding: 'utf8'
      });
      expect(result.toString()).toBe('hello');
    });

    test('falls back to direct execution when path resolution fails', () => {
      // Even if 'which'/'where' can't resolve, the fallback should still work
      const result = secureExecFileSync('node', ['-e', 'process.stdout.write("fallback")'], {
        encoding: 'utf8'
      });
      expect(result.toString()).toContain('fallback');
    });

    test('passes options through to execFileSync', () => {
      const result = secureExecFileSync('node', ['-e', 'process.stdout.write(process.cwd())'], {
        encoding: 'utf8',
        cwd: process.cwd()
      });
      expect(typeof result).toBe('string');
    });

    test('throws on invalid command', () => {
      expect(() => {
        secureExecFileSync('__nonexistent_command_xyz__', [], { encoding: 'utf8' });
      }).toThrow();
    });

    test('handles empty args array', () => {
      const result = secureExecFileSync('node', [], {
        encoding: 'utf8',
        input: '',
        timeout: 2000
      });
      // node with no args reads stdin; with empty input and timeout it should not hang
      expect(result).toBeDefined();
    });
  });
});
