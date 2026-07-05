const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

// Find repo root
const repoRoot = path.resolve(__dirname, '../..');

const skillsDir = path.join(repoRoot, 'skills');

/**
 * Read a stage skill's content by its former command filename.
 *
 * The command surface (`.claude/commands/<name>.md`) migrated to
 * `skills/<name>/SKILL.md`; these stage-to-stage contracts now hold against
 * the canonical skills. Map the legacy command name to its skill.
 * @param {string} filename - The legacy command file name (e.g. 'plan.md')
 * @returns {string} The skill content
 */
function readCommand(filename) {
  const name = filename.replace(/\.md$/, '');
  return fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
}

// ─── Contract 1: /plan task list output → /dev task list input ──────────────

describe('Contract: /plan task list output -> /dev task list input', () => {
  const planContent = readCommand('plan.md');
  const devContent = readCommand('dev.md');

  /**
   * /plan produces a task list at docs/work/YYYY-MM-DD-<slug>/tasks.md
   * /dev must expect to read from the same pattern.
   */
  const taskFilePattern = /docs\/work\/YYYY-MM-DD-<slug>\/tasks\.md/;

  test('/plan references the task list file pattern', () => {
    expect(taskFilePattern.test(planContent)).toBeTruthy();
  });

  test('/dev references the same task list file pattern', () => {
    expect(taskFilePattern.test(devContent)).toBeTruthy();
  });
});

// ─── Contract 2: /plan design doc output → /ship design doc reference ───────

describe('Contract: /plan design doc output -> /ship design doc reference', () => {
  const planContent = readCommand('plan.md');
  const shipContent = readCommand('ship.md');

  /**
   * /plan produces a design doc at docs/work/YYYY-MM-DD-<slug>/plan.md
   * /ship must reference the same pattern in its PR body.
   */
  const designDocPattern = /docs\/work\/YYYY-MM-DD-<slug>\/plan\.md/;

  test('/plan references the design doc file pattern', () => {
    expect(designDocPattern.test(planContent)).toBeTruthy();
  });

  test('/ship references the same design doc file pattern', () => {
    expect(designDocPattern.test(shipContent)).toBeTruthy();
  });
});

// ─── Contract 3: /dev test command → /validate test command ─────────────────

describe('Contract: /dev test command -> /validate runs tests', () => {
  const devContent = readCommand('dev.md');
  const validateContent = readCommand('validate.md');

  /**
   * /dev references running tests (bun test or TEST_COMMAND).
   * /validate must also run the same test command.
   */
  test('/dev references "bun test" as the test runner', () => {
    expect(devContent).toContain('bun test');
  });

  test('/validate references "bun test" as the test runner', () => {
    expect(validateContent).toContain('bun test');
  });
});

// ─── Contract 4: /ship creates PR → /review references PR ──────────────────

describe('Contract: /ship creates PR -> /review references PR', () => {
  const shipContent = readCommand('ship.md');
  const reviewContent = readCommand('review.md');

  /**
   * /ship uses gh pr create to open a pull request.
   * /review must reference pull request handling (gh pr view/checks).
   */
  test('/ship uses "gh pr create" to open the PR', () => {
    expect(shipContent).toContain('gh pr create');
  });

  test('/review references "gh pr" commands for PR handling', () => {
    expect(reviewContent).toContain('gh pr view');
    expect(reviewContent).toContain('gh pr checks');
  });
});

// Contract 5: workflow commands use configurable template language

describe('Contract: workflow commands use configurable template language', () => {
  /**
   * v3 treats the historical 7-stage ladder as one default template over
   * runtime building blocks. Command docs must not reintroduce hardcoded
   * Stage N gate language.
   */
  const workflowCommands = ['plan', 'dev', 'validate', 'ship', 'review', 'verify'];

  for (const command of workflowCommands) {
    test(`${command}.md references the default template without Stage N numbering`, () => {
      const content = readCommand(`${command}.md`);
      expect(content).toContain('Default template:');
      expect(content).not.toMatch(/\bStage\s+[1-7]\b\s*(?::|-|--|->|—|–)?/);
    });
  }
});
