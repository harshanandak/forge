/**
 * Structural checks for the skills-first surface (A0d migration).
 *
 * Before A0d: canonical stage docs lived in `.claude/commands/*.md`.
 * After  A0d: canonical source is `skills/<stage>/SKILL.md`; the
 *             `.claude/commands/` directory has been deleted.
 */

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

// ─── deletion guard ──────────────────────────────────────────────────────────

describe('.claude/commands/ deletion (A0d)', () => {
  test('.claude/commands/ directory does not exist', () => {
    const commandsDir = path.join(repoRoot, '.claude', 'commands');
    expect(fs.existsSync(commandsDir)).toBe(false);
  });

  test('.cursor/commands/ directory does not exist', () => {
    const cursorCommandsDir = path.join(repoRoot, '.cursor', 'commands');
    expect(fs.existsSync(cursorCommandsDir)).toBe(false);
  });
});

// ─── canonical skills source ─────────────────────────────────────────────────

const STAGE_SKILLS = ['plan', 'dev', 'validate', 'ship', 'review', 'premerge', 'verify'];
const skillsDir = path.join(repoRoot, 'skills');

describe('skills/ canonical source', () => {
  test('skills/ directory exists', () => {
    expect(fs.existsSync(skillsDir)).toBe(true);
  });

  for (const stage of STAGE_SKILLS) {
    const skillPath = path.join(skillsDir, stage, 'SKILL.md');

    test(`skills/${stage}/SKILL.md exists`, () => {
      expect(fs.existsSync(skillPath)).toBe(true);
    });

    test(`skills/${stage}/SKILL.md is not truncated (> 1000 bytes)`, () => {
      const size = fs.statSync(skillPath).size;
      expect(size).toBeGreaterThan(1000);
    });

    test(`skills/${stage}/SKILL.md contains at least one ## section header`, () => {
      const content = fs.readFileSync(skillPath, 'utf8');
      expect(/^##\s/m.test(content)).toBe(true);
    });
  }
});

// ─── plan skill content checks ───────────────────────────────────────────────

describe('skills/plan/SKILL.md content checks', () => {
  const planPath = path.join(skillsDir, 'plan', 'SKILL.md');

  test('contains HARD-GATE at least 3 times', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    const count = (content.match(/HARD-GATE/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('contains Phase 1 section', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    expect(content).toContain('Phase 1');
  });

  test('contains Phase 2 section', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    expect(content).toContain('Phase 2');
  });

  test('contains Phase 3 section', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    expect(content).toContain('Phase 3');
  });

  test('contains "design doc" reference', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    expect(content.toLowerCase()).toContain('design doc');
  });

  test('contains "task list" reference', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    expect(content.toLowerCase()).toContain('task list');
  });

  test('has balanced triple-backtick code blocks (even count)', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    const count = (content.match(/```/g) || []).length;
    expect(count % 2).toBe(0);
  });

  test('contains blast-radius search section', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    expect(content).toContain('blast-radius');
  });
});

// ─── dev skill content checks ─────────────────────────────────────────────────

describe('skills/dev/SKILL.md content checks', () => {
  const devPath = path.join(skillsDir, 'dev', 'SKILL.md');

  test('contains HARD-GATE at least 4 times', () => {
    const content = fs.readFileSync(devPath, 'utf8');
    const count = (content.match(/HARD-GATE/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test('contains TDD or RED-GREEN-REFACTOR reference', () => {
    const content = fs.readFileSync(devPath, 'utf8');
    expect(content.includes('TDD') || content.includes('RED-GREEN-REFACTOR')).toBe(true);
  });

  test('contains "spec compliance" reference', () => {
    const content = fs.readFileSync(devPath, 'utf8');
    expect(content.toLowerCase()).toContain('spec compliance');
  });

  test('contains "decisions log" reference', () => {
    const content = fs.readFileSync(devPath, 'utf8');
    expect(content.toLowerCase()).toContain('decisions log');
  });

  test('has balanced triple-backtick code blocks (even count)', () => {
    const content = fs.readFileSync(devPath, 'utf8');
    const count = (content.match(/```/g) || []).length;
    expect(count % 2).toBe(0);
  });
});

// ─── dead reference checks ───────────────────────────────────────────────────

describe('dead reference checks in canonical skills', () => {
  const skillFiles = STAGE_SKILLS.map(stage => ({
    stage,
    content: fs.readFileSync(path.join(skillsDir, stage, 'SKILL.md'), 'utf8'),
  }));

  function findMatches(pattern) {
    const hits = [];
    for (const { stage, content } of skillFiles) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          hits.push(`${stage}/SKILL.md:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    return hits;
  }

  test('no skill file references "openspec" (removed tool)', () => {
    expect(findMatches(/openspec/i)).toEqual([]);
  });

  test('no skill file references "/merge" as stage name (renamed to /premerge)', () => {
    expect(findMatches(/(?<!\w)\/merge\b/)).toEqual([]);
  });

  test('no skill file references "/check" as stage name (renamed to /validate)', () => {
    expect(findMatches(/(?<!\w)\/check\b(?![-\w])/)).toEqual([]);
  });

  test('no skill file references "docs/planning/PROGRESS.md" (removed file)', () => {
    expect(findMatches(/docs\/planning\/PROGRESS\.md/)).toEqual([]);
  });

  test('no skill file references "9-stage" or "nine stage"', () => {
    expect(findMatches(/9-stage|nine.stage/i)).toEqual([]);
  });
});
