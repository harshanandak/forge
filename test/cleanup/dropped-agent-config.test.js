const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

describe('dropped-agent refs in config files', () => {
  describe('package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    test('description contains "7-stage" (not "9-stage")', () => {
      expect(pkg.description).toContain('7-stage');
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

    test('does not contain dropped-agent gitignore entries', () => {
      const droppedEntries = ['.agents/', '.agent/', '.aider/', '.continue/skills', '.windsurf/skills'];
      for (const entry of droppedEntries) {
        expect(gitignore).not.toContain(entry);
      }
    });
  });
});
