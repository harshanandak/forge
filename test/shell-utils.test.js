const { describe, test, expect } = require('bun:test');

const { secureExecFileSync } = require('../lib/shell-utils');

describe('secureExecFileSync', () => {
  test('falls back to the original command when path resolution fails', () => {
    const execCalls = [];
    const result = secureExecFileSync('bd', ['version'], {
      _spawnSync: () => ({ status: 1, stdout: '' }),
      _execFileSync: (command, args) => {
        execCalls.push({ command, args });
        return 'bd 1.0.0';
      },
    });

    expect(result).toBe('bd 1.0.0');
    expect(execCalls).toEqual([{ command: 'bd', args: ['version'] }]);
  });

  test('uses the resolved executable path when lookup succeeds', () => {
    const execCalls = [];
    secureExecFileSync('bd', ['version'], {
      _spawnSync: () => ({ status: 0, stdout: '/usr/bin/bd\n' }),
      _execFileSync: (command, args) => {
        execCalls.push({ command, args });
        return 'bd 1.0.0';
      },
    });

    expect(execCalls).toEqual([{ command: '/usr/bin/bd', args: ['version'] }]);
  });

  test('does not retry with the unresolved command when resolved execution throws', () => {
    const execCalls = [];

    expect(() => secureExecFileSync('bd', ['version'], {
      _spawnSync: () => ({ status: 0, stdout: '/usr/bin/bd\n' }),
      _execFileSync: (command) => {
        execCalls.push(command);
        throw new Error(`boom: ${command}`);
      },
    })).toThrow('boom: /usr/bin/bd');

    expect(execCalls).toEqual(['/usr/bin/bd']);
  });
});
