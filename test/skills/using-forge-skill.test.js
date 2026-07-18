'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { parseFrontmatter, stripFrontmatter } = require('../../lib/using-forge');
const { checkSkillsSync } = require('../../lib/skills-sync');

const repoRoot = path.resolve(__dirname, '../..');
const skillPath = path.join(repoRoot, 'skills', 'using-forge', 'SKILL.md');

// Caps mirror the skill-authoring contract: the harness only sees the description until the
// skill is invoked, so it must carry all triggering info within the 1024-char frontmatter cap;
// the body stays well under the 500-line ceiling.
const DESCRIPTION_CAP = 1024;
const BODY_LINE_CAP = 500;

describe('using-forge dispatch skill', () => {
  test('SKILL.md exists', () => {
    expect(fs.existsSync(skillPath)).toBe(true);
  });

  test('frontmatter name is using-forge and description is within the cap', () => {
    const raw = fs.readFileSync(skillPath, 'utf8');
    const fm = parseFrontmatter(raw);
    expect(fm.name).toBe('using-forge');
    expect(fm.description.length).toBeGreaterThan(0);
    expect(fm.description.length).toBeLessThanOrEqual(DESCRIPTION_CAP);
  });

  test('description carries trigger phrases and negative disambiguation', () => {
    const raw = fs.readFileSync(skillPath, 'utf8');
    const desc = parseFrontmatter(raw).description.toLowerCase();
    // trigger intent phrases
    expect(desc).toContain('before any response');
    expect(desc).toContain('1%');
    // negative disambiguation (what it is NOT)
    expect(desc).toContain('not itself a stage');
  });

  test('body is under the line cap and carries the dispatch essentials', () => {
    const raw = fs.readFileSync(skillPath, 'utf8');
    const body = stripFrontmatter(raw);
    expect(body.split(/\r?\n/).length).toBeLessThanOrEqual(BODY_LINE_CAP);
    expect(body).toContain('Red flags');
    expect(body).toContain('routing table');
    expect(body).toContain('Subagent escape hatch');
  });

  test('skills-sync reports no drift for the committed mirrors', () => {
    const result = checkSkillsSync({ repoRoot });
    const usingForgeDrift = result.drift.filter(d => d.skill === 'using-forge');
    expect(usingForgeDrift).toEqual([]);
  });
});
