const { describe, test, expect } = require('bun:test');
const path = require('node:path');

const { checkSkillsSync } = require('../../lib/skills-sync');

const repoRoot = path.resolve(__dirname, '../..');

// ─── skills drift detection (replaces the removed command-sync gate) ──────────
//
// Canonical skills live in root skills/. Generated agent mirrors (the committed
// .codex/skills, plus any locally-populated .claude/skills/.cursor/skills) must
// match. This is the in-repo equivalent of `skills sync --check`; it uses the
// dependency-free lib so it runs in `bun test` without the @forge/skills deps.

describe('skills sync drift detection', () => {
  test('generated agent skill mirrors are in sync with canonical skills/', () => {
    const result = checkSkillsSync({ repoRoot });

    if (!result.inSync) {
      const listing = result.drift
        .map((d) => `  [${d.agent}] ${d.skill}/${d.file} — ${d.status}`)
        .join('\n');
      throw new Error(
        'Skill drift detected. Run "forge setup" (or "skills sync") and commit the regenerated ' +
        `agent skill dirs.\n${listing}`
      );
    }

    expect(result.drift).toHaveLength(0);
  });

  test('the committed .codex/skills mirror is among the checked agents', () => {
    const result = checkSkillsSync({ repoRoot });
    expect(result.checkedAgents).toContain('.codex/skills');
  });
});
