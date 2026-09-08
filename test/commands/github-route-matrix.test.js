'use strict';

const { describe, test, expect, beforeEach, afterEach, spyOn, mock } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { prepareGithubAccount } = require('../../lib/github-context');
const { executeCommand } = require('../../lib/commands/_registry');
const { getTestCandidatesForChangedFile } = require('../../lib/commands/test');
const pr = require('../../lib/commands/pr');
const ship = require('../../lib/commands/ship');
const merge = require('../../lib/commands/merge');
const shepherd = require('../../lib/commands/shepherd');
const clean = require('../../lib/commands/clean');
const team = require('../../lib/commands/team');
const reconcile = require('../../lib/pr-monitor/reconcile-executor');

const ROOT = path.resolve(__dirname, '../..');
const BRIDGE = 'scripts/github-context-bridge.sh';
const SUITE = 'test/commands/github-route-matrix.test.js';
const CANARY = 'test-only-selected-account-canary';
const HEAD = 'a'.repeat(40);
const tempRoots = [];

beforeEach(() => {
  spyOn(process, 'exit').mockImplementation(() => { throw new Error('Unexpected process exit in isolated route test'); });
});

afterEach(() => {
  mock.restore();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function assertNotSelected(value) {
  expect(JSON.stringify(value ?? {}).includes(CANARY)).toBe(false);
}

function selectedContext(reply = () => '{}') {
  const calls = [];
  const context = prepareGithubAccount(ROOT, 'work', { baseEnv: { RETAINED: 'yes' }, runner: (cmd, args, options) => {
    expect(cmd).toBe('gh');
    if (args[0] === 'auth') return CANARY;
    expect(options.env.GH_TOKEN === CANARY).toBe(true);
    expect(options.env.GITHUB_TOKEN === CANARY).toBe(true);
    expect(options.env.GH_HOST).toBe('github.com');
    if (args[0] === 'api' && args.includes('user')) return JSON.stringify({ login: 'work' });
    calls.push({ args, cwd: options.cwd });
    return reply(args);
  } });
  return { context, calls };
}

function unboundContext() {
  return { bound: false, runGh: () => { throw new Error('unbound context must not replace native runners'); } };
}

function shipGit(cmd, args, options) {
  expect(cmd).toBe('git');
  assertNotSelected(options);
  if (args[0] === 'symbolic-ref') return 'refs/remotes/upstream/main';
  if (args[0] === 'rev-list') return '0 1';
  if (args[0] === 'diff') throw Object.assign(new Error('diff'), { status: 1 });
  if (args.includes('--abbrev-ref')) return 'feat/test';
  return 'ok';
}

describe('foreground GitHub account route matrix', () => {
  test.each([ship, merge, shepherd, clean])('%s declares GitHub context', mod => {
    expect(mod.githubAuth).toBe(true);
  });

  test.each([
    [['ship', 'feature'], true], [['merge', '42'], true], [['shepherd', '42'], true],
    [['-p', '/repo', 'ship', 'feature'], true], [['preflight'], false], [['help'], false], [[], false],
  ])('pr predicate matches its delegated route: %j', (args, required) => {
    expect(pr.githubAuth(args, {})).toBe(required);
  });

  test.each([
    [['workload', '--me'], true], [['workload', '--developer=other', '--me'], true],
    [['workload', '--me\r'], true], [['add'], true], [['verify'], true], [['sync'], true], [['claim', 'id'], true],
    [[], false], [['help'], false], [['epic', 'id'], false], [['workload'], false], [['workload', '--developer=other'], false],
  ])('team predicate matches GitHub use: %j', (args, required) => {
    expect(team.githubAuth(args, {})).toBe(required);
  });

  test.each(['ship', 'merge', 'shepherd'])('pr %s receives exactly one prepared context', async sub => {
    const mod = { ship, merge, shepherd }[sub];
    const context = { bound: true };
    let preparations = 0;
    const handler = spyOn(mod, 'handler').mockImplementation(async (_a, _f, _r, opts) => {
      expect(opts.githubContext).toBe(context);
      return { success: true };
    });
    const result = await executeCommand(new Map([['pr', pr]]), 'pr', [sub, '42'], {}, ROOT, {
      skipEnsureHome: true,
      prepareGithubContext: () => { preparations++; return context; },
    });
    expect(result.success).toBe(true);
    expect(preparations).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test.each([[['help']], [['preflight']], [['ship', '--help']]])('pr local/help route does not prepare: %j', async args => {
    const preflight = require('../../lib/commands/preflight');
    spyOn(preflight, 'handler').mockResolvedValue({ success: true });
    let preparations = 0;
    const result = await executeCommand(new Map([['pr', pr]]), 'pr', args, {}, ROOT, {
      skipEnsureHome: true, prepareGithubContext: () => { preparations++; throw new Error('must not prepare'); },
    });
    expect(result.success).toBe(true);
    expect(preparations).toBe(0);
  });

  test('ship scopes selected credentials to gh and preserves project cwd and wake inputs', async () => {
    expect(ship.handler.toString()).toContain('deps.exec');
    const { context, calls } = selectedContext(args => args[0] === '--version' ? 'gh version' : 'https://github.com/o/r/pull/42');
    const before = { ...process.env };
    let wake;
    const result = await ship.handler(['feature', 'feat: route credentials'], {}, ROOT, {
      githubContext: context, exec: shipGit, fireAndForget: value => { wake = value; assertNotSelected(value); },
      createPr: options => {
        expect(options.exec).toBe(shipGit);
        expect(options.githubContext).toBe(context);
        expect(options.cwd).toBe(ROOT);
        return ship.createPR(options);
      },
    });
    expect(result.success).toBe(true);
    expect(calls.map(call => call.args[0])).toEqual(['--version', 'pr']);
    expect(calls.every(call => call.cwd === ROOT)).toBe(true);
    expect(wake).toEqual({ projectRoot: ROOT, dryRun: false });
    assertNotSelected(result);
    expect(isDeepStrictEqual({ ...process.env }, before)).toBe(true);
  });

  test('ship unbound preserves the caller native exec for both Git and gh', async () => {
    const calls = [];
    const result = await ship.createPR({ title: 'feat: native route', body: 'body', cwd: ROOT, githubContext: unboundContext(),
      exec: (cmd, args, options) => {
        calls.push(cmd);
        return cmd === 'git' ? shipGit(cmd, args, options) : 'https://github.com/o/r/pull/42';
      } });
    expect(result.success).toBe(true);
    expect(calls.filter(cmd => cmd === 'gh')).toHaveLength(2);
  });

  test('bound ship failure never exposes selected credentials or raw subprocess diagnostics', async () => {
    const { context } = selectedContext(() => { throw new Error(CANARY); });
    const result = await ship.createPR({
      title: 'feat: safe errors', body: 'body', githubContext: context,
      exec: () => { throw new Error('Git must not run after failed gh check'); },
    });
    expect(result.success).toBe(false);
    assertNotSelected(result);
  });

  test.each([true, false])('merge changes only its gh seam (bound=%s)', async bound => {
    const selected = selectedContext();
    const nativeCalls = [];
    let observedEnv;
    const env = Object.freeze({ FORGE_ACTOR: 'test-actor', FORGE_SESSION_ID: 'test-session', RETAINED: 'yes' });
    const result = await merge.handler(['42', '--auto', '--expect-head', HEAD, '--issue', '36230258-7b64-4de0-8683-fd8b8eabab51'], {}, ROOT, {
      githubContext: bound ? selected.context : unboundContext(), env,
      gh: args => { nativeCalls.push(args); return '{}'; },
      loadConfig: () => ({ merge: { auto: { enabled: true, rules: ['checks_green'] } } }),
      resolveLocalRepository: () => 'o/r',
      verifyIssueOwnership: input => {
        observedEnv = input.env;
        return { owned: true, actor: 'test-actor', claimedBy: 'test-actor', sessionId: 'test-session', expired: false };
      },
      verifyPrIssueBinding: () => ({ bound: false, missing: true }),
    });
    expect(result.success).toBe(false);
    expect(observedEnv).toEqual(env);
    assertNotSelected(observedEnv);
    expect(bound ? selected.calls.length > 0 : nativeCalls.length > 0).toBe(true);
    expect(bound ? nativeCalls.length : selected.calls.length).toBe(0);
  });

  test.each([true, false])('shepherd main keeps Git and local review separate (bound=%s)', async bound => {
    const selected = selectedContext();
    const nativeGh = () => '{}';
    const git = (cmd, _args, options) => { expect(cmd).toBe('git'); assertNotSelected(options); return HEAD; };
    const result = await shepherd.handler(['42', '--pull', '--json'], {}, ROOT, {
      githubContext: bound ? selected.context : unboundContext(), gh: nativeGh, git,
      buildContext: async input => {
        expect(input.git).toBe(git);
        if (!bound) expect(input.gh).toBe(nativeGh);
        input.gh('gh', ['repo', 'view']); input.git('git', ['rev-parse', 'HEAD']);
        return { pr: '42', owner: 'o', repo: 'r' };
      },
      gatherPull: async input => { input.runGh(['pr', 'checks', '42']); return { failures: [] }; },
    });
    expect(result.success).toBe(true);
    expect(selected.calls.length).toBe(bound ? 2 : 0);
    assertNotSelected(result);
  });

  test('shepherd monitor context routes gh but never falls back to gh for Git', async () => {
    const { context, calls } = selectedContext();
    const built = await shepherd.buildMonitorContext('42', ROOT, {
      githubContext: context, gh: () => { throw new Error('native gh must not run'); },
      git: () => { throw new Error('Git must not run in this monitor fixture'); },
      dir: 'unused', store: {}, gitCommonDir: 'unused',
      buildContext: async input => {
        expect(input.git).not.toBe(input.gh);
        input.gh('gh', ['repo', 'view']);
        return { pr: '42', owner: 'o', repo: 'r' };
      },
    });
    expect(typeof built.gather).toBe('function');
    expect(calls).toHaveLength(1);
  });

  test('shepherd local preflight and convergence helpers receive no selected environment', async () => {
    const { context, calls } = selectedContext();
    let preflightCalls = 0;
    const result = await shepherd.handler(['42'], {}, ROOT, {
      githubContext: context,
      gh: () => { throw new Error('native gh is forbidden'); },
      git: (cmd, args, options) => { expect(cmd).toBe('git'); assertNotSelected(options); return args[0] === 'status' ? '' : HEAD; },
      buildContext: async ({ gh }) => {
        gh('gh', ['repo', 'view']);
        return { pr: '42', owner: 'o', repo: 'r', headSha: HEAD, localHead: HEAD };
      },
      runLocalPreflight: async input => {
        preflightCalls++;
        assertNotSelected(input);
        expect(input.githubContext).toBeUndefined();
        expect(input.env).toBeUndefined();
        return { status: 'PASS', blocking: false };
      },
      runPass: async input => { assertNotSelected(input); return { state: 'PENDING', actions: [] }; },
      collectConvergenceEvidence: async input => { assertNotSelected(input); return { deltas: [], receiptIds: [] }; },
    });
    expect(result.success).toBe(true);
    expect(preflightCalls).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test('shepherd adoption lists with selected gh and launches credential-free watcher metadata', async () => {
    const { context, calls } = selectedContext(args => args[0] === 'repo' ? '{"nameWithOwner":"o/r"}' : '42\n');
    const started = [];
    const result = await shepherd.handler(['watch', '--adopt'], {}, ROOT, {
      githubContext: context, railEnabled: () => true, ownerOptions: {},
      gh: () => { throw new Error('native gh is forbidden in bound adoption'); },
      listOpenPrs: (repository, runner) => {
        expect(typeof runner).toBe('function');
        expect(typeof shepherd.defaultListOpenPrs).toBe('function');
        return shepherd.defaultListOpenPrs(repository, runner);
      },
      owner: { readMigrationGate: async () => ({ ok: true, gate: { state: 'complete' } }) },
      startWatcher: input => { started.push(input); assertNotSelected(input); return { started: true }; },
    });
    expect(result.adopted).toEqual([42]);
    expect(calls.map(call => call.args[0])).toEqual(['repo', 'pr']);
    expect(started).toHaveLength(1);
    expect(started[0].env).toBeUndefined();
  });

  test.each([true, false])('shepherd daemon scopes only runGh (bound=%s)', async bound => {
    const { context, calls } = selectedContext();
    const nativeRunGh = () => '{}';
    const env = { RETAINED: 'yes' };
    spyOn(reconcile, 'runDaemon').mockImplementation(async (_root, options) => {
      expect(options.env).toBe(env);
      assertNotSelected(options.env);
      if (!bound) expect(options.runGh).toBe(nativeRunGh);
      options.runGh(['repo', 'view']);
      return { ok: true };
    });
    const result = await shepherd.handler(['daemon'], {}, ROOT, {
      githubContext: bound ? context : unboundContext(), env, runGh: nativeRunGh,
    });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(bound ? 1 : 0);
  });

  test.each([true, false])('clean isolates only its merged-PR query (bound=%s)', async bound => {
    const { context, calls } = selectedContext(() => '[]');
    const nativeCalls = [];
    const result = await clean.handler([], { dryRun: true }, ROOT, {
      githubContext: bound ? context : unboundContext(),
      _exec: (cmd, args, options) => { nativeCalls.push(cmd); assertNotSelected(options); return args[0] === 'rev-parse' ? 'origin/main' : ''; },
      _fs: { existsSync: () => true, readdirSync: () => [{ name: 'feature', isDirectory: () => true }] },
      _isMerged: () => false,
    });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(bound ? 1 : 0);
    expect(nativeCalls.includes('gh')).toBe(!bound);
    expect(nativeCalls.includes('git')).toBe(true);
  });

  test.each([false, true])('team bridge construction uses this runtime without selected parent env (compiled=%s)', async compiled => {
    expect(team.handleTeam.toString()).toContain('deps.execFileSync');
    const { context } = selectedContext();
    const before = { ...process.env };
    let call;
    const result = await team.handler(['verify'], {}, ROOT, {
      githubContext: context, isCompiledBinary: () => compiled,
      execFileSync: (...values) => { call = values; },
    });
    expect(result.success).toBe(true);
    expect(call[1]).toEqual([path.join(ROOT, 'scripts', 'forge-team', 'index.sh'), 'verify']);
    expect(call[2].stdio).toBe('inherit');
    expect(call[2].cwd).toBe(ROOT);
    expect(call[2].env.GH_CMD).toBe(path.join(ROOT, BRIDGE).replace(/\\/g, '/'));
    expect(call[2].env.FORGE_GITHUB_RUNTIME).toBe(process.execPath.replace(/\\/g, '/'));
    expect(call[2].env.FORGE_GITHUB_ENTRY).toBe(compiled ? '' : path.join(ROOT, 'bin', 'forge.js').replace(/\\/g, '/'));
    assertNotSelected(call);
    expect(isDeepStrictEqual({ ...process.env }, before)).toBe(true);
  });

  test('unbound team does not install a bridge or change native Bash options', async () => {
    expect(team.handleTeam.toString()).toContain('deps.execFileSync');
    let call;
    await team.handler(['workload'], {}, ROOT, { githubContext: unboundContext(), execFileSync: (...values) => { call = values; } });
    expect(call[2]).toEqual({ stdio: 'inherit' });
  });

  test.each([false, true])('shipped bridge preserves exact argv, streams and status (compiled=%s)', compiled => {
    expect(fs.existsSync(path.join(ROOT, BRIDGE))).toBe(true);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gh-bridge-'));
    tempRoots.push(temp);
    const runtime = path.join(temp, 'runtime space & semi;.sh');
    fs.writeFileSync(runtime, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\ncat\nprintf "bridge stderr\\n" >&2\nexit 23\n');
    fs.chmodSync(runtime, 0o700);
    const entry = compiled ? '' : path.join(temp, 'installed space', 'bin', 'forge.js').replace(/\\/g, '/');
    const args = ['api', 'value with spaces', '$(literal);&', '--help', ''];
    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/usr/bin/bash';
    const result = spawnSync(bash, ['-c', 'exec "$GH_CMD" "$@"', 'bridge', ...args], {
      encoding: 'utf8', input: 'bridge stdin\n',
      env: {
        ...process.env,
        GH_CMD: path.join(ROOT, BRIDGE).replace(/\\/g, '/'),
        FORGE_GITHUB_RUNTIME: runtime.replace(/\\/g, '/'), FORGE_GITHUB_ENTRY: entry,
      },
    });
    expect(result.status).toBe(23);
    expect(result.stdout.replace(/\r/g, '')).toBe([...(compiled ? [] : [entry]), 'github', 'run', '--', 'gh', ...args, 'bridge stdin', ''].join('\n'));
    expect(result.stderr.replace(/\r/g, '')).toBe('bridge stderr\n');
  });

  test.each(['pr', 'ship', 'merge', 'shepherd', 'team', 'clean'])('%s changes retain their existing suite and route coverage', name => {
    const targets = getTestCandidatesForChangedFile(`lib/commands/${name}.js`);
    expect(targets).toContain(`test/commands/${name}.test.js`);
    expect(targets).toContain(SUITE);
  });

  test('bridge ships as an executable runtime asset and selects route regressions', () => {
    expect(require('../../package.json').files).toContain('scripts/');
    expect(require('../../lib/package-root').ASSET_ROOTS).toContain('scripts');
    expect(getTestCandidatesForChangedFile(BRIDGE)).toEqual([SUITE]);
  });
});
