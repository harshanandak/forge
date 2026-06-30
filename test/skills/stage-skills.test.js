const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

// Repo root
const repoRoot = path.resolve(__dirname, '../..');
const skillsDir = path.join(repoRoot, 'skills');

// The 11 workflow stage skills migrated from the removed .claude/commands/ surface,
// plus the `kernel` umbrella that indexes them. These are the canonical, committed
// skill source — agent harness dirs are generated from these by `forge setup` /
// `skills sync`. Pre-merge is a doc-update gate embedded in ship/review, not a skill.
const STAGE_SKILLS = [
  'plan',
  'dev',
  'validate',
  'verify',
  'ship',
  'review',
  'research',
  'rollback',
  'status',
  'sonarcloud',
  'shepherd',
];
const UMBRELLA_SKILLS = ['kernel'];
const ALL_SKILLS = [...STAGE_SKILLS, ...UMBRELLA_SKILLS];

// Forbidden Beads tokens — the stage surface must be fully Beads-free so it clears
// the D20 bd-hot-path gate (skill roots are hot-path surfaces). Matches the
// release-readiness audit intent: bare `bd`, `.beads` paths, and `dolt`.
const BD_PATTERNS = [/\bbd\b/i, /\.beads\b/, /\bdolt\b/i];

function readSkill(name) {
  const file = path.join(skillsDir, name, 'SKILL.md');
  return fs.readFileSync(file, 'utf8');
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error('no YAML frontmatter block');
  }
  return YAML.parse(match[1]);
}

describe('stage skill surface (skills/<stage>/SKILL.md)', () => {
  for (const name of ALL_SKILLS) {
    const file = path.join(skillsDir, name, 'SKILL.md');

    test(`${name}: SKILL.md exists`, () => {
      expect(fs.existsSync(file)).toBeTruthy();
    });

    test(`${name}: frontmatter parses as valid YAML`, () => {
      const content = readSkill(name);
      expect(() => parseFrontmatter(content)).not.toThrow();
    });

    test(`${name}: name matches directory name`, () => {
      const fm = parseFrontmatter(readSkill(name));
      expect(fm.name).toBe(name);
    });

    test(`${name}: has a non-empty description`, () => {
      const fm = parseFrontmatter(readSkill(name));
      expect(typeof fm.description).toBe('string');
      expect(fm.description.trim().length).toBeGreaterThan(20);
    });

    test(`${name}: declares allowed-tools`, () => {
      const fm = parseFrontmatter(readSkill(name));
      expect(typeof fm['allowed-tools']).toBe('string');
      expect(fm['allowed-tools'].trim().length).toBeGreaterThan(0);
    });

    test(`${name}: has body content after frontmatter`, () => {
      const content = readSkill(name);
      const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      expect(body.trim().length).toBeGreaterThan(100);
    });

    test(`${name}: is Beads-free (no bd / .beads / dolt tokens)`, () => {
      const lines = readSkill(name).split(/\r?\n/);
      const hits = [];
      lines.forEach((line, i) => {
        if (BD_PATTERNS.some((re) => re.test(line))) {
          hits.push(`L${i + 1}: ${line.trim()}`);
        }
      });
      expect(hits).toEqual([]);
    });
  }
});

describe('stage skill surface completeness', () => {
  test('all 11 stage skills + kernel umbrella are present', () => {
    const present = fs.existsSync(skillsDir)
      ? fs
          .readdirSync(skillsDir)
          .filter((entry) =>
            fs.existsSync(path.join(skillsDir, entry, 'SKILL.md'))
          )
      : [];
    for (const name of ALL_SKILLS) {
      expect(present).toContain(name);
    }
  });
});
