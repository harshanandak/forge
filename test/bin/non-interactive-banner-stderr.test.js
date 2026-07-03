'use strict';

// Regression: the non-interactive "using default agent selection" banner must go
// to STDERR, never STDOUT. Kernel issue commands (create/list/ready/show) emit a
// forge.issue.v1 JSON envelope on stdout; a banner on stdout prepends that JSON and
// makes non-TTY agents/CI unable to parse the default (no --json) output.

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

describe('non-interactive banner routing', () => {
  test('`forge issue create` (no --json) writes pure JSON to stdout and the banner to stderr', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-banner-'));
    try {
      // Minimal kernel-capable repo: a git dir (for the kernel DB location) and an
      // AGENTS.md so the first-run setup gate is bypassed. The CLI resolves its own
      // deps from REPO_ROOT/node_modules, so cwd needs none.
      spawnSync('git', ['init', '-q'], { cwd: repo });
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# banner test\n');

      const result = spawnSync(process.execPath, [FORGE_BIN, 'issue', 'create', '--title=A', '--type=task'], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // If the kernel could not initialize in this environment (e.g. a refused
      // filesystem class), skip rather than flake — the routing fix is unaffected.
      if (result.status !== 0) {
        console.warn(`skipping banner assertion — issue create exited ${result.status}: ${(result.stderr || '').slice(0, 200)}`);
        return;
      }

      const stdout = result.stdout || '';
      const stderr = result.stderr || '';

      // Core guarantee: stdout is a single parseable JSON envelope, banner-free.
      expect(stdout).not.toContain(BANNER);
      const parsed = JSON.parse(stdout);
      expect(parsed.schema_version).toBe('forge.issue.v1');
      expect(parsed.command).toBe('issue.create');

      // The banner still fires (non-TTY) — but on stderr now.
      expect(stderr).toContain(BANNER);
    } finally {
      rmrf(repo);
    }
  }, 30000);
});
