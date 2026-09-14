'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { flagTakesValue, resolveRealGh, runGhProxy } = require('../lib/gh-proxy');

function fixture({ automatic = false } = {}) {
  const calls = [];
  const spawnResult = { status: 0, signal: null };
  const options = {
    baseEnv: { PATH: 'kept', GH_TOKEN: 'ambient', FORGE_GH_PROXY_ACTIVE: '1' },
    readCommandHelp: () => [
      '  -b, --body string  Supply a body',
      '  -d, --draft  Filter drafts',
      '  -H, --header key:value  Add a HTTP request header',
      '      --paginate  Fetch every page',
      '  -w, --web  Open in a browser',
    ].join('\n'),
    readAliases: () => '',
    readExtensions: () => '',
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
    resolveLocalTarget: () => ({ hostname: 'github.com', repository: 'org/project' }),
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
  ])('passes an explicit non-GitHub hostname through without the selected token: %j', (...hostnameArgs) => {
    const f = fixture({ automatic: true });
    const args = ['api', ...hostnameArgs, 'user'];
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(false);
    expect(f.calls[0]).toMatchObject({ type: 'spawn', args, options: { env: { PATH: 'kept', GH_TOKEN: 'ambient' } } });
  });

  test('passes an ambient enterprise host through unless an explicit GitHub.com host overrides it', () => {
    const passthrough = fixture({ automatic: true });
    passthrough.options.baseEnv.GH_HOST = 'enterprise.example';
    expect(runGhProxy(['api', 'user'], '/work', passthrough.options)).toBe(0);
    expect(passthrough.calls.some(call => call.type === 'context')).toBe(false);

    const selected = fixture({ automatic: true });
    selected.options.baseEnv.GH_HOST = 'enterprise.example';
    expect(runGhProxy(['api', '--hostname', 'github.com', 'user'], '/work', selected.options)).toBe(0);
    expect(selected.calls.some(call => call.type === 'context')).toBe(true);

    const empty = fixture({ automatic: true });
    empty.options.baseEnv.GH_HOST = '';
    expect(runGhProxy(['api', 'user'], '/work', empty.options)).toBe(0);
    expect(empty.calls.some(call => call.type === 'context')).toBe(true);
  });

  test('recognizes enterprise selectors after valueless flags', () => {
    const f = fixture({ automatic: true });
    const args = ['api', '--paginate', '--hostname', 'enterprise.example', 'user'];
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(false);
    expect(f.calls[0]).toMatchObject({ type: 'spawn', args });
  });

  test('uses the last repeated hostname selector', () => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(['api', '--hostname', 'enterprise.example', '--hostname', 'github.com', 'user'], '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(true);

    const enterprise = fixture({ automatic: true });
    expect(runGhProxy(['api', '--hostname=github.com', '--hostname=enterprise.example', 'user'], '/work', enterprise.options)).toBe(0);
    expect(enterprise.calls.some(call => call.type === 'context')).toBe(false);
  });

  test('fails closed when a hostname value is missing', () => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(['api', 'user', '--hostname'], '/work', f.options)).toBe(1);
    expect(f.calls.some(call => call.type === 'context' || call.type === 'spawn')).toBe(false);
  });

  test.each([
    ['--repo'], ['-R'], ['--repo', '--hostname', 'github.com'], ['-R', '--hostname', 'github.com'],
  ])('fails closed when a repository value is missing: %j', (...args) => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(['pr', 'view', ...args], '/work', f.options)).toBe(1);
    expect(f.calls.some(call => call.type === 'context' || call.type === 'spawn')).toBe(false);
  });

  test('preserves GH_REPO only for the selected native gh child', () => {
    const calls = [];
    const options = {
      baseEnv: { GH_TOKEN: 'ambient', GH_REPO: 'owner/other-repo' },
      readAliases: () => '',
      readExtensions: () => '',
      readAuto: () => true,
      resolveExecutable: () => '/real/gh',
      spawnSync: (command, args, spawnOptions) => {
        calls.push({ command, args, env: spawnOptions.env });
        return { status: 0, signal: null };
      },
      createContext: (_root, contextOptions) => ({
        bound: true,
        runChild: (command, args, childOptions) => contextOptions.childRunner(command, args, {
          ...childOptions, env: { GH_TOKEN: 'selected', GH_HOST: 'github.com' },
        }),
      }),
    };

    expect(runGhProxy(['issue', 'view'], '/work', options)).toBe(0);
    expect(calls).toEqual([{ command: '/real/gh', args: ['issue', 'view'], env: {
      GH_TOKEN: 'selected', GH_HOST: 'github.com', GH_REPO: 'owner/other-repo',
    } }]);
  });

  test('treats an empty GH_REPO as unset', () => {
    const f = fixture({ automatic: true });
    f.options.baseEnv.GH_REPO = '';
    expect(runGhProxy(['issue', 'view'], '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(true);
  });

  test('reads mixed-case target selectors on Windows', () => {
    const f = fixture({ automatic: true });
    f.options.platform = 'win32';
    f.options.baseEnv.Gh_Host = 'enterprise.example';
    expect(runGhProxy(['api', 'user'], '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(false);

    const empty = fixture({ automatic: true });
    empty.options.platform = 'win32';
    empty.options.baseEnv.Gh_Host = '';
    expect(runGhProxy(['api', 'user'], '/work', empty.options)).toBe(0);
    expect(empty.calls.some(call => call.type === 'context')).toBe(true);
  });

  test.each([
    { args: ['issue', 'view'], repository: 'enterprise.example/owner/repo' },
    { args: ['pr', 'view', '-R', 'enterprise.example/owner/repo'] },
    { args: ['pr', 'view', '-R=enterprise.example/owner/repo'] },
    { args: ['pr', 'view', '--repo', 'enterprise.example/owner/repo'] },
    { args: ['pr', 'view', '--repo=enterprise.example/owner/repo'] },
    { args: ['pr', 'list', '--draft', '-R', 'enterprise.example/owner/repo'] },
    { args: ['pr', 'list', '-Renterprise.example/owner/repo'] },
    { args: ['pr', 'list', '-dR', 'enterprise.example/owner/repo'] },
  ])('passes host-qualified repository targets through: $args', ({ args, repository }) => {
    const f = fixture({ automatic: true });
    if (repository && !args.some(arg => arg === '-R' || arg.startsWith('--repo='))) f.options.baseEnv.GH_REPO = repository;
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(false);
  });

  test.each([
    [['repo', 'view', 'enterprise.example/owner/repo'], false],
    [['repo', 'view', '--web', 'enterprise.example/owner/repo'], false],
    [['repo', 'view', '--', 'enterprise.example/owner/repo'], false],
    [['repo', 'view', 'github.com/owner/repo'], true],
    [['repo', 'view', 'owner/repo'], true],
    [['repo', 'clone', 'owner/repo', 'enterprise.example/owner/repo'], true],
  ])('routes the documented positional repository only: %j', (args, selected) => {
    const f = fixture({ automatic: true });
    f.options.readCommandHelp = () => args[1] === 'clone'
      ? 'USAGE\n  gh repo clone <repository> [<directory>]'
      : 'USAGE\n  gh repo view [<repository>] [flags]\n\nFLAGS\n  -w, --web  Open in a browser';
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(selected);
  });

  test('fails closed when a positional repository conflicts with an explicit hostname', () => {
    const f = fixture({ automatic: true });
    f.options.readCommandHelp = () => 'USAGE\n  gh repo view [<repository>] [flags]';
    expect(runGhProxy(['repo', 'view', '--hostname', 'github.com', 'enterprise.example/owner/repo'], '/work', f.options)).toBe(1);
    expect(f.calls.some(call => call.type === 'context' || call.type === 'spawn')).toBe(false);
  });

  test.each([
    ['--version'], ['--help'], ['-h'], ['version'], ['help'], ['pr', 'create', '--help'], ['pr', 'create', '-h'],
    ['pr', 'create', '-h=false', '-h'], ['pr', 'create', '-h=0', '-h=1'],
    ['completion', '-s', 'bash'], ['config', 'get', 'git_protocol'], ['alias', 'list'],
    ['pr', 'list', '--web', '--help'], ['pr', 'list', '-wh'],
  ])('passes local-only gh invocation through without account resolution: %j', (...args) => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(false);
  });

  test('parses native help declarations without copying GitHub CLI flag tables', () => {
    const help = '  -d, --draft  Filter drafts\n  -b, --body string  Supply a body\n';
    expect(flagTakesValue(help, '--draft')).toBe(false);
    expect(flagTakesValue(help, '-b')).toBe(true);
    expect(flagTakesValue(help, '--unknown')).toBeNull();
  });

  test('loads option arity from the installed command help only when needed', () => {
    const f = fixture({ automatic: true });
    const helpCalls = [];
    delete f.options.readCommandHelp;
    f.options.execFileSync = (command, args) => {
      helpCalls.push({ command, args });
      return '  -d, --draft  Filter drafts\n  -R, --repo [HOST/]OWNER/REPO  Select repository\n';
    };
    const args = ['pr', 'list', '--draft', '-R', 'enterprise.example/owner/repo'];
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(helpCalls).toEqual([{ command: '/real/gh', args: ['help', 'pr', 'list'] }]);
    expect(f.calls.some(call => call.type === 'context')).toBe(false);
  });

  test('stops before either account when ambiguous option arity is unavailable', () => {
    const f = fixture({ automatic: true });
    const errors = [];
    f.options.readCommandHelp = () => '';
    f.options.writeError = value => errors.push(value);
    expect(runGhProxy(['pr', 'list', '--unknown', '--help'], '/work', f.options)).toBe(1);
    expect(f.calls.some(call => call.type === 'spawn' || call.type === 'context')).toBe(false);
    expect(errors.join('')).toContain('could not select');
  });

  test.each([
    ['issue', 'create', '--body', '--help'],
    ['issue', 'create', '--body', '-h'],
    ['issue', 'create', '--body', '--help=true'],
    ['issue', 'create', '-b-h'],
    ['issue', 'create', '-dh=false'],
    ['issue', 'create', '-h=false'],
    ['issue', 'create', '-h=0'],
    ['issue', 'create', '-h', '-h=false'],
    ['issue', 'create', '--help', '--help=false'],
    ['api', '-H', '-h'],
    ['issue', 'create', '--body', '--version'],
    ['issue', 'create', '--body', '--hostname=enterprise.example'],
    ['issue', 'create', '--body', '--hostname', 'enterprise.example'],
    ['issue', 'create', '--body', '--repo=enterprise.example/owner/repo'],
    ['issue', 'create', '--body', '--repo', 'enterprise.example/owner/repo'],
    ['issue', 'create', '--body', '-R', 'enterprise.example/owner/repo'],
    ['issue', 'create', '--body', '-Renterprise.example/owner/repo'],
    ['issue', 'create', '-bRenterprise.example/owner/repo'],
    ['release', 'create', 'v1', '--', 'asset.zip', '--help'],
    ['release', 'create', 'v1', '--', '--version'],
    ['release', 'create', 'v1', '--', '--hostname=enterprise.example'],
    ['release', 'create', 'v1', '--', '--repo=enterprise.example/owner/repo'],
  ])('keeps option-looking values on the selected account route: %j', (...args) => {
    const f = fixture({ automatic: true });
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(true);
    expect(f.calls.some(call => call.type === 'spawn')).toBe(false);
    expect(f.calls.find(call => call.type === 'selected').args).toEqual(args);
  });

  test('uses the last repeated repository selector', () => {
    const f = fixture({ automatic: true });
    const args = ['pr', 'list', '-Renterprise.example/owner/repo', '-R', 'owner/repo'];
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(true);
  });

  test.each([
    ['https://enterprise.example/owner/repo/pull/1', false],
    ['https://gist.github.com/owner/id', true],
  ])('routes positional resource URL %s by its host', (url, selected) => {
    const f = fixture({ automatic: true });
    f.options.readCommandHelp = () => 'USAGE\n  gh pr view [<number> | <url> | <branch>]';
    expect(runGhProxy(['pr', 'view', url], '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(selected);
  });

  test.each(['<discussion-url>', '<comment-url>', '<comment_url>', '<pr-url>'])('recognizes named URL placeholder %s', placeholder => {
    const f = fixture({ automatic: true });
    f.options.readCommandHelp = () => `USAGE\n  gh discussion view [${placeholder}]`;
    expect(runGhProxy(['discussion', 'view', 'https://enterprise.example/owner/repo/discussions/1'], '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(false);
  });

  test('ignores URL placeholders outside command usage declarations', () => {
    const f = fixture({ automatic: true });
    f.options.readCommandHelp = () => 'USAGE\n  gh issue create [flags]\n\nEXAMPLES\n  Open <discussion-url> in a browser';
    expect(runGhProxy(['issue', 'create', 'https://enterprise.example/not-a-target'], '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(true);
  });

  test('canonicalizes a verified local SSH alias for the selected native gh child', () => {
    const calls = [];
    const f = fixture({ automatic: true });
    delete f.options.resolveLocalTarget;
    f.options.execFileSync = (command, args) => {
      calls.push({ command, args });
      if (command === 'git' && args[0] === 'config') throw Object.assign(new Error('unset'), { status: 1 });
      if (command === 'git') return 'git@work-github:org/project.git';
      if (command === 'ssh') return 'hostname github.com\nuser git\n';
      throw new Error('unexpected command');
    };
    f.options.createContext = (_root, contextOptions) => ({
      bound: true,
      runChild: (command, args, childOptions) => contextOptions.childRunner(command, args, {
        ...childOptions, env: { GH_TOKEN: 'selected', GH_HOST: 'github.com' },
      }),
    });

    expect(runGhProxy(['pr', 'list'], '/work', f.options)).toBe(0);
    expect(calls.map(call => [call.command, call.args[0]])).toEqual([['git', 'config'], ['git', 'remote'], ['ssh', '-G']]);
    expect(f.calls.find(call => call.type === 'spawn').options.env).toMatchObject({
      GH_TOKEN: 'selected', GH_HOST: 'github.com', GH_REPO: 'github.com/org/project',
    });
  });

  test('canonicalizes the local SSH alias when GH_HOST already selects GitHub.com', () => {
    const calls = [];
    const f = fixture({ automatic: true });
    f.options.baseEnv.GH_HOST = 'github.com';
    f.options.resolveLocalTarget = () => ({ hostname: 'github.com', repository: 'org/project' });
    f.options.createContext = (_root, contextOptions) => ({
      bound: true,
      runChild: (command, args, childOptions) => contextOptions.childRunner(command, args, {
        ...childOptions, env: { GH_TOKEN: 'selected', GH_HOST: 'github.com' },
      }),
    });
    f.options.spawnSync = (command, args, spawnOptions) => {
      calls.push({ command, args, env: spawnOptions.env });
      return { status: 0, signal: null };
    };

    expect(runGhProxy(['pr', 'list'], '/work', f.options)).toBe(0);
    expect(calls[0].env.GH_REPO).toBe('github.com/org/project');
  });

  test('respects the GitHub CLI default remote and bypasses an enterprise SSH alias', () => {
    const f = fixture({ automatic: true });
    delete f.options.resolveLocalTarget;
    f.options.execFileSync = (command, args) => {
      if (command === 'git' && args[0] === 'config') return 'remote.upstream.gh-resolved base\n';
      if (command === 'git') {
        expect(args).toEqual(['remote', 'get-url', 'upstream']);
        return 'git@enterprise-alias:org/project.git';
      }
      if (command === 'ssh') return 'hostname ghe.example\nuser git\n';
      throw new Error('unexpected command');
    };

    expect(runGhProxy(['pr', 'list'], '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(false);
  });

  test('fails closed when the local SSH alias cannot be resolved', () => {
    const f = fixture({ automatic: true });
    f.options.resolveLocalTarget = () => { throw new Error('unresolved'); };
    expect(runGhProxy(['pr', 'list'], '/work', f.options)).toBe(1);
    expect(f.calls.some(call => call.type === 'context' || call.type === 'spawn')).toBe(false);
  });

  test('does not treat URL-looking option values as resource targets and inspects positionals after the delimiter', () => {
    const f = fixture({ automatic: true });
    f.options.readCommandHelp = () => 'USAGE\n  gh pr comment [<number> | <url> | <branch>]\n\nFLAGS\n  -b, --body string  Body';
    expect(runGhProxy(['pr', 'comment', '--body', 'https://enterprise.example/not-a-target'], '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'context')).toBe(true);

    const delimited = fixture({ automatic: true });
    delimited.options.readCommandHelp = () => 'USAGE\n  gh pr view [<number> | <url> | <branch>]';
    expect(runGhProxy(['pr', 'view', '--', 'https://enterprise.example/owner/repo/pull/1'], '/work', delimited.options)).toBe(0);
    expect(delimited.calls.some(call => call.type === 'context')).toBe(false);
  });

  test('fails closed when explicit target hosts conflict', () => {
    const f = fixture({ automatic: true });
    f.options.readCommandHelp = () => 'USAGE\n  gh pr view [<number> | <url> | <branch>]';
    expect(runGhProxy(['pr', 'view', '--hostname', 'github.com', 'https://enterprise.example/owner/repo/pull/1'], '/work', f.options)).toBe(1);
    expect(f.calls.some(call => call.type === 'context' || call.type === 'spawn')).toBe(false);
  });

  test.each(['enterprise-view', 'shell-view'])('fails closed before executing configured alias %s', alias => {
    const f = fixture({ automatic: true });
    const errors = [];
    f.options.readAliases = () => 'enterprise-view: pr list -R enterprise.example/owner/repo\nshell-view: !gh api --hostname enterprise.example user';
    f.options.writeError = value => errors.push(value);
    expect(runGhProxy([alias, '--limit', '1'], '/work', f.options)).toBe(1);
    expect(f.calls.some(call => call.type === 'spawn' || call.type === 'context')).toBe(false);
    expect(errors.join('')).toContain('expanded gh command');
  });

  test.each([
    [['enterprise-tool', 'run'], 'gh enterprise-tool\towner/gh-enterprise-tool\tv1.0.0'],
    [['extension', 'exec', 'enterprise-tool', 'run'], 'gh enterprise-tool\towner/gh-enterprise-tool\tv1.0.0'],
    [['ext', 'exec', 'enterprise-tool', 'run'], 'gh enterprise-tool\towner/gh-enterprise-tool\tv1.0.0'],
  ])('fails closed before executing installed extension: %j', (args, extensions) => {
    const f = fixture({ automatic: true });
    f.options.readExtensions = () => extensions;
    expect(runGhProxy(args, '/work', f.options)).toBe(1);
    expect(f.calls.some(call => call.type === 'spawn' || call.type === 'context')).toBe(false);
  });

  test('fails closed without exposing an alias-inspection error', () => {
    const f = fixture({ automatic: true });
    const errors = [];
    f.options.readAliases = () => { throw new Error('alias-output-canary'); };
    f.options.writeError = value => errors.push(value);
    expect(runGhProxy(['custom'], '/work', f.options)).toBe(1);
    expect(f.calls.some(call => call.type === 'spawn' || call.type === 'context')).toBe(false);
    expect(errors.join('')).not.toContain('alias-output-canary');
  });

  test('does not inspect aliases when automatic routing is disabled', () => {
    const f = fixture();
    f.options.readAliases = () => { throw new Error('should not inspect'); };
    f.options.readExtensions = () => { throw new Error('should not inspect'); };
    expect(runGhProxy(['custom'], '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'spawn')).toBe(true);
  });

  test.each([['extension', 'list'], ['extensions', 'list'], ['ext', 'list']])('keeps extension management native: %j', (...args) => {
    const f = fixture({ automatic: true });
    f.options.readExtensions = () => { throw new Error('should not inspect'); };
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'spawn')).toBe(true);
  });

  test('fails closed without exposing an extension-inspection error', () => {
    const f = fixture({ automatic: true });
    const errors = [];
    f.options.readExtensions = () => { throw new Error('extension-output-canary'); };
    f.options.writeError = value => errors.push(value);
    expect(runGhProxy(['custom'], '/work', f.options)).toBe(1);
    expect(f.calls.some(call => call.type === 'spawn' || call.type === 'context')).toBe(false);
    expect(errors.join('')).not.toContain('extension-output-canary');
  });

  test('treats gh api -H as a header and routes through the selected account', () => {
    const f = fixture({ automatic: true });
    const args = ['api', '-H', 'Accept: application/vnd.github+json', 'user'];
    expect(runGhProxy(args, '/work', f.options)).toBe(0);
    expect(f.calls.some(call => call.type === 'spawn')).toBe(false);
    expect(f.calls).toContainEqual({ type: 'context', root: '/work', env: { PATH: 'kept', GH_TOKEN: 'ambient' } });
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
      readAliases: () => '',
      readExtensions: () => '',
      readAuto: () => true,
      resolveExecutable: () => '/real/gh',
      resolveLocalTarget: () => ({ hostname: 'github.com', repository: 'org/project' }),
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
      expect(resolveRealGh({
        platform: 'win32', pathEnv: [proxyDir, realDir].join(path.delimiter), pathExt: '.CMD;.EXE',
        ownPath: '/$bunfs/root/forge.exe',
      }))
        .toBe(path.join(realDir, 'gh.exe'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips invalid candidates and returns null when only a marked router exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gh-proxy-'));
    const invalidDir = path.join(root, 'invalid');
    const routerDir = path.join(root, 'router');
    fs.mkdirSync(invalidDir);
    fs.mkdirSync(routerDir);
    fs.mkdirSync(path.join(invalidDir, 'gh'));
    fs.writeFileSync(path.join(routerDir, 'gh'), '#!/bin/sh\n# forge-gh-router-v1\n', { mode: 0o755 });
    try {
      expect(resolveRealGh({
        platform: 'linux', pathEnv: [invalidDir, routerDir].join(path.delimiter), ownPath: '/$bunfs/root/forge',
      })).toBeNull();
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
