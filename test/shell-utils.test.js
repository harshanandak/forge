const { describe, test, expect } = require('bun:test');

const { secureExecFileSync } = require('../lib/shell-utils');

describe('secureExecFileSync', () => {
  test('falls back to the original command when path resolution fails', () => {
    const execCalls = [];
    const result = secureExecFileSync('bd', ['version'], {
      _platform: 'linux',
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
      _platform: 'linux',
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
      _platform: 'linux',
      _spawnSync: () => ({ status: 0, stdout: '/usr/bin/bd\n' }),
      _execFileSync: (command) => {
        execCalls.push(command);
        throw new Error(`boom: ${command}`);
      },
    })).toThrow('boom: /usr/bin/bd');

    expect(execCalls).toEqual(['/usr/bin/bd']);
  });

  describe('on win32 (regression: spawnSync npm ENOENT — kernel 9997d516)', () => {
    test('runs cmd-shim binaries (npm.cmd) via shell with the bare command name', () => {
      const execCalls = [];
      // where.exe lists the extensionless shim FIRST — the old code picked it
      // and execFileSync failed with ENOENT (it is a bash script, not a PE).
      secureExecFileSync('npm', ['install', '--save-dev', 'lefthook'], {
        _platform: 'win32',
        _spawnSync: () => ({
          status: 0,
          stdout: 'C:\\Program Files\\nodejs\\npm\r\nC:\\Program Files\\nodejs\\npm.cmd\r\n',
        }),
        _execFileSync: (command, args, options) => {
          execCalls.push({ command, args, shell: options.shell });
          return '';
        },
      });

      expect(execCalls).toEqual([{
        command: 'npm',
        args: ['install', '--save-dev', 'lefthook'],
        shell: true,
      }]);
    });

    test('spawns a resolved .exe directly without a shell', () => {
      const execCalls = [];
      secureExecFileSync('bd', ['version'], {
        _platform: 'win32',
        _spawnSync: () => ({ status: 0, stdout: 'C:\\tools\\bd.exe\r\n' }),
        _execFileSync: (command, args, options) => {
          execCalls.push({ command, args, shell: options.shell });
          return '';
        },
      });

      expect(execCalls).toEqual([{
        command: 'C:\\tools\\bd.exe',
        args: ['version'],
        shell: undefined,
      }]);
    });

    test('prefers a .exe even when where.exe lists a shim first', () => {
      const execCalls = [];
      secureExecFileSync('lefthook', ['install'], {
        _platform: 'win32',
        _spawnSync: () => ({
          status: 0,
          stdout: 'C:\\repo\\node_modules\\.bin\\lefthook\r\nC:\\repo\\node_modules\\.bin\\lefthook.exe\r\n',
        }),
        _execFileSync: (command, args, options) => {
          execCalls.push({ command, args, shell: options.shell });
          return '';
        },
      });

      expect(execCalls).toEqual([{
        command: 'C:\\repo\\node_modules\\.bin\\lefthook.exe',
        args: ['install'],
        shell: undefined,
      }]);
    });

    test('falls back to shell execution when resolution fails entirely', () => {
      const execCalls = [];
      secureExecFileSync('npx', ['lefthook', 'install'], {
        _platform: 'win32',
        _spawnSync: () => ({ status: 1, stdout: '' }),
        _execFileSync: (command, args, options) => {
          execCalls.push({ command, args, shell: options.shell });
          return '';
        },
      });

      expect(execCalls).toEqual([{
        command: 'npx',
        args: ['lefthook', 'install'],
        shell: true,
      }]);
    });

    test('refuses shell execution when a token contains cmd metacharacters', () => {
      expect(() => secureExecFileSync('npm', ['install', 'x && del C:\\'], {
        _platform: 'win32',
        _spawnSync: () => ({ status: 0, stdout: 'C:\\nodejs\\npm.cmd\r\n' }),
        _execFileSync: () => '',
      })).toThrow(/unsafe token/);
    });

    test('spawns an absolute .exe command directly even when where.exe finds nothing', () => {
      // Regression (kernel 9997d516): callers may pass an already-resolved
      // absolute path (e.g. "C:\\Program Files\\Git\\bin\\git.exe"). where.exe
      // may not re-enumerate it, leaving no candidates. It must still spawn
      // directly (shell:false) — never fall to shell:true, where the space in
      // "Program Files" trips the shell-safe token allowlist.
      const execCalls = [];
      const gitExe = 'C:\\Program Files\\Git\\bin\\git.exe';
      secureExecFileSync(gitExe, ['rev-parse', 'HEAD'], {
        _platform: 'win32',
        _spawnSync: () => ({ status: 1, stdout: '' }),
        _execFileSync: (command, args, options) => {
          execCalls.push({ command, args, shell: options.shell });
          return '';
        },
      });

      expect(execCalls).toEqual([{
        command: gitExe,
        args: ['rev-parse', 'HEAD'],
        shell: undefined,
      }]);
    });
  });
});
