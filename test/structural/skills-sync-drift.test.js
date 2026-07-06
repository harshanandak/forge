const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  checkSkillsSync,
  populateAgentSkills,
  listCanonicalSkills,
  diffSkillDir,
  AGENT_SKILL_DIRS,
} = require('../../lib/skills-sync');

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

// ─── all four harnesses render correctly from source (regenerate-into-temp) ────
//
// `.codex/skills` and `.agents/skills` are committed as the sentinel mirrors
// (`.agents/skills` is Codex's repo-local discovery path — checked in so teammates
// who clone WITHOUT running setup still get discovery). Rather than also committing
// `.claude/.cursor/.hermes` skill mirrors (which fights the gitignored,
// setup-populated design and bloats the repo), we prove drift-freedom for ALL
// harness surfaces by regenerating each into a temp dir from the canonical source
// and asserting a byte-identical render. This guards Claude/Cursor/Hermes from
// silently rotting even though their dirs are not committed.

describe('all harness skill dirs render from canonical source', () => {
  test('AGENT_SKILL_DIRS covers every harness surface (incl. Codex repo-local .agents/skills)', () => {
    expect(AGENT_SKILL_DIRS).toEqual([
      '.agents/skills',
      '.claude/skills',
      '.codex/skills',
      '.cursor/skills',
      '.hermes/skills',
    ]);
  });

  test('each harness dir regenerates byte-identically from skills/', () => {
    const canonical = listCanonicalSkills(repoRoot);
    expect(canonical.length).toBeGreaterThan(0);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skills-'));
    try {
      for (const rel of AGENT_SKILL_DIRS) {
        const targetSkillsDir = path.join(tmp, rel);
        populateAgentSkills({ sourceRoot: repoRoot, targetSkillsDir, clean: true });
        for (const skill of canonical) {
          const drift = diffSkillDir(skill.sourcePath, path.join(targetSkillsDir, skill.name));
          expect(drift).toEqual([]);
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
