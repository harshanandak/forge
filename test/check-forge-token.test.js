'use strict';

const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { defaultGetProcessIdentity } = require('../scripts/process-tree');
const forgeToken = require('../scripts/check-forge-token');
const { _pushProof } = require('../lib/validation-receipt');

const FULL_GATES = ['branch-protection', 'lint', 'tests'];
const QUICK_GATES = ['branch-protection', 'lint'];
const NONCE_ENV = 'FORGE_PUSH_NONCE';
const QUICK_ENV = 'FORGE_PUSH_LANE';

const BASE_STATE = Object.freeze({
  worktree: 'worktree-a',
  head: 'a'.repeat(40),
  clean: true,
  runtime: 'forge-runtime',
  testRuntime: 'bun-a',
  runner: 'forge-full-suite-v1',
  branch: 'refs/heads/feature',
});

function deps(root, overrides = {}) {
  const state = overrides.state || BASE_STATE;
  return {
    homeDir: path.join(root, '.git', 'forge-test-home'),
    runtimeIdentity: 'forge-runtime',
    testRuntimeIdentity: 'bun-a',
    capturePushState: () => ({ ...state }),
    resolvePushProofPath: (_projectRoot, nonce) => path.join(root, '.git', 'forge', 'push-tokens', `${nonce}.json`),
    processPid: 4242,
    getProcessIdentity: pid => pid === 4242 ? 'process-4242-start-a' : null,
    env: {},
    ...overrides,
  };
}

function issue(root, mode = 'full', overrides = {}) {
  const options = deps(root, overrides);
  const snapshot = _pushProof.begin(root, options);
  const token = forgeToken.write(root, {
    ...options,
    snapshot,
    mode,
    gates: mode === 'quick' ? QUICK_GATES : FULL_GATES,
    receiptIdentity: mode === 'full' ? 'receipt-or-fresh-tests' : null,
  });
  return { token, options };
}

function tokenEnv(token, extra = {}) {
  return { [NONCE_ENV]: token.nonce, ...extra };
}

function initializeRepo(root) {
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'initial\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'push-proof@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Push Proof Test'], { cwd: root });
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
}

describe('check-forge-token', () => {
  let root;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-push-proof-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('preserves write, isValid, and consume exports', () => {
    expect(typeof forgeToken.write).toBe('function');
    expect(typeof forgeToken.isValid).toBe('function');
    expect(typeof forgeToken.consume).toBe('function');
  });

  test('accepts the same live full invocation after 31 seconds without a TTL bypass', () => {
    const now = 1_000_000;
    const { token, options } = issue(root, 'full', { now: () => now });
    expect(forgeToken.isValid(root, {
      ...options,
      now: () => now + 31_000,
      env: tokenEnv(token),
    })).toBe(true);
  });

  test('accepts a Bun-issued proof in the real Node hook checker', () => {
    initializeRepo(root);
    const homeDir = path.join(root, '.git', 'forge-test-home');
    fs.mkdirSync(homeDir);
    const snapshot = _pushProof.begin(root, { homeDir });
    expect(snapshot).toBeTruthy();
    const token = forgeToken.write(root, {
      homeDir,
      snapshot,
      mode: 'full',
      gates: FULL_GATES,
      receiptIdentity: 'fresh-tests',
    });
    const nodeExecutable = process.env.FORGE_TEST_NODE_EXECUTABLE || globalThis.Bun?.which?.('node') || 'node';
    const result = spawnSync(nodeExecutable, [path.resolve(__dirname, '../scripts/check-forge-token.js')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        [NONCE_ENV]: token.nonce,
      },
      timeout: 10_000,
      windowsHide: true,
    });

    expect({ status: result.status, errorCode: result.error?.code || null })
      .toEqual({ status: 0, errorCode: null });
  });

  test('accepts a real Node-only proof in the Node hook checker', () => {
    initializeRepo(root);
    const homeDir = path.join(root, '.git', 'forge-test-home');
    fs.mkdirSync(homeDir);
    const fixture = path.join(root, '.git', 'node-only-proof-fixture.js');
    fs.writeFileSync(fixture, `
'use strict';
const { spawnSync } = require('node:child_process');
const [projectRoot, homeDir, checkerPath, receiptPath] = process.argv.slice(2);
const missingBun = spawnSync('bun', ['--version'], { stdio: 'ignore' });
if (missingBun.error?.code !== 'ENOENT') process.exit(21);
for (const command of ['node', 'git']) {
  const available = spawnSync(command, ['--version'], { stdio: 'ignore' });
  if (available.error || available.status !== 0) process.exit(command === 'node' ? 22 : 23);
}
const forgeToken = require(checkerPath);
const { _pushProof } = require(receiptPath);
const options = { homeDir, env: process.env };
const snapshot = _pushProof.begin(projectRoot, options);
if (!snapshot) process.exit(24);
const token = forgeToken.write(projectRoot, {
  ...options,
  snapshot,
  mode: 'full',
  gates: ['branch-protection', 'lint', 'tests'],
  receiptIdentity: 'fresh-tests',
});
const checked = spawnSync(process.execPath, [checkerPath], {
  cwd: projectRoot,
  env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ${JSON.stringify(NONCE_ENV)}: token.nonce },
  stdio: 'ignore',
});
forgeToken.consume(projectRoot, { homeDir, nonce: token.nonce });
process.exit(checked.error ? 25 : checked.status);
`);
    const nodeExecutable = process.env.FORGE_TEST_NODE_EXECUTABLE || globalThis.Bun?.which?.('node') || 'node';
    const bunExecutableNames = process.platform === 'win32'
      ? ['bun', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
        .map(suffix => `bun${suffix.toLowerCase()}`)]
      : ['bun'];
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.toUpperCase() === 'PATH' || key.toUpperCase() === 'BUN_EXE') delete childEnv[key];
    }
    const providesBun = entry => bunExecutableNames.some((name) => {
      try {
        fs.accessSync(path.join(entry, name), process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    childEnv.PATH = (process.env.PATH || '')
      .split(path.delimiter)
      .filter(entry => entry && !providesBun(entry))
      .join(path.delimiter);
    const result = spawnSync(nodeExecutable, [
      fixture,
      root,
      homeDir,
      path.resolve(__dirname, '../scripts/check-forge-token.js'),
      path.resolve(__dirname, '../lib/validation-receipt.js'),
    ], {
      cwd: root,
      encoding: 'utf8',
      env: childEnv,
      timeout: 10_000,
      windowsHide: true,
    });

    expect({ status: result.status, errorCode: result.error?.code || null })
      .toEqual({ status: 0, errorCode: null });
  });

  test('accepts quick only with its exact gate set and explicit quick child lane', () => {
    const { token, options } = issue(root, 'quick');
    expect(forgeToken.isValid(root, {
      ...options,
      env: tokenEnv(token, { [QUICK_ENV]: 'quick' }),
    })).toBe(true);
    expect(forgeToken.isValid(root, { ...options, env: tokenEnv(token) })).toBe(false);
  });

  test('rejects a full proof when a stale inherited quick lane reaches the child', () => {
    const { token, options } = issue(root);
    expect(forgeToken.isValid(root, {
      ...options,
      env: tokenEnv(token, { [QUICK_ENV]: 'quick' }),
    })).toBe(false);
  });

  test('rejects missing nonce, malformed nonce, tampering, and corrupted JSON', () => {
    const { token, options } = issue(root);
    expect(forgeToken.isValid(root, { ...options, env: {} })).toBe(false);
    expect(forgeToken.isValid(root, { ...options, env: tokenEnv({ nonce: '../escape' }) })).toBe(false);

    const proofPath = forgeToken._internal.resolveProofPath(root, token.nonce, options);
    const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    proof.payload.mode = 'quick';
    fs.writeFileSync(proofPath, JSON.stringify(proof));
    expect(forgeToken.isValid(root, { ...options, env: tokenEnv(token) })).toBe(false);

    fs.writeFileSync(proofPath, 'not json');
    expect(forgeToken.isValid(root, { ...options, env: tokenEnv(token) })).toBe(false);
  });

  test('rejects missing, extra, duplicate, or mode-mismatched completed gates', () => {
    for (const gates of [
      ['branch-protection', 'lint'],
      ['branch-protection', 'lint', 'tests', 'security'],
      ['branch-protection', 'lint', 'tests', 'tests'],
    ]) {
      const options = deps(root);
      const snapshot = _pushProof.begin(root, options);
      expect(() => forgeToken.write(root, { ...options, snapshot, mode: 'full', gates })).toThrow();
    }

    for (const mode of ['toString', 'constructor', '__proto__', 'unknown']) {
      const options = deps(root);
      const snapshot = _pushProof.begin(root, options);
      expect(() => forgeToken.write(root, { ...options, snapshot, mode, gates: [] })).toThrow();
    }

    const options = deps(root);
    const snapshot = _pushProof.begin(root, options);
    expect(() => forgeToken.write(root, {
      ...options,
      snapshot,
      mode: 'full',
      gates: FULL_GATES,
      receiptIdentity: '',
    })).toThrow();
  });

  test('rejects changed HEAD, test runtime, runner, tracked content, and untracked content', () => {
    const issued = issue(root);
    for (const changed of [
      { head: 'b'.repeat(40) },
      { testRuntime: 'other-test-runtime' },
      { runner: 'other-runner' },
      { clean: false },
    ]) {
      expect(forgeToken.isValid(root, {
        ...issued.options,
        capturePushState: () => ({ ...BASE_STATE, ...changed }),
        env: tokenEnv(issued.token),
      })).toBe(false);
    }
  });

  test('rejects switching to a protected branch at the identical HEAD', () => {
    const { token, options } = issue(root);
    expect(forgeToken.isValid(root, {
      ...options,
      capturePushState: () => ({ ...BASE_STATE, branch: 'refs/heads/main' }),
      env: tokenEnv(token),
    })).toBe(false);
  });

  test('rejects a proof copied into another worktree', () => {
    const { token, options } = issue(root);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-push-proof-other-'));
    try {
      const otherOptions = deps(other, { state: { ...BASE_STATE, worktree: 'worktree-b' } });
      const target = forgeToken._internal.resolveProofPath(other, token.nonce, otherOptions);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(forgeToken._internal.resolveProofPath(root, token.nonce, options), target);
      expect(forgeToken.isValid(other, { ...otherOptions, env: tokenEnv(token) })).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('rejects unknown, ended, and PID-reused owners', () => {
    const { token, options } = issue(root);
    expect(forgeToken.isValid(root, {
      ...options,
      getProcessIdentity: () => null,
      env: tokenEnv(token),
    })).toBe(false);
    expect(forgeToken.isValid(root, {
      ...options,
      getProcessIdentity: () => 'process-4242-start-b',
      env: tokenEnv(token),
    })).toBe(false);
  });

  test('tracks a real short-lived owner process without sleeping 30 seconds', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
      let identity = null;
      for (let attempt = 0; attempt < 50 && !identity; attempt++) {
        identity = defaultGetProcessIdentity(child.pid);
        if (!identity) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(identity).toBeTruthy();

      const options = deps(root, {
        processPid: child.pid,
        getProcessIdentity: defaultGetProcessIdentity,
      });
      const snapshot = _pushProof.begin(root, options);
      const token = forgeToken.write(root, {
        ...options,
        snapshot,
        mode: 'full',
        gates: FULL_GATES,
        receiptIdentity: 'fresh-tests',
      });
      expect(forgeToken.isValid(root, { ...options, env: tokenEnv(token) })).toBe(true);

      child.kill();
      await exited;
      expect(forgeToken.isValid(root, { ...options, env: tokenEnv(token) })).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });

  test('consume deletes only its own invocation proof', () => {
    const first = issue(root);
    const second = issue(root);
    const firstPath = forgeToken._internal.resolveProofPath(root, first.token.nonce, first.options);
    const secondPath = forgeToken._internal.resolveProofPath(root, second.token.nonce, second.options);

    expect(forgeToken.consume(root, { ...first.options, env: tokenEnv(first.token) })).toBe(true);
    expect(fs.existsSync(firstPath)).toBe(false);
    expect(fs.existsSync(secondPath)).toBe(true);
    expect(forgeToken.isValid(root, { ...second.options, env: tokenEnv(second.token) })).toBe(true);
  });

  test('the ignored legacy marker stays ignored and proof files never dirty the worktree', () => {
    const { token, options } = issue(root);
    expect(forgeToken._internal.resolveProofPath(root, token.nonce, options))
      .toContain(path.join('.git', 'forge', 'push-tokens'));
    expect(fs.readFileSync(path.resolve(__dirname, '..', '.gitignore'), 'utf8'))
      .toContain('.forge-push-token');
    forgeToken.consume(root, { ...options, env: tokenEnv(token) });
  });
});
