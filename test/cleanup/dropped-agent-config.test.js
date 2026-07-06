const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

describe('dropped-agent refs in config files', () => {
  describe('package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    test('description uses runtime control plane language (not fixed stage count)', () => {
      expect(pkg.description).toContain('Local runtime control plane');
      expect(pkg.description).toContain('all AI agents');
      expect(pkg.description).not.toContain('7-stage');
      expect(pkg.description).not.toContain('9-stage');
    });

    test('keywords do not include dropped agents', () => {
      const dropped = ['windsurf', 'aider', 'continue', 'antigravity'];
      for (const keyword of dropped) {
        expect(pkg.keywords).not.toContain(keyword);
      }
    });
  });

  describe('.gitignore', () => {
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    // Active ignore rules only — comment lines (which may legitimately MENTION a
    // path, e.g. the note that `.agents/skills` is a committed mirror) are excluded.
    const activeEntries = gitignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    test('does not actively gitignore dropped-agent dirs (or the committed .agents/skills)', () => {
      // `.agents/` is now a FORBIDDEN active ignore: `.agents/skills` is Codex's
      // committed repo-local discovery mirror — gitignoring it would silently break
      // teammate-clone discovery. The rest are dropped agents.
      const droppedEntries = ['.agents/', '.agent/', '.aider/', '.continue/skills', '.windsurf/skills'];
      for (const entry of droppedEntries) {
        expect(activeEntries.some((line) => line.includes(entry))).toBe(false);
      }
    });
  });
});
