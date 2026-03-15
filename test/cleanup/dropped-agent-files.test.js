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

  const droppedDirs = [
    '.agent',
    '.agents',
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
