const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const COMMANDS_DIR = path.resolve(__dirname, '..', '.claude', 'commands');

const COMMAND_FILES = [
  'plan.md',
  'dev.md',
  'validate.md',
  'ship.md',
  'review.md',
  'premerge.md',
];

describe('Command files reference context convention', () => {
  for (const file of COMMAND_FILES) {
    const filePath = path.join(COMMANDS_DIR, file);

    test(`${file} contains beads-context.sh validate reference`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('beads-context.sh validate');
    });

    test(`${file} contains --summary flag in a stage-transition example`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('--summary');
    });
  }
});
