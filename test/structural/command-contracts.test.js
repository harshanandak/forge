const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

// Find repo root
const repoRoot = path.resolve(__dirname, '../..');

const commandsDir = path.join(repoRoot, '.claude', 'commands');

/**
 * Read a command file and return its content.
 * @param {string} filename - The command file name (e.g. 'plan.md')
 * @returns {string} The file content
 */
function readCommand(filename) {
  return fs.readFileSync(path.join(commandsDir, filename), 'utf8');
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
   * /plan produces a design doc at docs/work/YYYY-MM-DD-<slug>/design.md
   * /ship must reference the same pattern in its PR body.
   */
  const designDocPattern = /docs\/work\/YYYY-MM-DD-<slug>\/design\.md/;

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

// ─── Contract 5: All 7 workflow commands have correct stage numbers ─────────

describe('Contract: all 7 workflow commands reference correct stage numbers', () => {
  /**
   * Each workflow command file must contain an "Integration with Workflow"
   * section that assigns the correct stage number to each command:
   *   plan=1, dev=2, validate=3, ship=4, review=5, premerge=6, verify=7
   */
  const expectedStages = [
    { command: 'plan', stage: 1 },
    { command: 'dev', stage: 2 },
    { command: 'validate', stage: 3 },
    { command: 'ship', stage: 4 },
    { command: 'review', stage: 5 },
    { command: 'premerge', stage: 6 },
    { command: 'verify', stage: 7 },
  ];

  for (const { command, stage } of expectedStages) {
    test(`${command}.md assigns Stage ${stage} to /${command}`, () => {
      const content = readCommand(`${command}.md`);
      // Match pattern like "Stage 3: /validate" allowing flexible whitespace
      const pattern = new RegExp(`Stage\\s+${stage}:\\s+/${command}\\b`);
      expect(pattern.test(content)).toBeTruthy();
    });
  }
});
