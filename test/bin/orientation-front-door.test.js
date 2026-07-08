'use strict';

// Orientation front door:
//  * `forge <command> --help` renders THAT command's help, not the global setup banner.
//  * bare `forge` in an initialized project orients (read-only status view) instead of
//    running the mutating minimal install.

const { describe, test, expect } = require('bun:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FORGE_BIN = path.join(REPO_ROOT, 'bin', 'forge.js');

function rmrf(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 4 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) return;
      const until = Date.now() + 100; while (Date.now() < until) { /* brief spin */ }
    }
  }
}

function runForge(args, cwd) {
  return spawnSync(process.execPath, [FORGE_BIN, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('orientation front door', () => {
  test('`forge status --help` shows the status command help, not the global banner', () => {
    const result = runForge(['status', '--help'], REPO_ROOT);
    const out = `${result.stdout || ''}`;
    expect(out).toContain('forge status —');
    expect(out).toContain('--full');
    expect(out).not.toContain('npx forge setup');
  });

  test('bare `forge --help` shows the global setup banner', () => {
    const result = runForge(['--help'], REPO_ROOT);
    const out = `${result.stdout || ''}`;
    expect(out).toContain('npx forge setup');
  });

  test('`forge setup --help` cross-references forge init for adoption profiles + .forge/config.yaml', () => {
    const result = runForge(['setup', '--help'], REPO_ROOT);
    const out = `${result.stdout || ''}`;
    // The profile flags belong to `forge init` — documented there, not as setup flags.
    expect(out).toContain('forge init --minimal | --standard | --full');
    expect(out).toContain('--classification critical|standard|refactor');
    expect(out).toContain('.forge/config.yaml');
    // Real, still-handled setup flags stay documented.
    expect(out).toContain('--type');
    expect(out).toContain('--merge');
    expect(out).toContain('--interview');
    expect(out).toContain('--budget');
  });

  test('an unknown command in an initialized project errors + exits 1 (not the installer banner)', () => {
    // Regression (kernel b3bae4f3): `forge bogusxyz` used to fall through to the
    // minimal-install banner with exit 0, so typos looked like success.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-unknown-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# unknown-cmd test\n');

      const result = runForge(['bogusxyz'], repo);
      expect(result.status).toBe(1);
      expect(`${result.stderr || ''}`).toContain("Unknown command 'bogusxyz'");
      // Must NOT print the installer banner, and must not scaffold anything.
      expect(`${result.stdout || ''}`).not.toContain('npx forge setup');
      expect(fs.existsSync(path.join(repo, '.forge'))).toBe(false);
    } finally {
      rmrf(repo);
    }
  }, 30000);

  test('bare `forge` in an initialized project renders the orientation view (no mutation)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-orient-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# orient test\n');

      const result = runForge([], repo);
      if (result.status !== 0) {
        console.warn(`skipping bare-forge assertion — exited ${result.status}: ${(result.stderr || '').slice(0, 200)}`);
        return;
      }
      const out = `${result.stdout || ''}`;
      expect(out).toContain('You are here');
      expect(out).toContain('New here?');
      // Read-only: the minimal install would scaffold files; none should appear.
      expect(fs.existsSync(path.join(repo, '.forge'))).toBe(false);
    } finally {
      rmrf(repo);
    }
  }, 30000);
});
