const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.resolve(__dirname, '..', 'skills');

// The stage surface migrated from .claude/commands/<name>.md to the canonical
// skills/<name>/SKILL.md. The context convention now lives in the skills.
// Pre-merge is a doc-update gate embedded in ship/review, not a standalone skill.
//
// plan/dev are kernel-native: they record the same Summary/Decisions/Artifacts/Next
// context envelope directly on the Forge issue via `forge comment`, and MUST NOT
// depend on the legacy `scripts/beads-context.sh` helper. validate/ship/review still
// carry the optional beads-context.sh helper convention (de-Bead follow-up work).
const KERNEL_NATIVE_SKILLS = ['plan', 'dev'];
const LEGACY_HELPER_SKILLS = ['validate', 'ship', 'review'];

describe('Stage skills reference context convention', () => {
  for (const name of KERNEL_NATIVE_SKILLS) {
    const filePath = path.join(SKILLS_DIR, name, 'SKILL.md');

    test(`${name} skill records stage transitions kernel-natively (no beads-context.sh)`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).not.toContain('scripts/beads-context.sh');
      expect(content).toContain('forge comment');
    });

    test(`${name} skill carries the context envelope (Summary/Decisions/Artifacts/Next)`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('Summary:');
      expect(content).toContain('Decisions:');
      expect(content).toContain('Artifacts:');
      expect(content).toContain('Next:');
    });
  }

  for (const name of LEGACY_HELPER_SKILLS) {
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
