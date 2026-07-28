/**
 * Tests for the CLI subprocess isolation harness.
 *
 * These guard the two properties the harness exists to provide: a child that
 * inherits nothing ambient, and timeouts ordered so a slow spawn reports as a
 * spawn timeout rather than a generic dead test case.
 */

const { describe, test, expect } = require('bun:test');

const {
  CASE_TIMEOUT_MS,
  CLI_TIMEOUT_MS,
  GIT_INIT_TIMEOUT_MS,
  baseEnv,
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
