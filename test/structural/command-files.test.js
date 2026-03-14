const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

// Find repo root
const repoRoot = path.resolve(__dirname, '../..');

const commandsDir = path.join(repoRoot, '.claude', 'commands');

// ─── plan.md ────────────────────────────────────────────────────────────────

describe('.claude/commands/plan.md structural checks', () => {
  const planPath = path.join(commandsDir, 'plan.md');

  test('plan.md exists', () => {
    expect(fs.existsSync(planPath)).toBeTruthy();
  });

  test('plan.md is not truncated (> 1000 bytes)', () => {
    const size = fs.statSync(planPath).size;
    expect(size).toBeGreaterThan(1000);
  });

  test('plan.md contains HARD-GATE at least 3 times', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    const count = (content.match(/HARD-GATE/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('plan.md contains Phase 1 section', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    expect(content).toContain('Phase 1');
  });

  test('plan.md contains Phase 2 section', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    expect(content).toContain('Phase 2');
  });

  test('plan.md contains Phase 3 section', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    expect(content).toContain('Phase 3');
  });

  test('plan.md contains "design doc" reference', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    expect(content.toLowerCase()).toContain('design doc');
  });

  test('plan.md contains "task list" reference', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    expect(content.toLowerCase()).toContain('task list');
  });

  test('plan.md has balanced triple-backtick code blocks (even count)', () => {
    const content = fs.readFileSync(planPath, 'utf8');
    const count = (content.match(/```/g) || []).length;
    expect(count % 2).toBe(0);
  });
});

// ─── dev.md ──────────────────────────────────────────────────────────────────

describe('.claude/commands/dev.md structural checks', () => {
  const devPath = path.join(commandsDir, 'dev.md');

  test('dev.md exists', () => {
    expect(fs.existsSync(devPath)).toBeTruthy();
  });

  test('dev.md is not truncated (> 1000 bytes)', () => {
    const size = fs.statSync(devPath).size;
    expect(size).toBeGreaterThan(1000);
  });

  test('dev.md contains HARD-GATE at least 4 times', () => {
    const content = fs.readFileSync(devPath, 'utf8');
    const count = (content.match(/HARD-GATE/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test('dev.md contains TDD or RED-GREEN-REFACTOR reference', () => {
    const content = fs.readFileSync(devPath, 'utf8');
    expect(content.includes('TDD') || content.includes('RED-GREEN-REFACTOR')).toBeTruthy();
  });

  test('dev.md contains "spec compliance" reference', () => {
    const content = fs.readFileSync(devPath, 'utf8');
    expect(content.toLowerCase()).toContain('spec compliance');
  });

  test('dev.md contains "decisions log" reference', () => {
    const content = fs.readFileSync(devPath, 'utf8');
    expect(content.toLowerCase()).toContain('decisions log');
  });

  test('dev.md has balanced triple-backtick code blocks (even count)', () => {
    const content = fs.readFileSync(devPath, 'utf8');
    const count = (content.match(/```/g) || []).length;
    expect(count % 2).toBe(0);
  });
});

// ─── all command files (general) ─────────────────────────────────────────────

describe('.claude/commands/ general structural checks', () => {
  test('.claude/commands/ directory exists', () => {
    expect(fs.existsSync(commandsDir)).toBeTruthy();
  });

  const commandFiles = fs.existsSync(commandsDir)
    ? fs.readdirSync(commandsDir)
    : [];

  test('.claude/commands/ contains at least one file', () => {
    expect(commandFiles.length).toBeGreaterThan(0);
  });

  for (const filename of commandFiles) {
    test(`${filename} has .md extension`, () => {
      expect(filename.endsWith('.md')).toBeTruthy();
    });

    test(`${filename} is not empty (> 0 bytes)`, () => {
      const filePath = path.join(commandsDir, filename);
      const size = fs.statSync(filePath).size;
      expect(size).toBeGreaterThan(0);
    });

    test(`${filename} contains at least one ## section header`, () => {
      const filePath = path.join(commandsDir, filename);
      const content = fs.readFileSync(filePath, 'utf8');
      expect(/^##\s/m.test(content)).toBeTruthy();
    });
  }
});

// ─── dead reference checks ──────────────────────────────────────────────────

describe('dead reference checks', () => {
  const mdFiles = fs.existsSync(commandsDir)
    ? fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md'))
    : [];

  /**
   * Read all command files once and build a map of filename -> content.
   * @type {Array<{filename: string, content: string}>}
   */
  const fileContents = mdFiles.map((filename) => ({
    filename,
    content: fs.readFileSync(path.join(commandsDir, filename), 'utf8'),
  }));

  /**
   * Helper: assert that no command file matches the given pattern.
   * Returns an array of "filename:lineNum" strings for each match found.
   * @param {RegExp} pattern - regex to test against each line
   * @returns {string[]} matches found (empty = pass)
   */
  function findMatches(pattern) {
    const hits = [];
    for (const { filename, content } of fileContents) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          hits.push(`${filename}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    return hits;
  }

  test('no command file references "openspec" (removed tool)', () => {
    const hits = findMatches(/openspec/i);
    expect(hits).toEqual([]);
  });

  test('no command file references "/merge" as stage name (renamed to /premerge)', () => {
    // Match /merge but NOT /premerge — negative lookbehind for word chars
    const hits = findMatches(/(?<!\w)\/merge\b/);
    expect(hits).toEqual([]);
  });

  test('no command file references "/check" as stage name (renamed to /validate)', () => {
    // Match /check as a standalone stage name, not as part of compound words
    // like "typecheck", "check-agents", or "/checkout"
    const hits = findMatches(/(?<!\w)\/check\b(?![-\w])/);
    expect(hits).toEqual([]);
  });

  test('no command file references "docs/planning/PROGRESS.md" (removed file)', () => {
    const hits = findMatches(/docs\/planning\/PROGRESS\.md/);
    expect(hits).toEqual([]);
  });

  test('no command file references "9-stage" or "nine stage" (now 7 stages)', () => {
    const hits = findMatches(/9-stage|nine.stage/i);
    expect(hits).toEqual([]);
  });
});
