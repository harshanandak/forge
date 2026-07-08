'use strict';

// Regression coverage for kernel c713fce7: a fresh `forge init` used to leave the core
// workflow unreachable (HOOKS_NOT_ACTIVE) because lefthook's own postinstall drops a
// fully-commented stub lefthook.yml that blocked Forge from writing a real config, and
// the config Forge did ship referenced repo-internal scripts a user project never has.

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  forgeShouldWriteLefthookConfig,
  FORGE_USER_LEFTHOOK_YML,
} = require('../../lib/commands/setup');

function writeTemp(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lefthook-'));
  const file = path.join(dir, 'lefthook.yml');
  fs.writeFileSync(file, content, 'utf8');
  return { dir, file };
}

describe('forgeShouldWriteLefthookConfig', () => {
  test('writes when no lefthook.yml exists', () => {
    const missing = path.join(os.tmpdir(), 'forge-nope', 'lefthook.yml');
    expect(forgeShouldWriteLefthookConfig(missing)).toBe(true);
  });

  test('overwrites lefthook\'s fully-commented stock stub', () => {
    const stub = [
      '# EXAMPLE USAGE:',
      '#',
      '# pre-commit:',
      '#   commands:',
      '#     lint:',
      '#       run: yarn lint',
      '',
    ].join('\n');
    const { dir, file } = writeTemp(stub);
    try {
      expect(forgeShouldWriteLefthookConfig(file)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never writes THROUGH a symlinked lefthook.yml (no escape outside the project)', () => {
    // CodeRabbit hardening: readFileSync/writeFileSync follow symlinks, so a checked-out
    // lefthook.yml -> ../outside could let setup create/overwrite a file outside the repo.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lefthook-symlink-'));
    const outside = path.join(dir, 'outside.txt');
    const link = path.join(dir, 'lefthook.yml');
    fs.writeFileSync(outside, '# fully commented stub\n');
    try {
      fs.symlinkSync(outside, link);
    } catch {
      // Symlink creation needs privileges on Windows — skip if unavailable.
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    try {
      expect(forgeShouldWriteLefthookConfig(link)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never clobbers a config that already has active jobs', () => {
    const { dir, file } = writeTemp(FORGE_USER_LEFTHOOK_YML);
    try {
      expect(forgeShouldWriteLefthookConfig(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // A user's own hand-authored config is likewise preserved.
    const userCfg = writeTemp('pre-commit:\n  commands:\n    mine:\n      run: make check\n');
    try {
      expect(forgeShouldWriteLefthookConfig(userCfg.file)).toBe(false);
    } finally {
      fs.rmSync(userCfg.dir, { recursive: true, force: true });
    }
  });
});

describe('FORGE_USER_LEFTHOOK_YML', () => {
  test('wires both hooks the HOOKS_NOT_ACTIVE gate requires', () => {
    expect(FORGE_USER_LEFTHOOK_YML).toMatch(/^pre-commit:/m);
    expect(FORGE_USER_LEFTHOOK_YML).toMatch(/^pre-push:/m);
  });

  test('references only files a user project actually has — never repo-internal scripts/', () => {
    expect(FORGE_USER_LEFTHOOK_YML).toContain('.forge/hooks/check-tdd.js');
    // The repo's dev config referenced scripts/branch-protection.js, lint.js, test.js …
    // which a user never gets; shipping those to users is the bug this guards against.
    expect(FORGE_USER_LEFTHOOK_YML).not.toContain('scripts/');
  });
});
