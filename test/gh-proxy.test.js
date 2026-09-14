'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveRealGh, runGhProxy } = require('../lib/gh-proxy');

function fixture({ automatic = false } = {}) {
  const calls = [];
  const spawnResult = { status: 0, signal: null };
  const options = {
    baseEnv: { PATH: 'kept', GH_TOKEN: 'ambient', FORGE_GH_PROXY_ACTIVE: '1' },
    readAuto: () => automatic,
    resolveExecutable: () => '/real/gh',
    spawnSync: (command, args, spawnOptions) => {
      calls.push({ type: 'spawn', command, args, options: spawnOptions });
      return spawnResult;
    },
    createContext: (root, contextOptions) => {
      calls.push({ type: 'context', root, env: contextOptions.baseEnv });
      return {
        bound: true,
        runChild: (command, args, childOptions) => {
          calls.push({ type: 'selected', command, args, options: childOptions });
          return spawnResult;
        },
      };
    },
  };
  return { calls, options };
}

describe('transparent gh proxy', () => {
  test('passes unbound and non-enabled repositories to the real gh unchanged', () => {
    const f = fixture();
    expect(runGhProxy(['repo', 'view'], '/personal', f.options)).toBe(0);
    expect(f.calls).toEqual([{ type: 'spawn', command: '/real/gh', args: ['repo', 'view'], options: {
      cwd: '/personal', env: { PATH: 'kept', GH_TOKEN: 'ambient' }, stdio: 'inherit', shell: false,
    } }]);
  });

  test.each([
    { args: ['auth'] }, { args: ['auth', 'login'] }, { args: ['auth', 'logout'] }, { args: ['auth', 'status'] },
    { args: ['auth', 'token'] }, { args: ['auth', 'switch'] }, { args: ['auth', 'refresh'] }, { args: ['auth', 'setup-git'] },
  ])('always bypasses account routing for native gh $args management', ({ args }) => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(false);
    expect(f.calls[0]).toMatchObject({ type: 'spawn', command: '/real/gh', args });
  });

  test('recognizes auth after global flags and preserves the ambient auth environment', () => {
    const f = fixture({ automatic: true });
    const args = ['--hostname', 'github.com', 'auth', 'status'];
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls).toEqual([{ type: 'spawn', command: '/real/gh', args, options: {
      cwd: '/work', env: { PATH: 'kept', GH_TOKEN: 'ambient' }, stdio: 'inherit', shell: false,
    } }]);
  });

  test.each([
    ['--hostname', 'enterprise.example'],
    ['--hostname=enterprise.example'],
    ['-Henterprise.example'],
  ])('passes an explicit non-GitHub hostname through without the selected token: %j', (...hostnameArgs) => {
    const f = fixture({ automatic: true });
    const args = ['api', ...hostnameArgs, 'user'];
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(false);
    expect(f.calls[0]).toMatchObject({ type: 'spawn', args, options: { env: { PATH: 'kept', GH_TOKEN: 'ambient' } } });
  });

  test('routes an enabled repository through its isolated selected context', () => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(['pr', 'create', '--draft'], '/work', f.options)).toBe(0);
    expect(f.calls).toEqual([
      { type: 'context', root: '/work', env: { PATH: 'kept', GH_TOKEN: 'ambient' } },
      { type: 'selected', command: '/real/gh', args: ['pr', 'create', '--draft'], options: {
        cwd: '/work', stdio: 'inherit', shell: false,
      } },
    ]);
    expect(f.options.baseEnv.FORGE_GH_PROXY_ACTIVE).toBe('1');
  });

  test('keeps simultaneous repositories independent and propagates child status', () => {
    const selected = [];
    const options = {
      readAuto: () => true,
      resolveExecutable: () => '/real/gh',
      createContext: root => ({ bound: true, runChild: (_command, _args, childOptions) => {
        selected.push({ root, cwd: childOptions.cwd });
        return { status: root === '/work' ? 7 : 0, signal: null };
      } }),
    };
    expect(runGhProxy(['api', 'user'], '/personal', options)).toBe(0);
    expect(runGhProxy(['api', 'user'], '/work', options)).toBe(7);
    expect(selected).toEqual([{ root: '/personal', cwd: '/personal' }, { root: '/work', cwd: '/work' }]);
  });

  test('returns command-not-found without attempting account resolution when real gh is missing', () => {
    const f = fixture({ automatic: true });
    f.options.resolveExecutable = () => null;
    const errors = [];
    f.options.writeError = value => errors.push(value);
    expect(runGhProxy(['api', 'user'], '/work', f.options)).toBe(127);
    expect(f.calls).toEqual([]);
    expect(errors.join('')).toContain('GitHub CLI');
  });

  test('skips marked Forge routers while resolving the real gh', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gh-proxy-'));
    const proxyDir = path.join(root, 'proxy');
    const realDir = path.join(root, 'real');
    fs.mkdirSync(proxyDir);
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(proxyDir, 'gh.cmd'), '@rem forge-gh-router-v1\r\n');
    fs.writeFileSync(path.join(realDir, 'gh.exe'), 'fake');
    try {
      expect(resolveRealGh({ platform: 'win32', pathEnv: [proxyDir, realDir].join(path.delimiter), pathExt: '.CMD;.EXE' }))
        .toBe(path.join(realDir, 'gh.exe'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('maps child signals to conventional exit codes', () => {
    const f = fixture();
    f.options.spawnSync = () => ({ status: null, signal: 'SIGTERM' });
    expect(runGhProxy(['repo', 'view'], '/repo', f.options)).toBe(143);
  });
});
