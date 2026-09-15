'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveRealGh, runGhProxy } = require('../lib/gh-proxy');

function fixture({ automatic = false } = {}) {
  const calls = [];
  const result = { status: 0, signal: null };
  const options = {
    baseEnv: { PATH: 'kept', GH_TOKEN: 'ambient', FORGE_GH_PROXY_ACTIVE: '1' },
    readAuto: () => automatic,
    assertRegistered: () => true,
    resolveExecutable: () => '/real/gh',
    readCommandHelp: () => `Usage: gh pr view [<number> | <url>] [flags]

Flags:
  -b, --body string   Body text
  -R, --repo string   Repository
  -w, --web           Open in browser
      --hostname string   GitHub hostname
`,
    resolveLocalTarget: () => ({ hostname: 'github.com', repository: 'org/project' }),
    spawnSync: (command, args, spawnOptions) => {
      calls.push({ type: 'spawn', command, args, options: spawnOptions });
      return result;
    },
    createContext: (root, contextOptions) => {
      calls.push({ type: 'context', root, env: contextOptions.baseEnv });
      return {
        bound: true,
        runChild: (command, args, childOptions) => {
          calls.push({ type: 'selected', command, args, options: childOptions });
          return result;
        },
      };
    },
  };
  return { calls, options };
}

describe('transparent gh proxy', () => {
  test('passes a disabled repository to native gh unchanged', () => {
    const f = fixture();
    expect(runGhProxy(['repo', 'view'], '/personal', f.options)).toBe(0);
    expect(f.calls).toEqual([{ type: 'spawn', command: '/real/gh', args: ['repo', 'view'], options: {
      cwd: '/personal', env: { PATH: 'kept', GH_TOKEN: 'ambient' }, stdio: 'inherit', shell: false,
    } }]);
  });

  test.each([
    [], ['--version'], ['--version=true'], ['--help'], ['--help=true'], ['-h'], ['version'], ['help'],
    ['pr', 'create', '--help'], ['pr', 'list', '--help=true'], ['completion', '-s', 'bash'], ['config', 'get', 'git_protocol'], ['alias', 'list'],
    ['copilot', '--help'], ['discussion', '--help'], ['extension', '--help'], ['skill', '--help'], ['skills', '--help'],
    ['licenses'], ['preview'], ['skill', 'list'], ['skills', 'list'],
    ['skill', 'install', './skills', '--from-local'], ['skills', 'add', './skills', '--from-local=true'],
  ])('bypasses zero-argument and local-only calls before clone state lookup: %j', (...args) => {
    const f = fixture({ automatic: true });
    f.options.readAuto = () => { throw new Error('state lookup must not run'); };
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ type: 'spawn', command: '/real/gh', args });
  });

  test.each([
    ['pr', 'list', '-R', 'github.com/owner/repo', '--help'],
    ['pr', 'list', '--repo=github.com/owner/repo', '-h'],
  ])('bypasses local help with an inherited repository option: %j', (...args) => {
    const f = fixture({ automatic: true });
    f.options.readAuto = () => { throw new Error('state lookup must not run'); };
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ type: 'spawn', args });
  });

  test('does not bypass help-shaped option data', () => {
    const f = fixture({ automatic: true });
    const args = ['pr', 'comment', '1', '--body', '--help'];
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.find(call => call.type === 'selected')).toMatchObject({ args });
  });

  test.each([
    ['skill', 'install', './skills', '--dir', '--from-local'],
    ['skill', 'install', './skills', '--from-local=false'],
    ['skill', 'install', './skills', '--from-local', '--upstream'],
    ['skill', 'install', './skills', '--', '--from-local'],
  ])('does not bypass non-local skill invocations: %j', (...args) => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.find(call => call.type === 'selected')).toMatchObject({ args });
  });

  test.each([
    ['auth'], ['auth', 'login'], ['auth', 'logout'], ['auth', 'status'], ['auth', 'token'],
    ['--hostname', 'enterprise.example', 'auth', 'status'],
  ])('always bypasses native gh account management: %j', (...args) => {
    const f = fixture({ automatic: true });
    f.options.readAuto = () => { throw new Error('state lookup must not run'); };
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls[0]).toMatchObject({ type: 'spawn', args });
  });

  test.each([
    ['my-alias', '--limit', '1'], ['my-extension', 'run'], ['extension', 'list'],
    ['extension', 'install', 'owner/gh-tool'], ['extension', 'exec', 'my-extension', 'run'],
  ])('selects the clone environment for aliases and extensions: %j', (...args) => {
    const f = fixture({ automatic: true });
    f.options.readAliases = () => { throw new Error('must not enumerate aliases'); };
    f.options.readExtensions = () => { throw new Error('must not enumerate extensions'); };
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'spawn')).toBe(false);
    expect(f.calls.find(call => call.type === 'selected')).toMatchObject({ command: '/real/gh', args });
  });

  test('passes opaque alias URL option values to the selected account', () => {
    const f = fixture({ automatic: true });
    const args = ['my-alias', '--target', 'https://enterprise.example/value'];
    f.options.readCommandHelp = () => 'Usage: gh my-alias [flags]\n';
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.find(call => call.type === 'selected')).toMatchObject({ args });
  });

  test('uses no help, alias, extension, or live API discovery on the common path', () => {
    const f = fixture({ automatic: true });
    f.options.execFileSync = () => { throw new Error('unexpected discovery subprocess'); };
    f.options.readCommandHelp = () => { throw new Error('must not read help'); };
    f.options.readAliases = () => { throw new Error('must not enumerate aliases'); };
    f.options.readExtensions = () => { throw new Error('must not enumerate extensions'); };
    expect(runGhProxy(['pr', 'list', '--limit', '1'], '/work', f.options)).toBe(0);
    expect(f.calls.map(call => call.type)).toEqual(['context', 'selected']);
  });

  test('default common path retrieves the named token without a live identity call', () => {
    const f = fixture({ automatic: true });
    const commands = [];
    delete f.options.createContext;
    f.options.runner = (command, args) => {
      commands.push([command, ...args]);
      if (command === 'git') return 'work-account\n';
      if (command === 'gh' && args[0] === 'auth' && args[1] === 'token') return 'selected-token\n';
      throw new Error('unexpected live API call');
    };
    expect(runGhProxy(['pr', 'list'], '/work', f.options)).toBe(0);
    expect(commands).toEqual([
      ['git', 'config', '--local', '--get', 'github.account'],
      ['gh', 'auth', 'token', '--hostname', 'github.com', '--user', 'work-account'],
    ]);
    expect(f.calls[0].options.env).toEqual({
      PATH: 'kept', GH_TOKEN: 'selected-token', GITHUB_TOKEN: 'selected-token', GH_HOST: 'github.com',
      GH_REPO: 'github.com/org/project',
    });
  });

  test('fails closed when automatic routing state is invalid', () => {
    const f = fixture();
    const errors = [];
    f.options.readAuto = () => { throw Object.assign(new Error('repair github.auto'), { code: 'GITHUB_AUTO_INVALID' }); };
    f.options.writeError = value => errors.push(value);
    expect(runGhProxy(['pr', 'list'], '/work', f.options)).toBe(1);
    expect(f.calls).toEqual([]);
    expect(errors.join('')).toContain('forge github status');
  });

  test('fails closed when automatic routing state reports an invalid sentinel', () => {
    const f = fixture();
    f.options.readAuto = () => null;
    expect(runGhProxy(['pr', 'list'], '/work', f.options)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  test.each([
    ['api', '--hostname', 'enterprise.example', 'user'],
    ['api', '--hostname=enterprise.example', 'user'],
    ['api', 'https://enterprise.example/user'],
    ['pr', 'view', '--repo', 'enterprise.example/owner/repo'],
    ['pr', 'view', '--repo=enterprise.example/owner/repo'],
    ['pr', 'view', 'https://enterprise.example/owner/repo/pull/1'],
    ['discussion', 'view', 'https://enterprise.example/org/project/discussions/1'],
    ['pr', '-R', 'github.com/owner/repo', 'view', 'https://enterprise.example/owner/repo/pull/1'],
    ['discussion', 'comment', 'https://enterprise.example/org/project/discussions/1'],
    ['issue', 'transfer', '1', 'enterprise.example/owner/destination'],
    ['gist', 'clone', 'https://enterprise.example/example/0123456789'],
    ['repo', 'clone', 'https://enterprise.example/owner/repo'],
    ['repo', 'clone', 'git@enterprise.example:owner/repo.git'],
    ['repo', 'clone', 'git@@enterprise.example:owner/repo.git'],
    ['repo', 'clone', 'C:owner/repo.git'],
    ['repo', 'view', 'enterprise.example/owner/repo'],
    ['label', 'clone', 'enterprise.example/owner/source', '--repo', 'github.com/owner/destination'],
    ['repo', 'create', 'new', '--template', 'enterprise.example/owner/template'],
    ['repo', 'create', 'new', '-p', 'enterprise.example/owner/template'],
  ])('refuses an explicit non-GitHub.com target without spawning either account: %j', (...args) => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(args, '/work', f.options)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  test('rejects a plaintext public API URL before selecting an account', () => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(['api', 'http://api.github.com/user'], '/work', f.options)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  test.each(['owner/repository', 'git@github.com:owner/repository.git'])('treats positional %s as an explicit GitHub.com destination', repository => {
    const f = fixture({ automatic: true });
    f.options.resolveLocalTarget = () => { throw new Error('local remote must not be inspected'); };
    expect(runGhProxy(['repo', 'clone', repository], '/work', f.options)).toBe(0);
    expect(f.calls.find(call => call.type === 'selected')).toBeDefined();
  });

  test.each(['api.github.com', 'uploads.github.com'])('routes the public GitHub host %s through the selected account', host => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(['api', `https://${host}/user`], '/work', f.options)).toBe(0);
    expect(f.calls.find(call => call.type === 'selected')).toBeDefined();
  });

  test.each([
    ['issue', 'create', '--body', 'https://example.com'],
    ['pr', 'comment', '12', '--body=https://enterprise.example/reference'],
  ])('does not treat an option payload URL as a GitHub destination: %j', (...args) => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.find(call => call.type === 'selected')).toMatchObject({ args });
  });

  test('does not treat an autolink URL template as a GitHub destination', () => {
    const f = fixture({ automatic: true });
    f.options.readCommandHelp = () => '  gh repo autolink create <keyPrefix> <urlTemplate> [flags]';
    const args = ['repo', 'autolink', 'create', 'TICKET-', 'https://tracker.example/TICKET-<num>'];
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.find(call => call.type === 'selected')).toMatchObject({ args });
  });

  test('checks only the named URL positional slot from command usage', () => {
    const f = fixture({ automatic: true });
    const args = ['pr', 'view', 'https://github.com/org/repo/pull/1', 'https://enterprise.example/payload'];
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.find(call => call.type === 'selected')).toMatchObject({ args });
  });

  test.each([0, 1, 2])('checks every URL in a plural URL positional at index %d', enterpriseIndex => {
    const f = fixture({ automatic: true });
    f.options.readCommandHelp = () => '  gh issue edit {<numbers> | <urls>} [flags]';
    const urls = [1, 2, 3].map(number => `https://github.com/org/repo/issues/${number}`);
    urls[enterpriseIndex] = `https://enterprise.example/org/repo/issues/${enterpriseIndex + 1}`;
    expect(runGhProxy(['issue', 'edit', ...urls], '/work', f.options)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  test('routes multiple public URLs in a plural URL positional', () => {
    const f = fixture({ automatic: true });
    f.options.readCommandHelp = () => '  gh issue edit {<numbers> | <urls>} [flags]';
    const args = ['issue', 'edit', 'https://github.com/org/repo/issues/1', 'https://github.com/org/repo/issues/2'];
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.find(call => call.type === 'selected')).toMatchObject({ args });
  });

  test('fails closed when native help cannot classify a positional URL', () => {
    const f = fixture({ automatic: true });
    f.options.readCommandHelp = () => '';
    expect(runGhProxy(['pr', 'view', 'https://enterprise.example/org/repo/pull/1'], '/work', f.options)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  test.each([
    [['-iX', 'GET']],
    [['-iXGET']],
  ])('parses a value-taking clustered short option without misclassifying URL-shaped option data: %j', cluster => {
    const f = fixture({ automatic: true });
    f.options.readCommandHelp = () => `  gh api <endpoint> [flags]\n  -f, --raw-field key=value   Add a string parameter\n  -i, --include               Include response headers\n  -X, --method string         The HTTP method`;
    const args = ['api', ...cluster, 'user', '-f', 'query=https://example.com'];
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.find(call => call.type === 'selected')).toMatchObject({ args });
  });

  test('refuses an enterprise target in a combined short -R option', () => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(['repo', 'view', '-wRenterprise.example/owner/repo'], '/work', f.options)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  test.each([
    ['GH_HOST', 'enterprise.example'],
    ['GH_REPO', 'enterprise.example/owner/repo'],
  ])('refuses enabled clone ambient destination %s=%s', (name, value) => {
    const f = fixture({ automatic: true });
    f.options.baseEnv[name] = value;
    expect(runGhProxy(['api', 'user'], '/work', f.options)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  test.each([
    ['GH_REPO', 'owner/repo'],
    ['Gh_Repo', 'owner/repo'],
  ])('treats unqualified ambient %s as public GitHub on Windows', (name, value) => {
    const f = fixture({ automatic: true });
    f.options.platform = 'win32';
    f.options.baseEnv[name] = value;
    expect(runGhProxy(['pr', 'list'], '/work', f.options)).toBe(0);
    expect(f.calls.find(call => call.type === 'selected')).toBeDefined();
  });

  test('sets canonical GH_REPO when public GH_HOST accompanies an SSH-alias remote', () => {
    const f = fixture({ automatic: true });
    f.options.baseEnv.GH_HOST = 'github.com';
    delete f.options.createContext;
    f.options.runner = (command, args) => {
      if (command === 'git') return 'work-account\n';
      if (command === 'gh' && args[0] === 'auth' && args[1] === 'token') return 'selected-token\n';
      throw new Error('unexpected account lookup');
    };

    expect(runGhProxy(['pr', 'list'], '/work', f.options)).toBe(0);
    expect(f.calls[0].options.env.GH_REPO).toBe('github.com/org/project');
  });

  test('fails closed for an unknown explicit repository destination', () => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(['pr', 'view', '--repo', 'too/many/path/parts'], '/work', f.options)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  test('refuses an inferred enterprise repository', () => {
    const f = fixture({ automatic: true });
    f.options.resolveLocalTarget = () => ({ hostname: 'enterprise.example', repository: 'org/project' });
    expect(runGhProxy(['pr', 'list'], '/work', f.options)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  test('uses the sole non-origin remote when gh has no configured default', () => {
    const f = fixture({ automatic: true });
    delete f.options.resolveLocalTarget;
    const gitCalls = [];
    f.options.execFileSync = (command, args) => {
      expect(command).toBe('git');
      gitCalls.push(args);
      if (args[0] === 'config') throw Object.assign(new Error('not configured'), { status: 1 });
      if (args.join(' ') === 'remote get-url origin') throw Object.assign(new Error('missing origin'), { status: 2 });
      if (args.join(' ') === 'remote') return 'upstream\n';
      if (args.join(' ') === 'remote get-url upstream') return 'https://github.com/org/project.git\n';
      throw new Error(`Unexpected git args: ${args.join(' ')}`);
    };

    expect(runGhProxy(['pr', 'list'], '/work', f.options)).toBe(0);
    expect(gitCalls).toEqual([
      ['config', '--local', '--get-regexp', '^remote\\..*\\.gh-resolved$'],
      ['remote', 'get-url', 'origin'],
      ['remote'],
      ['remote', 'get-url', 'upstream'],
    ]);
    expect(f.calls.find(call => call.type === 'selected')).toBeDefined();
  });

  test('fails closed when explicit destinations conflict or omit a value', () => {
    const missing = fixture({ automatic: true });
    expect(runGhProxy(['api', 'user', '--hostname'], '/work', missing.options)).toBe(1);
    expect(missing.calls).toEqual([]);

    const conflict = fixture({ automatic: true });
    expect(runGhProxy(['api', '--hostname', 'github.com', 'https://enterprise.example/x'], '/work', conflict.options)).toBe(1);
    expect(conflict.calls).toEqual([]);
  });

  test('routes an enabled GitHub.com repository with exact argv and child status', () => {
    const f = fixture({ automatic: true });
    f.options.createContext = (_root, contextOptions) => ({
      bound: true,
      runChild: (command, args, childOptions) => {
        f.calls.push({ type: 'selected', command, args, options: childOptions, baseEnv: contextOptions.baseEnv });
        return { status: 7, signal: null };
      },
    });
    const args = ['pr', 'create', '--title', 'spaces & symbols'];
    expect(runGhProxy(args, '/work', f.options)).toBe(7);
    expect(f.calls).toEqual([{ type: 'selected', command: '/real/gh', args, options: {
      cwd: '/work', stdio: 'inherit', shell: false,
    }, baseEnv: { PATH: 'kept', GH_TOKEN: 'ambient' } }]);
  });

  test('fails closed when an enabled clone has no account binding', () => {
    const f = fixture({ automatic: true });
    f.options.createContext = () => ({ bound: false });
    expect(runGhProxy(['pr', 'list'], '/work', f.options)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  test('fails closed when the enabled clone is absent from the router registry', () => {
    const f = fixture({ automatic: true });
    f.options.assertRegistered = () => { throw new Error('not registered'); };
    expect(runGhProxy(['pr', 'list'], '/work', f.options)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  test('returns command-not-found without clone lookup when native gh is missing', () => {
    const f = fixture({ automatic: true });
    f.options.resolveExecutable = () => null;
    const errors = [];
    f.options.writeError = value => errors.push(value);
    expect(runGhProxy(['api', 'user'], '/work', f.options)).toBe(127);
    expect(f.calls).toEqual([]);
    expect(errors.join('')).toContain('GitHub CLI');
  });

  test('maps child signals to conventional exit codes', () => {
    const f = fixture();
    f.options.spawnSync = () => ({ status: null, signal: 'SIGTERM' });
    expect(runGhProxy(['repo', 'view'], '/repo', f.options)).toBe(143);
  });

  test('skips marked Forge routers while resolving native gh', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gh-proxy-'));
    const proxyDir = path.join(root, 'proxy');
    const realDir = path.join(root, 'real');
    fs.mkdirSync(proxyDir);
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(proxyDir, 'gh.cmd'), '@rem forge-gh-router-v1\r\n');
    fs.writeFileSync(path.join(realDir, 'gh.exe'), 'fake');
    try {
      expect(resolveRealGh({
        platform: 'win32', pathEnv: [proxyDir, realDir].join(path.delimiter), pathExt: '.CMD;.EXE',
        ownPath: '/$bunfs/root/forge.exe',
      })).toBe(path.join(realDir, 'gh.exe'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
