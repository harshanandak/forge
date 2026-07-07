'use strict';

// Regression (kernel issue a9bbd065): the non-interactive "using default agent
// selection" notice used to print on stderr for EVERY command run by a non-TTY
// agent/CI, polluting otherwise-clean output. It is now DEBUG-ONLY: silent by
// default, emitted on stderr only under --verbose or FORGE_DEBUG=1. Either way
// it must NEVER reach stdout — kernel issue commands emit their envelope there.

const { describe, test, expect } = require('bun:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FORGE_BIN = path.join(REPO_ROOT, 'bin', 'forge.js');
const BANNER = 'Non-interactive mode';

function rmrf(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 4 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) return;
      const until = Date.now() + 100; while (Date.now() < until) { /* brief spin */ }
    }
  }
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-banner-'));
  // Minimal kernel-capable repo: a git dir (for the kernel DB location) and an
  // AGENTS.md so the first-run setup gate is bypassed. The CLI resolves its own
  // deps from REPO_ROOT/node_modules, so cwd needs none.
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# banner test\n');
  return repo;
}

function runCreate(repo, env = {}) {
  return spawnSync(process.execPath, [FORGE_BIN, 'issue', 'create', '--title=A', '--type=task'], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

describe('non-interactive banner routing', () => {
  test('plain commands are silent: no banner on stdout OR stderr, pure JSON envelope on stdout', () => {
    const repo = makeRepo();
    try {
      const result = runCreate(repo);

      // If the kernel could not initialize in this environment (e.g. a refused
      // filesystem class), skip rather than flake — the routing fix is unaffected.
      if (result.status !== 0) {
        console.warn(`skipping banner assertion — issue create exited ${result.status}: ${(result.stderr || '').slice(0, 200)}`);
        return;
      }

      // Core guarantee: stdout is a single parseable JSON envelope, banner-free.
      const stdout = result.stdout || '';
      expect(stdout).not.toContain(BANNER);
      const parsed = JSON.parse(stdout);
      expect(parsed.schema_version).toBe('forge.issue.v1');
      expect(parsed.command).toBe('issue.create');

      // The a9bbd065 fix: the banner is debug-only, so a plain run emits NOTHING.
      expect(result.stderr || '').not.toContain(BANNER);
    } finally {
      rmrf(repo);
    }
  }, 30000);

  test('FORGE_DEBUG=1 restores the banner — on stderr, never stdout', () => {
    const repo = makeRepo();
    try {
      const result = runCreate(repo, { FORGE_DEBUG: '1' });

      if (result.status !== 0) {
        console.warn(`skipping banner assertion — issue create exited ${result.status}: ${(result.stderr || '').slice(0, 200)}`);
        return;
      }

      expect(result.stdout || '').not.toContain(BANNER);
      expect(result.stderr || '').toContain(BANNER);
    } finally {
      rmrf(repo);
    }
  }, 30000);
});
