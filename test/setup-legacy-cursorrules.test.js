const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { backupAndRemoveLegacyCursorRules } = require('../lib/commands/setup');

// ── C3: a user's hand-authored .cursorrules must be backed up, never destroyed ──
// `.cursorrules` predates AGENTS.md, so real users have curated ones. Setup drops
// the deprecated surface but MUST preserve the content (mirror the AGENTS.md
// markerless-backup behavior).

describe('legacy .cursorrules cleanup preserves user data (C3)', () => {
  function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cursorrules-'));
  }

  test('existing .cursorrules is backed up to .cursorrules.bak before removal', () => {
    const root = tmp();
    try {
      const original = '# My curated Cursor rules\nAlways use tabs.\n';
      fs.writeFileSync(path.join(root, '.cursorrules'), original);

      const result = backupAndRemoveLegacyCursorRules(root);

      expect(result.removed).toBe(true);
      // Deprecated file removed
      expect(fs.existsSync(path.join(root, '.cursorrules'))).toBe(false);
      // ...but content preserved in the backup (NOT lost)
      const backup = path.join(root, '.cursorrules.bak');
      expect(fs.existsSync(backup)).toBe(true);
      expect(fs.readFileSync(backup, 'utf-8')).toBe(original);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('repeated cleanup never overwrites an earlier backup (numbered .bak.N)', () => {
    const root = tmp();
    try {
      fs.writeFileSync(path.join(root, '.cursorrules.bak'), 'earlier backup');
      fs.writeFileSync(path.join(root, '.cursorrules'), 'new content');

      const result = backupAndRemoveLegacyCursorRules(root);

      expect(result.removed).toBe(true);
      expect(fs.readFileSync(path.join(root, '.cursorrules.bak'), 'utf-8')).toBe('earlier backup');
      expect(fs.readFileSync(path.join(root, '.cursorrules.bak.1'), 'utf-8')).toBe('new content');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('no-op when there is no .cursorrules', () => {
    const root = tmp();
    try {
      const result = backupAndRemoveLegacyCursorRules(root);
      expect(result.removed).toBe(false);
      expect(fs.existsSync(path.join(root, '.cursorrules.bak'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
