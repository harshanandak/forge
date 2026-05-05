const { describe, it, expect } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');

/**
 * Reads a file relative to the project root.
 * @param {string} relPath - Relative path from project root
 * @returns {string} File contents as UTF-8 string
 */
function readDoc(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

describe('README.md consistency', () => {
  const readme = readDoc('README.md');

  it('uses bun add -D for install command (dev dependency)', () => {
    expect(readme).toContain('bun add -D forge-workflow');
  });

  it('does not use the old bun install command for package install', () => {
    // The old install command should not appear as the primary install instruction.
    // We check that "bun install forge-workflow" does NOT appear (it was replaced).
    // Note: "bun install" alone (for deps) is fine; we specifically check the package name.
    expect(readme).not.toContain('bun install forge-workflow');
  });

  it('documents --dry-run flag', () => {
    expect(readme).toContain('--dry-run');
  });

  it('documents --non-interactive flag', () => {
    expect(readme).toContain('--non-interactive');
  });

  it('documents --symlink flag', () => {
    expect(readme).toContain('--symlink');
  });

  it('documents --sync flag', () => {
    expect(readme).toContain('--sync');
  });

  it('documents --agents flag', () => {
    expect(readme).toContain('--agents');
  });

  it('mentions CI auto-detection', () => {
    expect(readme).toContain('CI=true');
  });
});

describe('docs/guides/SETUP.md consistency', () => {
  const setup = readDoc('docs/guides/SETUP.md');

  it('mentions install.sh is a bootstrapper', () => {
    expect(setup).toContain('bootstrapper');
  });

  it('documents PAT requirements for Beads sync', () => {
    // Should mention either PAT or BEADS_SYNC_TOKEN
    const mentionsPat = setup.includes('PAT') || setup.includes('BEADS_SYNC_TOKEN');
    expect(mentionsPat).toBe(true);
  });

  it('documents Beads sync setup with --sync flag', () => {
    expect(setup).toContain('--sync');
  });

  it('uses bun add -D for install command (dev dependency)', () => {
    expect(setup).toContain('bun add -D forge-workflow');
  });
});

describe('CHANGELOG.md consistency', () => {
  const changelog = readDoc('CHANGELOG.md');

  it('has an entry for the install-fixes changes', () => {
    // Should mention key features from this branch
    expect(changelog).toContain('bootstrapper');
  });

  it('mentions --dry-run in changelog', () => {
    expect(changelog).toContain('--dry-run');
  });

  it('mentions --symlink in changelog', () => {
    expect(changelog).toContain('--symlink');
  });

  it('mentions Beads sync', () => {
    const mentionsBeadsSync = changelog.includes('Beads sync') || changelog.includes('beads sync');
    expect(mentionsBeadsSync).toBe(true);
  });
});
