'use strict';

const { describe, test, expect } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('shepherd skill sync', () => {
  test('node scripts/sync-commands.js --check exits 0 (in sync)', () => {
    const res = execFileSync('node', ['scripts/sync-commands.js', '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    // execFileSync throws on non-zero exit; reaching here means exit 0.
    expect(typeof res).toBe('string');
  });

  test('canonical .claude/commands/shepherd.md exists and is token-clean', () => {
    const src = read('.claude/commands/shepherd.md');
    expect(src.length).toBeGreaterThan(0);
    expect(/\bbd\b/i.test(src)).toBe(false);
    expect(/\.beads\b/i.test(src)).toBe(false);
    expect(/\bdolt\b/i.test(src)).toBe(false);
  });

  test('shepherd.md never promises merge or thread resolution', () => {
    const src = read('.claude/commands/shepherd.md');
    expect(/gh pr merge/.test(src)).toBe(false);
    expect(/--auto-merge/.test(src)).toBe(false);
    expect(/never merges/i.test(src)).toBe(true);
    expect(/never resolves/i.test(src) || /resolution[^.]*stays with/i.test(src)).toBe(true);
  });

  test('cursor output exists with frontmatter stripped', () => {
    const cursor = read('.cursor/commands/shepherd.md');
    expect(cursor.startsWith('---')).toBe(false);
    expect(cursor).toContain('Shepherd');
  });

  test('codex output exists at .codex/skills/shepherd/SKILL.md with a kept description', () => {
    const codex = read('.codex/skills/shepherd/SKILL.md');
    expect(codex).toContain('description:');
    expect(codex).toContain('Shepherd');
  });

  test('no Hermes shepherd file is created by sync (Hermes is not a sync target)', () => {
    const hermesCandidate = path.join(ROOT, '.hermes', 'skills', 'shepherd');
    expect(fs.existsSync(hermesCandidate)).toBe(false);
  });
});
