const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

// ─── skill context-cost gate (progressive-disclosure budget) ──────────────────
//
// A skill's description loads into EVERY session (the permanent per-skill cost),
// and its body loads on every trigger. This gate keeps both within budget so the
// skill library stays token-lean and descriptions are not truncated by host
// runtimes. Phase A #2 of the 2026-07-05 efficiency strategy; pairs with the
// description trim (#294) so descriptions cannot drift back over the cap.

const repoRoot = path.resolve(__dirname, '../..');
const skillsDir = path.join(repoRoot, 'skills');

const DESCRIPTION_CHAR_CAP = 1024; // Anthropic Agent Skills spec limit (hard)
const BODY_LINE_CAP = 500; // progressive-disclosure budget (loads on trigger)

// Skills whose body still exceeds BODY_LINE_CAP, pending a references/ split.
// Empty as of Phase A3 (rollback and plan were split into references/). The
// "allowlist stays honest" test below forces removal once a skill is back within
// budget, so the gate only ever tightens.
const BODY_OVER_ALLOWLIST = new Set([]);

function listSkills() {
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

function parseSkill(name) {
  const text = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') throw new Error(`${name}/SKILL.md: missing frontmatter`);
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { fmEnd = i; break; }
  }
  if (fmEnd === -1) throw new Error(`${name}/SKILL.md: unterminated frontmatter`);
  const fm = lines.slice(1, fmEnd).join('\n');
  const m = fm.match(/description:\s*([\s\S]*?)(?:\n[A-Za-z_-]+:|$)/);
  const description = m ? m[1].replace(/^>\s*/, '').replace(/\s+/g, ' ').trim() : '';
  const bodyLines = lines.length - (fmEnd + 1);
  return { name, description, descLen: description.length, bodyLines };
}

describe('skill context cost', () => {
  const skills = listSkills().map(parseSkill);

  test('every skill has a non-empty description', () => {
    const empty = skills.filter((s) => s.descLen === 0).map((s) => s.name);
    expect(empty).toEqual([]);
  });

  test('every skill description is within the 1024-char Anthropic cap', () => {
    const over = skills.filter((s) => s.descLen > DESCRIPTION_CHAR_CAP);
    if (over.length) {
      throw new Error(
        'Skill descriptions over the 1024-char Anthropic Agent Skills cap ' +
        '(descriptions load into every session and hosts may truncate the tail):\n' +
        over.map((s) => `  ${s.name}: ${s.descLen} chars (~${Math.ceil(s.descLen / 4)} tok)`).join('\n')
      );
    }
    expect(over).toHaveLength(0);
  });

  test('every skill body is <=500 lines (except the documented A3 backlog)', () => {
    const over = skills.filter((s) => s.bodyLines > BODY_LINE_CAP && !BODY_OVER_ALLOWLIST.has(s.name));
    if (over.length) {
      throw new Error(
        'Skill bodies over the 500-line budget (move detail into references/ per Phase A3):\n' +
        over.map((s) => `  ${s.name}: ${s.bodyLines} lines`).join('\n')
      );
    }
    expect(over).toHaveLength(0);
  });

  test('the body allowlist stays honest (drain entries as A3 shrinks bodies)', () => {
    const stale = [...BODY_OVER_ALLOWLIST]
      .filter((n) => skills.some((s) => s.name === n))
      .filter((n) => skills.find((s) => s.name === n).bodyLines <= BODY_LINE_CAP);
    if (stale.length) {
      throw new Error(
        `Remove from BODY_OVER_ALLOWLIST — now within the 500-line budget: ${stale.join(', ')}`
      );
    }
    expect(stale).toHaveLength(0);
  });
});
