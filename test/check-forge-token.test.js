'use strict';

const { spawn } = require('node:child_process');
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

  test('rejects changed HEAD, runtime, test runtime, tracked content, and untracked content', () => {
    const issued = issue(root);
    for (const changed of [
      { head: 'b'.repeat(40) },
      { runtime: 'other-runtime' },
      { testRuntime: 'other-test-runtime' },
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
