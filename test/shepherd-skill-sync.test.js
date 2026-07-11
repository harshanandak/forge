'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { checkSkillsSync } = require('../lib/skills-sync');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('shepherd skill sync', () => {
  test('skill mirrors are in sync with canonical skills/ (skills sync --check)', () => {
    const result = checkSkillsSync({ repoRoot: ROOT });
    expect(result.inSync).toBe(true);
  });

  test('canonical skills/shepherd/SKILL.md exists and is token-clean', () => {
    const src = read('skills/shepherd/SKILL.md');
    expect(src.length).toBeGreaterThan(0);
    expect(/\bbd\b/i.test(src)).toBe(false);
    expect(/\.beads\b/i.test(src)).toBe(false);
    expect(/\bdolt\b/i.test(src)).toBe(false);
  });

  test('shepherd skill never promises merge or thread resolution', () => {
    const src = read('skills/shepherd/SKILL.md');
    expect(/gh pr merge/.test(src)).toBe(false);
    expect(/--auto-merge/.test(src)).toBe(false);
    expect(/never merges/i.test(src)).toBe(true);
    expect(/never resolves/i.test(src) || /resolution[^.]*stays with/i.test(src)).toBe(true);
  });

  test('canonical skills/shepherd/SKILL.md is the single committed source (mirror generated at setup)', () => {
    // Mirrors are generated at `forge setup` and gitignored; skills/ is the only
    // committed source. When a generated .codex/skills mirror is present locally it
    // must match canonical, but on a clean checkout its absence is not a failure.
    const canonical = read('skills/shepherd/SKILL.md').replace(/\r\n/g, '\n');
    expect(canonical.length).toBeGreaterThan(0);

    const codexMirror = path.join(ROOT, '.codex', 'skills', 'shepherd', 'SKILL.md');
    if (fs.existsSync(codexMirror)) {
      expect(fs.readFileSync(codexMirror, 'utf8').replace(/\r\n/g, '\n')).toBe(canonical);
    }
  });

  test('no Hermes shepherd skill file exists (Hermes dir is absent / not committed)', () => {
    const hermesCandidate = path.join(ROOT, '.hermes', 'skills', 'shepherd');
    expect(fs.existsSync(hermesCandidate)).toBe(false);
  });
});
