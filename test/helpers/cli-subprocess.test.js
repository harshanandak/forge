/**
 * Tests for the CLI subprocess isolation harness.
 *
 * These guard the two properties the harness exists to provide: a child that
 * inherits nothing ambient, and timeouts ordered so a slow spawn reports as a
 * spawn timeout rather than a generic dead test case.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { describe, test, expect } = require('bun:test');

const {
  CASE_TIMEOUT_MS,
  CLI_TIMEOUT_MS,
  GIT_INIT_TIMEOUT_MS,
  baseEnv,
  createCliSandboxes,
  mergeEnv,
} = require('./cli-subprocess');

const pathKeysOf = (env) => Object.keys(env).filter((key) => /^path$/i.test(key));

describe('cli-subprocess timeout budget', () => {
  test('the inner CLI timeout is strictly lower than the case timeout', () => {
    // If these invert, bun kills the case before execFileSync's own limit fires
    // and the harness's diagnostic throw never runs.
    expect(CLI_TIMEOUT_MS).toBeLessThan(CASE_TIMEOUT_MS);
  });

  test('the case timeout exceeds the timeouts the shard runners pass to bun', () => {
    // scripts/test-ci-shard.js passes 15000; scripts/test-full-suite.js passes 30000.
    expect(CASE_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  test('git sandbox setup is bounded well under the CLI spawn budget', () => {
    expect(GIT_INIT_TIMEOUT_MS).toBeLessThan(CLI_TIMEOUT_MS);
  });
});

describe('cli-subprocess baseEnv', () => {
  test('drops INIT_CWD so no ambient value repoints the child', () => {
    expect(baseEnv()).not.toHaveProperty('INIT_CWD');
  });

  test('drops every FORGE_* key', () => {
    const forgeKeys = Object.keys(baseEnv()).filter((key) => key.startsWith('FORGE_'));
    expect(forgeKeys).toEqual([]);
  });

  test('drops mixed-case Forge and INIT_CWD keys', () => {
    const env = baseEnv({
      Forge_API_TOKEN: 'ambient-token',
      init_cwd: '/ambient-repo',
      SAFE_VALUE: 'kept',
    });

    expect(Object.keys(env).filter((key) => /^forge_/i.test(key))).toEqual([]);
    expect(Object.keys(env).filter((key) => /^init_cwd$/i.test(key))).toEqual([]);
    expect(env.SAFE_VALUE).toBe('kept');
  });
});

describe('cli-subprocess mergeEnv', () => {
  test('points INIT_CWD at the sandbox', () => {
    expect(mergeEnv('/sandbox', {}).INIT_CWD).toBe('/sandbox');
  });

  test('collapses PATH to exactly one key', () => {
    // Windows resolves env names case-insensitively; a JS object does not. An
    // ambient `Path` plus an override `PATH` would otherwise both survive.
    expect(pathKeysOf(mergeEnv('/sandbox', { PATH: '/planted' }))).toHaveLength(1);
  });

  test('an explicit PATH override wins over the ambient value', () => {
    const merged = mergeEnv('/sandbox', { PATH: '/planted' });
    expect(merged[pathKeysOf(merged)[0]]).toBe('/planted');
  });

  test('an empty PATH override is honoured rather than falling back to ambient', () => {
    // Suites empty PATH to prove a command does not shell out to a backend.
    const merged = mergeEnv('/sandbox', { PATH: '', Path: '' });
    expect(pathKeysOf(merged)).toHaveLength(1);
    expect(merged[pathKeysOf(merged)[0]]).toBe('');
  });

  test('keeps a single ambient PATH when the caller overrides nothing', () => {
    const merged = mergeEnv('/sandbox', {});
    expect(pathKeysOf(merged)).toHaveLength(1);
    expect(merged[pathKeysOf(merged)[0]]).toBe(process.env.PATH);
  });
});

describe('cli-subprocess sandbox template', () => {
  test('initializes git once and copies isolated repository state per sandbox', () => {
    const gitCalls = [];
    const sandboxes = createCliSandboxes('cli-subprocess-template-', {
      execFileSync: (command, args, options) => {
        gitCalls.push({ command, args, options });
        return execFileSync(command, args, options);
      },
    });

    const first = sandboxes.makeSandbox();
    const second = sandboxes.makeSandbox();

    try {
      expect(gitCalls).toHaveLength(1);
      expect(gitCalls[0]).toMatchObject({
        command: 'git',
        args: ['init', '-q'],
        options: { timeout: GIT_INIT_TIMEOUT_MS },
      });
      expect(fs.existsSync(`${first}/.git`)).toBe(true);
      expect(fs.existsSync(`${second}/.git`)).toBe(true);

      fs.writeFileSync(`${first}/.git/fixture-isolation-probe`, 'first-only');
      expect(fs.existsSync(`${second}/.git/fixture-isolation-probe`)).toBe(false);
    } finally {
      sandboxes.cleanup();
    }

    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(false);
  });

  test('reports bounded git template bootstrap diagnostics only on failure', () => {
    const failure = Object.assign(new Error('spawn failed'), {
      status: 128,
      stdout: 'git stdout',
      stderr: 'git stderr',
    });

    expect(() => createCliSandboxes('cli-subprocess-template-fail-', {
      execFileSync: () => { throw failure; },
    })).toThrow(/git init.*10000ms.*git stdout.*git stderr/s);
  });
});
