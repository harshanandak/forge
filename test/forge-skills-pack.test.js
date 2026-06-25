const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PACK_ROOT = path.join(ROOT, 'packages', 'skills', 'forge-plugin');
const { buildReadinessReport } = require('../lib/release-readiness.js');

// Mirror REQUIRED_FORGE_SKILLS from lib/release-readiness.js (internal constant).
// Each skill's SKILL.md must document at least one of the wrapped forge commands.
const REQUIRED_SKILLS = [
  { name: 'ready', commandPatterns: [/forge ready/, /forge issue ready/] },
  { name: 'show', commandPatterns: [/forge show/, /forge issue show/] },
  { name: 'claim', commandPatterns: [/forge claim/] },
  { name: 'comment', commandPatterns: [/forge comment/, /forge issue comment/] },
  { name: 'close', commandPatterns: [/forge close/, /forge issue close/] },
  { name: 'recap', commandPatterns: [/forge recap/] },
];

/**
 * Minimal YAML frontmatter reader: returns the `name` field of a SKILL.md so
 * we can assert each skill declares an identity matching its directory.
 */
function frontmatterName(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const line = match[1].split('\n').find(entry => entry.startsWith('name:'));
  return line ? line.slice('name:'.length).trim().replace(/^["']|["']$/g, '') : null;
}

describe('Forge CLI-wrapper skills pack', () => {
  test('manifest.json exists at the preferred pack root', () => {
    expect(fs.existsSync(path.join(PACK_ROOT, 'manifest.json'))).toBeTruthy();
  });

  test('manifest.json declares every required skill name', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PACK_ROOT, 'manifest.json'), 'utf8'));
    const declared = JSON.stringify(manifest);
    for (const skill of REQUIRED_SKILLS) {
      expect(declared.includes(`"${skill.name}"`)).toBeTruthy();
    }
  });

  for (const skill of REQUIRED_SKILLS) {
    const skillFile = path.join(PACK_ROOT, 'skills', skill.name, 'SKILL.md');

    test(`skills/${skill.name}/SKILL.md exists`, () => {
      expect(fs.existsSync(skillFile)).toBeTruthy();
    });

    test(`skills/${skill.name}/SKILL.md frontmatter name matches directory`, () => {
      expect(frontmatterName(skillFile)).toBe(skill.name);
    });

    test(`skills/${skill.name}/SKILL.md documents the wrapped forge command`, () => {
      const content = fs.readFileSync(skillFile, 'utf8');
      expect(skill.commandPatterns.some(pattern => pattern.test(content))).toBeTruthy();
    });
  }

  test('pack files never reference retired issue-store tooling', () => {
    const offenders = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(md|json)$/.test(entry.name)) {
          if (/\bbd\b|\.beads\b|\bdolt\b/i.test(fs.readFileSync(full, 'utf8'))) {
            offenders.push(path.relative(ROOT, full));
          }
        }
      }
    };
    walk(PACK_ROOT);
    expect(offenders).toEqual([]);
  });

  test('readiness gate no longer reports forge-skills-pack blocker', () => {
    const report = buildReadinessReport(ROOT, { target: '0.1.0' });
    const blockerIds = report.blockers.map(blocker => blocker.id);
    expect(blockerIds).not.toContain('forge-skills-pack');
  });
});
