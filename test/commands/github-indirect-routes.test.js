'use strict';

const { describe, test, expect, beforeEach, afterEach, spyOn, mock } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { isDeepStrictEqual } = require('node:util');
const { prepareGithubAccount } = require('../../lib/github-context');
const { executeCommand } = require('../../lib/commands/_registry');
const { getTestCandidatesForChangedFile } = require('../../lib/commands/test');
const { classifyPushTests, ALWAYS_RUN_RISK_TEST_TARGETS } = require('../../scripts/test');
const lifecycle = require('../../lib/pr-monitor/watch-lifecycle');
const reconcile = require('../../lib/pr-monitor/reconcile-executor');
const push = require('../../lib/commands/push');
const hooks = require('../../lib/commands/hooks');
const serve = require('../../lib/commands/serve');
const skill = require('../../lib/commands/skill');
const runtime = require('../../scripts/lib/behavioral-eval-runtime');

const ROOT = path.resolve(__dirname, '../..');
const CANARY = 'test-only-indirect-account-canary';
const HEAD = 'a'.repeat(40);
const ISSUE = '198bec40-0d65-42a8-b2c2-c682f44fdb22';
const SUITE = 'test/commands/github-indirect-routes.test.js';
const ambient = Object.freeze({ GH_TOKEN: CANARY, github_token: CANARY, Gh_Host: CANARY, RETAINED: 'yes' });
let originalEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  spyOn(process, 'exit').mockImplementation(() => { throw new Error('Unexpected process exit'); });
});
afterEach(() => {
  expect(isDeepStrictEqual({ ...process.env }, originalEnv)).toBe(true);
  mock.restore();
});
function clean(value) { expect(JSON.stringify(value).includes(CANARY)).toBe(false); }
function child() {
  const value = new EventEmitter();
  value.pid = 4242;
  value.unref = () => { value.unreferenced = true; };
  value.kill = () => { throw new Error('Unexpected kill'); };
  return value;
}
function selected(reply = () => '{}') {
  const calls = [];
  const context = prepareGithubAccount(ROOT, 'work', { baseEnv: { RETAINED: 'yes' }, runner: (cmd, args, options) => {
    expect(cmd).toBe('gh');
    if (args[0] === 'auth') return CANARY;
    expect(options.env.GH_TOKEN === CANARY && options.env.GITHUB_TOKEN === CANARY).toBe(true);
    if (args[0] === 'api' && args.includes('user')) return 'work';
    calls.push(args);
    return reply(args);
  } });
  return { context, calls };
}
function watcherOptions(overrides = {}) {
  return {
    prNumber: 7, repository: 'owner/repo', cwd: ROOT,
    readGithubAccount: () => 'work', env: ambient,
    owner: {
      readMigrationGate: async () => ({ ok: true, gate: { state: 'complete' } }),
      reserveStarting: async () => ({ ok: true, record: { generation: 'generation-7', startedAt: '2026-09-08T00:00:00.000Z' } }),
      abortStarting: async () => ({ ok: true }),
    },
    ...overrides,
  };
}

describe('indirect GitHub account boundaries', () => {
  test.each([push, hooks, serve, skill])('%s has no global GitHub guard', mod => {
    expect(mod.githubAuth).toBeUndefined();
  });

  test.each([false, true])('daemon re-enters public source/compiled CLI without ambient credentials (%s)', compiled => {
    let call; let reads = 0;
    const worker = child();
    const result = reconcile.launchDaemon({
      projectRoot: path.join(ROOT, '.worktrees', 'temporary'), gitCommonDir: path.join(ROOT, '.git'),
      env: ambient, readGithubAccount: () => { reads++; return 'work'; }, isCompiledBinary: () => compiled,
      spawnProcess: (...values) => { call = values; return worker; }, writeDaemonDiagnostic: () => {},
    });
    expect(result.launched).toBe(true);
    expect(reads).toBe(1);
    expect(call[0]).toBe(process.execPath);
    expect(call[1]).toEqual([...(compiled ? [] : [lifecycle.forgeBin()]), 'shepherd', 'daemon']);
    expect(call[2]).toEqual({ cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: { RETAINED: 'yes' } });
    expect(worker.unreferenced).toBe(true);
    clean(call);
  });

  test('background-shell launch uses the same clean environment and CLI entry', () => {
    let call;
    const result = reconcile.launchDaemon({ projectRoot: ROOT, env: ambient,
      readGithubAccount: () => 'work', isCompiledBinary: () => true,
      harness: { hasBgShell: true, runBgShell: (...args) => { call = args; } },
      spawnProcess: () => { throw new Error('Unexpected detached fallback'); },
    });
    expect(result.via).toBe('bg-shell');
    expect(call).toEqual([[process.execPath, 'shepherd', 'daemon'], { cwd: ROOT, env: { RETAINED: 'yes' } }]);
  });

  test.each([false, true])('watcher re-enters the public CLI with unchanged owner argv (%s)', async compiled => {
    let call; let reads = 0;
    const worker = child();
    const result = await lifecycle.startPrWatcherDetached(watcherOptions({
      isCompiledBinary: () => compiled, readGithubAccount: () => { reads++; return 'work'; },
      spawn: (...values) => { call = values; return worker; },
    }));
    expect(result.started).toBe(true);
    expect(reads).toBe(1);
    expect(call[1]).toEqual([...(compiled ? [] : [lifecycle.forgeBin()]), 'shepherd', 'watch', '7',
      '--repo', 'owner/repo', '--generation', 'generation-7', '--controller-pid', String(process.pid), '--started-at', '2026-09-08T00:00:00.000Z']);
    expect(call[2]).toEqual({ cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: { RETAINED: 'yes' } });
    expect(worker.unreferenced).toBe(true);
    clean(result); clean(call);
  });

  test('unbound watcher and daemon preserve native ambient environment', async () => {
    const captured = [];
    await lifecycle.startPrWatcherDetached(watcherOptions({ readGithubAccount: () => null,
      spawn: (_cmd, _args, opts) => { captured.push(opts); return child(); },
    }));
    reconcile.launchDaemon({ projectRoot: ROOT, env: ambient, readGithubAccount: () => null,
      spawnProcess: (_cmd, _args, opts) => { captured.push(opts); return child(); },
    });
    expect(captured).toHaveLength(2);
    expect(captured.every(opts => opts.env === ambient)).toBe(true);
  });

  test('binding read failures prevent worker launch without exposing diagnostics', async () => {
    let launches = 0;
    const diagnostics = [];
    const readGithubAccount = () => { throw new Error(CANARY); };
    const spawn = () => { launches++; return child(); };
    const watcher = await lifecycle.startPrWatcherDetached(watcherOptions({ readGithubAccount, spawn }));
    const daemon = reconcile.launchDaemon({ projectRoot: ROOT, readGithubAccount, spawnProcess: spawn,
      writeDaemonDiagnostic: (_root, entry) => diagnostics.push(entry),
    });
    expect(watcher.started).toBe(false); expect(daemon.launched).toBe(false);
    expect(launches).toBe(0);
    clean({ watcher, daemon, diagnostics });
  });

  test('spawn errors and async launch diagnostics are credential-clean', async () => {
    const diagnostics = [];
    const worker = child();
    reconcile.launchDaemon({ projectRoot: ROOT, readGithubAccount: () => 'work', env: ambient,
      spawnProcess: () => worker, writeDaemonDiagnostic: (_root, entry) => diagnostics.push(entry),
    });
    worker.emit('error', new Error(CANARY));
    const result = await lifecycle.startPrWatcherDetached(watcherOptions({ spawn: () => { throw new Error(CANARY); } }));
    expect(result.started).toBe(false);
    clean({ result, diagnostics });
    clean(push._internal.maybeTriggerShepherdAfterPush({ projectRoot: ROOT, fireAndForget: () => { throw new Error(CANARY); } }));
  });

  test('push and session-start hand workers project metadata, never private context', async () => {
    const triggers = [];
    const result = await push.handler([], { quick: true }, ROOT, {
      execFileSync: (cmd, args, opts) => { clean(opts || {}); return args[0] === 'branch' ? 'test' : ROOT; },
      spawnSync: (_cmd, _args, opts) => { clean(opts); return { status: 0 }; },
      existsSync: () => false, writeForgeToken: () => {}, log: () => {},
      _ensureBackingIssue: async () => null, _kernelDriver: {}, _kernelBroker: {},
      githubContext: selected().context, fireAndForget: opts => triggers.push(opts),
    });
    expect(result.success).toBe(true);
    await hooks.handler(['session-start'], {}, ROOT, {
      loadDispatchText: () => '', fetchNotes: () => [], fetchIssues: () => [], fetchInbox: () => [],
      githubContext: selected().context, fireAndForget: opts => triggers.push(opts),
    });
    expect(triggers).toEqual([{ projectRoot: ROOT }, { projectRoot: ROOT }]);
  });

  test('local hook operations do not prepare account context or wake monitors', async () => {
    let preparations = 0; let triggers = 0;
    const result = await executeCommand(new Map([['hooks', hooks]]), 'hooks', ['shepherd-events'], {}, ROOT, {
      skipEnsureHome: true, prepareGithubContext: () => { preparations++; throw new Error(CANARY); },
      commandOpts: { collectDigest: () => ({ text: '' }), fireAndForget: () => { triggers++; } },
    });
    expect(result.success).toBe(true);
    expect({ preparations, triggers }).toEqual({ preparations: 0, triggers: 0 });
  });

  test('serve launches a clean snapshot worker and unchanged browser command', async () => {
    expect(typeof serve.defaultGenerate).toBe('function');
    expect(typeof serve.openBrowser).toBe('function');
    const calls = [];
    const spawn = (...args) => {
      calls.push(args); const worker = child();
      process.nextTick(() => worker.emit('exit', 0));
      return worker;
    };
    const opts = { spawn, env: ambient, readGithubAccount: () => 'work' };
    await serve.defaultGenerate(ROOT, path.join(ROOT, 'web', 'dashboard'), opts);
    serve.openBrowser('http://127.0.0.1:8730/', ROOT, opts);
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual([path.join(ROOT, 'web', 'dashboard', 'generate-snapshot.mjs')]);
    expect(calls[0][2]).toEqual({ cwd: ROOT, stdio: 'ignore', windowsHide: true, env: { RETAINED: 'yes' } });
    expect(calls[1][1].at(-1)).toBe('http://127.0.0.1:8730/');
    expect(calls[1][1]).not.toContain('github');
    expect(calls[1][2]).toEqual({ detached: true, stdio: 'ignore', windowsHide: true, env: { RETAINED: 'yes' } });
    clean(calls);
  });

  test.each([true, false])('snapshot prepares once and scopes only gh (%s)', async bound => {
    const file = path.join(ROOT, 'web', 'dashboard', 'generate-snapshot.mjs');
    // Refuse to import the old executable-only script: it would run native providers.
    expect(fs.readFileSync(file, 'utf8')).toContain('export function createSnapshotRunner');
    const { createSnapshotRunner } = await import(pathToFileURL(file).href);
    const { context, calls } = selected(() => '[]');
    let preparations = 0; const native = [];
    const run = createSnapshotRunner(ROOT, {
      env: ambient, prepareGithubContext: root => { expect(root).toBe(ROOT); preparations++; return bound ? context : { bound: false }; },
      execFileSync: (cmd, args, opts) => { native.push({ cmd, args, opts }); return '[]'; },
    });
    run('gh', ['pr', 'list']); run('gh', ['pr', 'view']);
    run('git', ['status']); run(process.execPath, ['forge.js', 'status']);
    expect(preparations).toBe(1);
    expect(calls).toHaveLength(bound ? 2 : 0);
    expect(native.map(call => call.cmd)).toEqual(bound ? ['git', process.execPath] : ['gh', 'gh', 'git', process.execPath]);
    if (bound) clean(native);
    else expect(native.every(call => call.opts.env === ambient)).toBe(true);
  });

  test('serve rejects synchronous worker failures with a safe diagnostic', async () => {
    await expect(serve.defaultGenerate(ROOT, ROOT, {
      readGithubAccount: () => 'work', env: ambient,
      spawn: () => { throw new Error(CANARY); },
    })).rejects.toThrow('snapshot generation failed');
  });

  test('snapshot generation keeps failed GitHub diagnostics and artifacts clean', async () => {
    const { generateSnapshot } = await import(pathToFileURL(path.join(ROOT, 'web/dashboard/generate-snapshot.mjs')).href);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-account-snapshot-'));
    const messages = []; const native = [];
    spyOn(console, 'log').mockImplementation((...args) => messages.push(args));
    spyOn(console, 'warn').mockImplementation((...args) => messages.push(args));
    let preparations = 0;
    const { context, calls } = selected(() => { throw new Error(CANARY); });
    try {
      const snapshot = generateSnapshot({ projectRoot: root, outputDir: root, env: ambient,
        prepareGithubContext: () => { preparations++; return context; },
        execFileSync: (cmd, args, opts) => {
          native.push({ cmd, args, opts });
          expect(cmd === 'git' || cmd === process.execPath).toBe(true);
          return cmd === 'git' ? '' : '{}';
        },
      });
      expect(preparations).toBe(1);
      expect(calls).toHaveLength(2);
      expect(snapshot.ops.prs).toEqual([]);
      expect(fs.readdirSync(root).sort()).toEqual(['data.json', 'docs.js', 'docs.json', 'snapshot.js']);
      clean({ native, messages, snapshot });
      for (const file of fs.readdirSync(root)) clean(fs.readFileSync(path.join(root, file), 'utf8'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('full eval hands a private GitHub runner only to PR attribution', async () => {
    const { context } = selected();
    let preparations = 0; let resolverCalls = 0;
    const env = Object.freeze({ RETAINED: 'yes' });
    const result = await skill.handler(['eval', 'dev', '--full', '--tier', '30'], {}, ROOT, {
      env, prepareGithubContext: () => { preparations++; return context; },
      resolveBehavioralEvaluation: async options => {
        resolverCalls++;
        expect(options.env).toBe(env);
        expect(typeof options.deps.runGh).toBe('function');
        options.deps.runGh(['pr', 'view']);
        return { ok: true, options: {} };
      },
      runBehavioralEvaluation: async options => {
        expect(options.githubContext).toBeUndefined(); expect(options.runGh).toBeUndefined();
        clean(options);
        return { status: 'PASS', findings: [], completedRuns: 360, expectedRuns: 360 };
      },
    });
    expect(result.success).toBe(true);
    expect({ preparations, resolverCalls }).toEqual({ preparations: 1, resolverCalls: 1 });
  });

  test('full eval account failure prevents resolver and harness without raw output', async () => {
    let calls = 0;
    const result = await skill.handler(['eval', 'dev', '--full', '--tier', '30'], {}, ROOT, {
      prepareGithubContext: () => { throw new Error(CANARY); },
      resolveBehavioralEvaluation: async () => { calls++; return { ok: false, result: { status: 'INCOMPLETE', findings: [] } }; },
      runBehavioralEvaluation: async () => { calls++; },
    });
    expect(result.success).toBe(false); expect(calls).toBe(0); clean(result);
  });

  test('static skill routing never prepares account context', async () => {
    let calls = 0;
    const result = await skill.handler(['for', 'implement a planned task'], {}, ROOT, {
      prepareGithubContext: () => { calls++; throw new Error(CANARY); },
    });
    expect(result.success).toBe(true); expect(calls).toBe(0);
  });

  test('attribution splits Git from selected PR resolution and adapter reads', async () => {
    const { context, calls } = selected(args => args.includes('number')
      ? '{"number":7}' : JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: HEAD, reviewDecision: '', statusCheckRollup: [] }));
    const result = await runtime._internal.resolveAttribution(ROOT, HEAD, {}, {
      runGh: context.runGh,
      execFileSync: (cmd, _args, opts) => { expect(cmd).toBe('git'); clean(opts); return 'test-branch'; },
      kernelDriver: {
        listWorktrees: () => [{ branch: 'test-branch', issue_id: ISSUE, state: 'active' }],
        loadKernelEntity: async () => ({ id: ISSUE, status: 'in_progress' }),
      },
    });
    expect(result).toEqual({ issueId: ISSUE, pr: 7 });
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  test.each([
    ['lib/commands/push.js', ['test/commands/push.test.js']],
    ['lib/commands/hooks.js', ['test/commands/hooks.test.js', 'test/hooks-session-start.test.js']],
    ['lib/commands/serve.js', ['test/commands/serve.test.js']],
    ['lib/commands/skill.js', ['test/commands/skill.test.js']],
    ['scripts/lib/behavioral-eval-runtime.js', ['test/eval/behavioral-eval-runtime.test.js']],
    ['web/dashboard/generate-snapshot.mjs', []],
  ])('%s selects existing coverage and the indirect route matrix', (source, existing) => {
    const expected = [...existing, SUITE];
    expect(getTestCandidatesForChangedFile(source)).toEqual(expected);
    const plan = classifyPushTests(ROOT, (_cmd, args) => args[0] === 'diff' ? source : 'origin/master');
    expect(plan.mode).toBe('targeted');
    expect(plan.testTargets).toEqual([...expected.sort((a, b) => a.localeCompare(b)), ...ALWAYS_RUN_RISK_TEST_TARGETS]);
  });
});
