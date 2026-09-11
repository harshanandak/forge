// forge-test-resource: exclusive
'use strict';

const { afterAll, describe, test, expect } = require('bun:test');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { handler } = require('../lib/commands/github');
const { createCliSandboxes, runForgeIn } = require('./helpers/cli-subprocess');

const sandboxes = createCliSandboxes('forge-github-launch-');
afterAll(() => sandboxes.cleanup());

function optionsFor(childRunner, bound = true) {
  return { childRunner, baseEnv: { GH_TOKEN: 'ambient-only', GITHUB_TOKEN: 'ambient-only', GH_HOST: 'other.example', KEEP: 'yes' },
    runner: (command, args) => {
      if (command === 'git') return bound ? 'work' : '';
      if (args[0] === 'auth') return 'selected-test-only';
      return 'work';
    } };
}

describe('forge github launcher', () => {
  test('failed use leaves the existing Git config byte-for-byte unchanged', async () => {
    const root = sandboxes.makeSandbox();
    execFileSync('git', ['config', '--local', 'github.account', 'personal'], { cwd: root, stdio: 'pipe', windowsHide: true });
    const configPath = path.join(root, '.git', 'config');
    const before = fs.readFileSync(configPath);
    for (const failure of ['auth', 'identity', 'repository']) {
      const result = await handler(['use', 'work'], {}, root, {
        baseEnv: {},
        runner: (command, args, options) => {
          if (command === 'git') return execFileSync(command, args, options);
          if (args[0] === 'auth') {
            if (failure === 'auth') throw new Error('test-only-private-error');
            return 'test-only-private-value';
          }
          if (args[0] === 'api') return failure === 'identity' ? 'other' : 'work';
          throw new Error('test-only-private-error');
        },
      });
      expect(result.success).toBe(false);
      expect(fs.readFileSync(configPath).equals(before)).toBe(true);
      expect(JSON.stringify(result).includes('test-only-private')).toBe(false);
    }
  });

  test.each(['codex', 'claude.exe', 't3.cmd'])('launches %s with exact argv and only child-scoped account variables', async program => {
    let invocation;
    const child = new EventEmitter();
    const args = ['', 'two words', '& | > < ^ %VALUE% !VALUE!', '--help', '--version', '-p', 'child-path'];
    const before = { ...process.env };
    const result = await handler(['run', '--', program, ...args], {}, '/repo', optionsFor((command, argv, options) => {
      invocation = { command, argv, options };
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    }));
    expect(result.success).toBe(true);
    expect(invocation.command).toBe(program);
    expect(invocation.argv).toEqual(args);
    expect(invocation.options).toMatchObject({ cwd: '/repo', stdio: 'inherit', shell: false });
    expect(invocation.options.env).toEqual({ GH_TOKEN: 'selected-test-only', GITHUB_TOKEN: 'selected-test-only', GH_HOST: 'github.com', KEEP: 'yes' });
    expect(JSON.stringify(result).includes('selected-test-only')).toBe(false);
    expect(isDeepStrictEqual({ ...process.env }, before)).toBe(true);
  });

  test.each([[23, null, 23], [null, 'SIGINT', 130], [null, 'SIGTERM', 143]])('propagates exit and signal results: %j', async (code, signal, exitCode) => {
    const child = new EventEmitter();
    const result = await handler(['run', '--', 'program'], {}, '/repo', optionsFor(() => {
      queueMicrotask(() => child.emit('close', code, signal)); return child;
    }));
    expect(result).toMatchObject({ success: false, exitCode, signal });
  });

  test('missing program reports ENOENT without raw process errors', async () => {
    const child = new EventEmitter();
    const result = await handler(['run', '--', 'absent'], {}, '/repo', optionsFor(() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('selected-test-only'), { code: 'ENOENT' })));
      return child;
    }));
    expect(result).toMatchObject({ success: false, code: 'ENOENT', exitCode: 127 });
    expect(JSON.stringify(result).includes('selected-test-only')).toBe(false);
  });

  test('unbound launch preserves native environment', async () => {
    let environment;
    const child = new EventEmitter();
    await handler(['run', '--', 'program'], {}, '/repo', optionsFor((_command, _args, options) => {
      environment = options.env;
      queueMicrotask(() => child.emit('close', 0, null)); return child;
    }, false));
    expect(environment.GH_TOKEN).toBe('ambient-only');
    expect(environment.GH_HOST).toBe('other.example');
  });

  test('forwards termination to the child and removes parent signal listeners', async () => {
    const signals = new EventEmitter();
    const child = new EventEmitter();
    const received = [];
    child.kill = signal => { received.push(signal); queueMicrotask(() => child.emit('close', null, signal)); };
    const pending = handler(['run', '--', 'program'], {}, '/repo', {
      ...optionsFor(() => child), signalSource: signals,
    });
    signals.emit('SIGTERM');
    expect((await pending).exitCode).toBe(143);
    expect(received).toEqual(['SIGTERM']);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  test('public CLI preserves child help/version/path flags after delimiter', () => {
    const root = sandboxes.makeSandbox();
    const tail = ['--help', '--version', '-p', 'child path', '--path=child-only', 'a&b', ''];
    const result = runForgeIn(root, ['github', 'run', '--', process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...tail], {
      env: { GH_TOKEN: '', GITHUB_TOKEN: '', GH_HOST: '', FORGE_SHEPHERD_DISABLE: '1' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(JSON.stringify(tail));
  });

  test.skipIf(process.platform !== 'win32')('public launcher resolves Windows cmd shims with spaced and metacharacter arguments', () => {
    const root = sandboxes.makeSandbox();
    const shim = path.join(root, 'test program.cmd');
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`);
    const tail = ['two words', 'a&b', 'a|b', 'a>b', '^caret', '--help'];
    const result = runForgeIn(root, ['github', 'run', '--', shim, ...tail], {
      env: { GH_TOKEN: '', GITHUB_TOKEN: '', GH_HOST: '', FORGE_SHEPHERD_DISABLE: '1' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(JSON.stringify(tail));
  });

  test('public launcher preserves child exit code and reports missing programs', () => {
    const root = sandboxes.makeSandbox();
    const env = { GH_TOKEN: '', GITHUB_TOKEN: '', GH_HOST: '', FORGE_SHEPHERD_DISABLE: '1' };
    expect(runForgeIn(root, ['github', 'run', '--', process.execPath, '-e', 'process.exit(23)'], { env }).status).toBe(23);
    const missing = runForgeIn(root, ['github', 'run', '--', 'forge-test-program-that-does-not-exist'], { env });
    expect(missing.status).toBe(127);
    expect(missing.stderr).toContain('not found');
  });
});
