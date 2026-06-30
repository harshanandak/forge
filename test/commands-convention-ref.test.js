const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.resolve(__dirname, '..', 'skills');

// The stage surface migrated from .claude/commands/<name>.md to the canonical
// skills/<name>/SKILL.md. The context convention now lives in the skills.
// Pre-merge is a doc-update gate embedded in ship/review, not a standalone skill.
const STAGE_SKILLS = ['plan', 'dev', 'validate', 'ship', 'review'];

describe('Stage skills reference context convention', () => {
  for (const name of STAGE_SKILLS) {
    const filePath = path.join(SKILLS_DIR, name, 'SKILL.md');

    test(`${name} skill contains beads-context.sh validate reference`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('beads-context.sh validate');
    });

    test(`${name} skill contains --summary flag in a stage-transition example`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('--summary');
    });
  }
});
