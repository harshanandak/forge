'use strict';

// B3: the LIVE `forge setup` / `forge init` path is the REGISTRY COMMAND in
// lib/commands/setup.js — it wins in the dispatcher and returns before bin/forge.js's
// inline setup branch is ever reached (that bin copy is LEGACY/DEAD, see the banner in
// bin/forge.js "LEGACY / DEAD SETUP PATH"). So the B3 guarantees must live on the lib
// path: a REAL lefthook.yml (not the repo dev config nor the stock example), a native
// `.git/hooks` fallback when the lefthook binary is unavailable, a LOUD non-zero failure
// when enforcement ends up inert in a git repo, and never npm-installing lefthook into an
// ancestor package.json (kernel 22e33dbf).
//
// Two layers of coverage:
//  1. Source-level assertions locking the wiring into the live lib functions.
//  2. Real end-to-end runs of the actual `forge setup` handler (the only way to prove the
//     live dispatch path, not a dead copy, does the right thing).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, test, expect } = require('bun:test');

const { FORGE_NATIVE_HOOK_SENTINEL } = require('../lib/lefthook-wiring');

const SETUP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'commands', 'setup.js'),
  'utf8'
);

function bodyOf(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  const nextFn = source.indexOf('\nfunction ', start + 1);
  const nextAsync = source.indexOf('\nasync function ', start + 1);
  const end = Math.min(
    nextFn > -1 ? nextFn : Infinity,
    nextAsync > -1 ? nextAsync : Infinity
  );
  return source.substring(start, end === Infinity ? source.length : end);
}

describe('lib/commands/setup.js (LIVE path) delegates hook wiring to lib/lefthook-wiring (B3)', () => {
  test('requires the shared lefthook-wiring module', () => {
    expect(SETUP_SRC).toContain("require('../lefthook-wiring')");
  });

  test('installGitHooks writes the REAL user lefthook.yml + native fallback + verify', () => {
    const body = bodyOf(SETUP_SRC, 'function installGitHooks(options');
    expect(body).toContain('FORGE_USER_LEFTHOOK_YML');
    expect(body).toContain('forgeShouldWriteLefthookConfig');
    expect(body).toContain('installNativeGitHooks');
    expect(body).toContain('verifyHooksActive');
  });

  test('installGitHooks fails LOUDLY (non-zero exit) when loud + inert in a git repo', () => {
    const body = bodyOf(SETUP_SRC, 'function installGitHooks(options');
    expect(body).toContain('loud');
    expect(body).toContain('process.exitCode = 1');
  });

  test('the setup handlers (quickSetup/executeSetup) call installGitHooks LOUD', () => {
    // Both user-facing handlers must opt into the hard-failure behavior.
    const loudCalls = SETUP_SRC.match(/installGitHooks\(\{ loud: true \}\)/g) || [];
    expect(loudCalls.length).toBeGreaterThanOrEqual(2);
  });

  test('autoInstallLefthook refuses to install lefthook without a local package.json (22e33dbf)', () => {
    const body = bodyOf(SETUP_SRC, 'function autoInstallLefthook()');
    // Guards on projectRoot/package.json before the package-manager install so it never
    // resolves against an ancestor.
    expect(body).toContain("path.join(projectRoot, 'package.json')");
  });

  test('ensureGitHooksInstalled no longer bails on a missing package.json (F2)', () => {
    const body = bodyOf(SETUP_SRC, 'async function ensureGitHooksInstalled(');
    // The old early return { reason: "no-package-json" } would skip the native fallback
    // on `forge init` in a bare repo — it must be gone.
    expect(body).not.toContain("reason: 'no-package-json'");
  });
});

// ---------------------------------------------------------------------------------------
// End-to-end: drive the ACTUAL `forge setup` handler (proves the live dispatch, not a
// dead copy). These spawn a real subprocess and are slower; each has its own timeout.
// ---------------------------------------------------------------------------------------

const FORGE_BIN = path.join(__dirname, '..', 'bin', 'forge.js');

function gitInit(dir) {
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 't@t.co'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
}

function runForgeSetup(repo) {
  return spawnSync(
    process.execPath,
    [FORGE_BIN, 'setup', '--yes', '--path', repo],
    { cwd: repo, encoding: 'utf8', timeout: 90000, env: { ...process.env, INIT_CWD: repo } }
  );
}

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

describe('forge setup — LIVE handler end-to-end (B3)', () => {
  test('(a) git repo where hooks stay inert → exits NON-ZERO and LOUD', () => {
    if (!gitAvailable) return; // git required
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-live-inert-'));
    try {
      gitInit(repo);
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# demo\n');
      // A pre-existing FOREIGN pre-commit hook (neither Forge- nor lefthook-managed).
      // The native installer must preserve it (skip), so with no lefthook binary present
      // enforcement stays inert — and the setup handler must fail loudly + non-zero.
      const hooksDir = path.join(repo, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\necho custom user hook\n');

      const res = runForgeSetup(repo);
      const out = (res.stdout || '') + (res.stderr || '');
      expect(res.status).not.toBe(0);
      expect(out).toContain('TDD ENFORCEMENT IS NOT ACTIVE');
      // The user's hook is preserved, never clobbered.
      expect(fs.readFileSync(path.join(hooksDir, 'pre-commit'), 'utf8')).toContain('custom user hook');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 120000);

  test('(b) bare repo (no package.json) → no pkg-mgr lefthook install, native hooks wired', () => {
    if (!gitAvailable) return; // git required
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-live-bare-'));
    try {
      gitInit(repo);
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# demo\n');

      const res = runForgeSetup(repo);
      const out = (res.stdout || '') + (res.stderr || '');

      // Native fallback wired the real pre-commit (carries the Forge sentinel).
      const preCommit = path.join(repo, '.git', 'hooks', 'pre-commit');
      expect(fs.existsSync(preCommit)).toBe(true);
      expect(fs.readFileSync(preCommit, 'utf8')).toContain(FORGE_NATIVE_HOOK_SENTINEL);

      // No package-manager lefthook install happened: the install banner never printed
      // and no package.json was fabricated in (or an ancestor of) the bare repo.
      expect(out).not.toContain('Installing lefthook for git hooks');
      expect(fs.existsSync(path.join(repo, 'package.json'))).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 120000);

  test('(c) --quick in a bare repo hits the ancestor-package.json guard, not a pkg-mgr install', () => {
    if (!gitAvailable) return; // git required
    // quickSetup (unlike executeSetup) DOES call autoInstallLefthook — the path where the
    // 22e33dbf ancestor-resolution bug lived. The guard must fire and native hooks wire.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-live-quick-'));
    try {
      gitInit(repo);
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# demo\n');

      const res = spawnSync(
        process.execPath,
        [FORGE_BIN, 'setup', '--quick', '--agents', 'claude', '--path', repo],
        { cwd: repo, encoding: 'utf8', timeout: 90000, env: { ...process.env, INIT_CWD: repo } }
      );
      const out = (res.stdout || '') + (res.stderr || '');
      expect(out).toContain('skipping lefthook install');
      expect(out).not.toContain('Installing lefthook for git hooks');
      const preCommit = path.join(repo, '.git', 'hooks', 'pre-commit');
      expect(fs.readFileSync(preCommit, 'utf8')).toContain(FORGE_NATIVE_HOOK_SENTINEL);
      expect(fs.existsSync(path.join(repo, 'package.json'))).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 120000);
});
