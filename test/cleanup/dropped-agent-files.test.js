const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

describe('dropped-agent files removed', () => {
  const droppedFiles = [
    '.aider.conf.yml',
    'lib/agents/continue.plugin.json',
    'docs/research/agent-instructions-sync.md',
    'docs/README-v1.3.md',
  ];

  // `.agents` was dropped in 2026-03 as orphaned, gitignored skill cruft with no
  // plugin referencing it. It is NO LONGER dropped: Codex's documented repo-scope
  // discovery path is `.agents/skills` (checked in for the team, scanned cwd → repo
  // root — developers.openai.com/codex/skills), so Forge now generates + commits it
  // (kernel issue 55dfeccf). Only the singular `.agent` remains dropped cruft.
  const droppedDirs = [
    '.agent',
  ];

  for (const file of droppedFiles) {
    test(`${file} must not exist`, () => {
      expect(fs.existsSync(path.join(ROOT, file))).toBe(false);
    });
  }

  for (const dir of droppedDirs) {
    test(`${dir}/ directory must not exist`, () => {
      expect(fs.existsSync(path.join(ROOT, dir))).toBe(false);
    });
  }
});
