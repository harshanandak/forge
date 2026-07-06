'use strict';

// Regression test for the onboarding-discoverability gap (kernel issue: onboarding
// surface, 0.1.0 clean release): `forge setup` generates a project's AGENTS.md by
// copying Forge's own root AGENTS.md (see lib/commands/setup.js — copyFile /
// smartMergeAgentsMd of `<packageDir>/AGENTS.md`), NOT the unused generic generator
// in lib/agents-config.js. That means the root AGENTS.md IS the source new users and
// agents read. It previously told agents to `forge remember` for persistent
// knowledge but never mentioned `forge recall` to read it back, and never surfaced
// `forge merge`, `forge insights`, `forge upgrade`, `forge gate`, or `forge role`.
//
// This test drives the REAL `forge setup` CLI (not the dead agents-config.js
// generator that test/agents-md-generation.test.js exercises) against a fresh git
// repo, so it fails if the source AGENTS.md regresses OR if setup's copy/merge
// mechanism stops sourcing from the root AGENTS.md.

const { describe, test, expect } = require('bun:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
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

describe('onboarding surface: setup-generated AGENTS.md', () => {
  test('surfaces forge recall next to forge remember, and the previously-invisible commands', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-onboarding-surface-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      spawnSync('git', ['-c', 'user.email=a@a.com', '-c', 'user.name=a', 'commit', '-q', '-m', 'init', '--allow-empty'], { cwd: repo });

      const result = spawnSync(process.execPath, [FORGE_BIN, 'setup', '--yes', '--agent=claude'], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      });

      expect(result.status).toBe(0);

      const agentsMdPath = path.join(repo, 'AGENTS.md');
      expect(fs.existsSync(agentsMdPath)).toBe(true);
      const content = fs.readFileSync(agentsMdPath, 'utf8');

      // Memory loop: recall must be documented alongside remember, not just remember.
      expect(content).toContain('forge remember');
      expect(content).toContain('forge recall');

      // Previously-invisible commands (0 mentions before this fix).
      expect(content).toContain('forge merge');
      expect(content).toContain('forge insights');
      expect(content).toContain('forge upgrade');
      expect(content).toContain('forge gate');
      expect(content).toContain('forge role');
    } finally {
      rmrf(repo);
    }
  }, 60000);
});
