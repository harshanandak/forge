/**
 * Tests for documentation references — ensures docs are updated for agent-parity.
 */

const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const repoRoot = path.resolve(__dirname, '..');

describe('docs references', () => {
  test('CLAUDE.md references commands/ directory for sync', () => {
    const content = fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    // Should mention commands/ as canonical source or in sync context
    expect(
      content.includes('commands/') ||
      content.includes('`.claude/commands/') // backwards-compat mention is OK
    ).toBe(true);
  });

  test('package.json includes commands/ in files array', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('commands/');
  });

  test('sync-commands.js reads from commands/ as canonical source', () => {
    const syncSource = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'sync-commands.js'),
      'utf8'
    );
    expect(syncSource).toContain("path.join(repoRoot, 'commands')");
  });

  test('check-agents.js error message references commands/', () => {
    const checkSource = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'check-agents.js'),
      'utf8'
    );
    expect(checkSource).toContain('commands/');
  });
});
