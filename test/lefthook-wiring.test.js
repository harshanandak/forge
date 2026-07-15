'use strict';

// B3 (kernel e452422c / c713fce7 / 22e33dbf): after a clean `forge setup`, TDD
// enforcement was SILENTLY INERT — when the lefthook binary was unavailable, setup
// bailed out writing NO lefthook.yml and wiring NO git hooks, so raw `git commit`/
// `git push` had zero enforcement and `forge ship` then hard-blocked on a missing hook.
//
// This suite covers the shared wiring module that the LIVE `forge setup` path
// (lib/commands/setup.js, the registry command) and the mid-stage repair path delegate to:
//   1. a REAL lefthook.yml is written (never the stock commented-out example),
//   2. a native `.git/hooks` fallback wires pre-commit/pre-push when lefthook is absent,
//   3. verifyHooksActive() reports honestly so setup can fail LOUDLY instead of no-op.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

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

  test('refuses to write through a symlinked lefthook.yml (no escape outside the project)', () => {
    // Security guard (lib/lefthook-wiring.js): readFileSync/writeFileSync follow symlinks,
    // so a checked-out lefthook.yml -> ../outside could let setup create/overwrite a file
    // outside the repo. A symlink target — even a fully-commented stub — must return false.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-symlink-'));
    const outside = path.join(tmp, 'outside.yml');
    fs.writeFileSync(outside, '# fully commented stub\n');
    const link = path.join(tmp, 'lefthook.yml');
    try {
      fs.symlinkSync(outside, link);
    } catch {
      // Symlink creation needs privileges on Windows — skip when unavailable.
      return;
    }
    expect(forgeShouldWriteLefthookConfig(link)).toBe(false);
  });

  test('refuses to write when lefthook.yml is a directory (non-regular file)', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dir-'));
    const asDir = path.join(tmp, 'lefthook.yml');
    fs.mkdirSync(asDir);
    expect(forgeShouldWriteLefthookConfig(asDir)).toBe(false);
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

  test('same-repo guard: a non-git subdir UNDER a git repo resolves to null, not the ancestor (N1)', () => {
    if (!gitAvailable) return; // git required to make the ancestor real
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ancestor-'));
    spawnSync('git', ['init'], { cwd: tmp }); // parent IS a real repo
    const child = path.join(tmp, 'not-a-repo-yet');
    fs.mkdirSync(child, { recursive: true });
    // Without the guard, `git -C child rev-parse --git-path hooks` returns the PARENT's
    // hooks dir. The guard requires child to have its OWN .git, so this must be null.
    expect(resolveGitHooksDir(child)).toBeNull();
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

  // F4 (kernel 269e5d05): a user's CUSTOM hook that merely INVOKES lefthook among other
  // steps contains the substring 'lefthook' — the old bare-substring classifier treated it
  // as overwritable and clobbered it WITHOUT a backup. Such a hook is the user's; it must be
  // preserved (skipped) and backed up, never destroyed.
  test('preserves + backs up a user hook that merely invokes lefthook (not bare-substring clobber)', () => {
    tmp = mkGitRepo();
    const hooksDir = path.join(tmp, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const pre = path.join(hooksDir, 'pre-commit');
    const userHook = '#!/bin/sh\n# my project pre-commit\nnpm run my-checks\nlefthook run pre-commit\n';
    fs.writeFileSync(pre, userHook);
    const res = installNativeGitHooks(tmp);
    // The user's hook is untouched and preserved…
    expect(fs.readFileSync(pre, 'utf8')).toBe(userHook);
    expect(res.skipped).toContain('pre-commit');
    // …and a one-time backup exists carrying the original content.
    expect(fs.existsSync(pre + '.forge-backup')).toBe(true);
    expect(fs.readFileSync(pre + '.forge-backup', 'utf8')).toBe(userHook);
  });

  // F4 (kernel 269e5d05): a genuine lefthook-GENERATED hook (defines call_lefthook) is a
  // disposable generated artifact and may be overwritten with the native fallback — but the
  // overwrite must ALWAYS back up first, so nothing is destroyed without a .forge-backup.
  test('overwrites a genuine lefthook-generated hook but backs it up before overwriting', () => {
    tmp = mkGitRepo();
    const hooksDir = path.join(tmp, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const pre = path.join(hooksDir, 'pre-commit');
    const generated = '#!/bin/sh\nif [ "$LEFTHOOK" = "0" ]; then exit 0; fi\ncall_lefthook()\n{\n  lefthook "$@"\n}\ncall_lefthook run "pre-commit" "$@"\n';
    fs.writeFileSync(pre, generated);
    const res = installNativeGitHooks(tmp);
    // It IS replaced with Forge's native hook…
    expect(res.written).toContain('pre-commit');
    expect(fs.readFileSync(pre, 'utf8')).toContain(FORGE_NATIVE_HOOK_SENTINEL);
    // …but the generated original was backed up first (never destroyed without a copy).
    expect(fs.existsSync(pre + '.forge-backup')).toBe(true);
    expect(fs.readFileSync(pre + '.forge-backup', 'utf8')).toBe(generated);
  });
});

describe('verifyHooksActive (loud honesty — never silently no-op)', () => {
  test('reports inactive when no hooks are installed', () => {
    tmp = mkGitRepo();
    const res = verifyHooksActive(tmp);
    expect(res.active).toBe(false);
    expect(res.method).toBe('none');
  });
  // Helper: the native hook body only enforces when .forge/hooks/check-tdd.js exists
  // (`if [ -f … ]`), so a truthful "active" verdict requires the gate script to be present.
  function installGateScript(root) {
    const gateDir = path.join(root, '.forge', 'hooks');
    fs.mkdirSync(gateDir, { recursive: true });
    fs.writeFileSync(path.join(gateDir, 'check-tdd.js'), '#!/usr/bin/env node\nprocess.exit(0);\n');
  }

  test('reports active + native after installNativeGitHooks runs (with gate script present)', () => {
    tmp = mkGitRepo();
    installNativeGitHooks(tmp);
    installGateScript(tmp);
    const res = verifyHooksActive(tmp);
    expect(res.active).toBe(true);
    expect(res.method).toBe('native');
  });

  // F5 (kernel d96af31a): the native hook body no-ops when its gate script is absent, so a
  // present-but-inert hook must report NOT active (loud) — never a silent false pass.
  test('reports NOT active when the native hook is present but its gate script is absent', () => {
    tmp = mkGitRepo();
    installNativeGitHooks(tmp); // writes .git/hooks/pre-commit, but NO .forge/hooks/check-tdd.js
    const res = verifyHooksActive(tmp);
    expect(res.active).toBe(false);
    expect(res.reason).toMatch(/check-tdd\.js|gate script/i);
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
