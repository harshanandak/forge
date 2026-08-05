'use strict';

const { describe, expect, test } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const configPath = path.resolve(__dirname, '..', '.codex', 'config.toml');
const repoRoot = path.resolve(__dirname, '..');
const forbiddenPolicyKeys = new Set(['approval_policy', 'sandbox_mode', 'sandbox_workspace_write']);

function isTrackedConfig(filePath = configPath, runGit = execFileSync) {
  if (!fs.existsSync(filePath)) return false;

  try {
    runGit('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', '--', path.relative(repoRoot, filePath)], {
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function hasForbiddenPolicyKey(value) {
  if (!value || typeof value !== 'object') return false;

  return Object.entries(value).some(([key, nestedValue]) => (
    key.split('.').some(part => forbiddenPolicyKeys.has(part)) || hasForbiddenPolicyKey(nestedValue)
  ));
}

describe('tracked Codex project configuration', () => {
  test('rejects semantic policy keys in TOML', () => {
    const forbiddenToml = [
      'approval_policy = "never"',
      '"approval_policy" = "never"',
      'runner.approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      'runner."sandbox_mode" = "danger-full-access"',
      'sandbox_workspace_write.network_access = true',
      '"sandbox_workspace_write.network_access" = true',
      '[sandbox_workspace_write]\nnetwork_access = true',
    ];

    for (const toml of forbiddenToml) {
      expect(hasForbiddenPolicyKey(globalThis.Bun.TOML.parse(toml))).toBe(true);
    }

    expect(hasForbiddenPolicyKey(globalThis.Bun.TOML.parse('safe_key = "value"'))).toBe(false);
  });

  test('only skips expected not-tracked Git status', () => {
    const notTrackedError = Object.assign(new Error('not tracked'), { status: 1 });
    expect(isTrackedConfig(__filename, () => { throw notTrackedError; })).toBe(false);

    const unexpectedGitError = Object.assign(new Error('git unavailable'), { status: 128 });
    expect(() => isTrackedConfig(__filename, () => { throw unexpectedGitError; })).toThrow('git unavailable');
  });

  test.skipIf(!isTrackedConfig())('does not override user-owned approval or sandbox policy', () => {
    const config = globalThis.Bun.TOML.parse(fs.readFileSync(configPath, 'utf8'));
    expect(hasForbiddenPolicyKey(config)).toBe(false);
  });
});
