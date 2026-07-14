'use strict';

// B3 (kernel e452422c / c713fce7 / 22e33dbf): after a clean `forge setup`, TDD
// enforcement was SILENTLY INERT — when the lefthook binary was unavailable, setup
// bailed out writing NO lefthook.yml and wiring NO git hooks, so raw `git commit`/
// `git push` had zero enforcement and `forge ship` then hard-blocked on a missing hook.
//
// This suite covers the shared wiring module that both `bin/forge.js` (the live
// `forge setup` path) and `lib/commands/setup.js` (the repair path) delegate to:
//   1. a REAL lefthook.yml is written (never the stock commented-out example),
//   2. a native `.git/hooks` fallback wires pre-commit/pre-push when lefthook is absent,
//   3. verifyHooksActive() reports honestly so setup can fail LOUDLY instead of no-op.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FORGE_USER_LEFTHOOK_YML,
  forgeShouldWriteLefthookConfig,
  resolveGitHooksDir,
  installNativeGitHooks,
  verifyHooksActive,
  FORGE_NATIVE_HOOK_SENTINEL,
} = require('../lib/lefthook-wiring');

let tmp;
function mkGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-wiring-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

beforeEach(() => { tmp = null; });
afterEach(() => {
  if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('FORGE_USER_LEFTHOOK_YML (real config, not the example)', () => {
  test('wires the pre-commit and pre-push jobs the HOOKS_NOT_ACTIVE gate requires', () => {
    expect(FORGE_USER_LEFTHOOK_YML).toMatch(/^pre-commit:/m);
    expect(FORGE_USER_LEFTHOOK_YML).toMatch(/^pre-push:/m);
    expect(FORGE_USER_LEFTHOOK_YML).toContain('.forge/hooks/check-tdd.js');
  });
  test('references no repo-internal scripts/ that a user project lacks', () => {
    expect(FORGE_USER_LEFTHOOK_YML).not.toContain('scripts/');
  });
  test('has at least one active (uncommented) job — never the empty example', () => {
    const active = FORGE_USER_LEFTHOOK_YML
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(active.length).toBeGreaterThan(0);
  });
});

describe('forgeShouldWriteLefthookConfig', () => {
  test('writes when no lefthook.yml exists', () => {
    expect(forgeShouldWriteLefthookConfig(path.join(os.tmpdir(), 'nope', 'lefthook.yml'))).toBe(true);
  });
  test("overwrites lefthook's fully-commented stock example stub", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stub-'));
    const file = path.join(tmp, 'lefthook.yml');
    fs.writeFileSync(file, '# EXAMPLE USAGE:\n#\n# pre-commit:\n#   commands:\n#     lint:\n#       run: yarn lint\n');
    expect(forgeShouldWriteLefthookConfig(file)).toBe(true);
  });
  test('never clobbers a config that already has active jobs', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-real-'));
    const file = path.join(tmp, 'lefthook.yml');
    fs.writeFileSync(file, 'pre-commit:\n  commands:\n    mine:\n      run: make check\n');
    expect(forgeShouldWriteLefthookConfig(file)).toBe(false);
  });
});

describe('resolveGitHooksDir', () => {
  test('returns .git/hooks for a normal repo (directory .git)', () => {
    tmp = mkGitRepo();
    expect(resolveGitHooksDir(tmp)).toBe(path.join(tmp, '.git', 'hooks'));
  });
  test('returns null when not a git repo', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-nogit-'));
    expect(resolveGitHooksDir(tmp)).toBeNull();
  });
  test('resolves the linked-worktree .git file to the common hooks dir', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-wt-'));
    const commonGit = path.join(tmp, 'main', '.git');
    const wtGit = path.join(commonGit, 'worktrees', 'wt1');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
    expect(resolveGitHooksDir(wt)).toBe(path.join(commonGit, 'hooks'));
  });
});

describe('installNativeGitHooks (fallback when lefthook is unavailable)', () => {
  test('writes Forge-marked pre-commit and pre-push hooks into .git/hooks', () => {
    tmp = mkGitRepo();
    const res = installNativeGitHooks(tmp);
    expect(res.installed).toBe(true);
    const pre = path.join(tmp, '.git', 'hooks', 'pre-commit');
    const push = path.join(tmp, '.git', 'hooks', 'pre-push');
    expect(fs.existsSync(pre)).toBe(true);
    expect(fs.existsSync(push)).toBe(true);
    expect(fs.readFileSync(pre, 'utf8')).toContain(FORGE_NATIVE_HOOK_SENTINEL);
    expect(fs.readFileSync(pre, 'utf8')).toContain('.forge/hooks/check-tdd.js');
  });
  test('reports not-a-git-repo instead of throwing when .git is absent', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-nogit2-'));
    const res = installNativeGitHooks(tmp);
    expect(res.installed).toBe(false);
    expect(res.reason).toBe('not-a-git-repo');
  });
  test('never destroys a pre-existing non-Forge hook (backs it up and skips)', () => {
    tmp = mkGitRepo();
    const hooksDir = path.join(tmp, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const pre = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(pre, '#!/bin/sh\necho custom user hook\n');
    const res = installNativeGitHooks(tmp);
    expect(fs.readFileSync(pre, 'utf8')).toContain('custom user hook');
    expect(res.skipped).toContain('pre-commit');
    expect(fs.existsSync(pre + '.forge-backup')).toBe(true);
  });
});

describe('verifyHooksActive (loud honesty — never silently no-op)', () => {
  test('reports inactive when no hooks are installed', () => {
    tmp = mkGitRepo();
    const res = verifyHooksActive(tmp);
    expect(res.active).toBe(false);
    expect(res.method).toBe('none');
  });
  test('reports active + native after installNativeGitHooks runs', () => {
    tmp = mkGitRepo();
    installNativeGitHooks(tmp);
    const res = verifyHooksActive(tmp);
    expect(res.active).toBe(true);
    expect(res.method).toBe('native');
  });
  test('reports active + lefthook when the pre-commit hook is lefthook-managed', () => {
    tmp = mkGitRepo();
    const hooksDir = path.join(tmp, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\n# generated by lefthook\nlefthook run pre-commit\n');
    const res = verifyHooksActive(tmp);
    expect(res.active).toBe(true);
    expect(res.method).toBe('lefthook');
  });
});
