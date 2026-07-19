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
// Canonical skills live in root skills/. Generated agent mirrors must match it.
// `.agents/skills` is committed (Codex's repo-local discovery path) and is always
// present, so the gate always enforces it; the other mirrors (.claude/skills,
// .codex/skills, .cursor/skills, .hermes/skills) are gitignored and generated at
// `forge setup`, so checkSkillsSync validates only the ones that already exist on
// disk and a clean checkout with just `.agents/skills` is in sync. This is the
// in-repo equivalent of `skills sync --check`; it uses the dependency-free lib so
// it runs in `bun test` without the @forge/skills deps.

describe('skills sync drift detection', () => {
  test('generated agent skill mirrors are in sync with canonical skills/', () => {
    const result = checkSkillsSync({ repoRoot });

    if (!result.inSync) {
      const listing = result.drift
        .map((d) => `  [${d.agent}] ${d.skill}/${d.file} — ${d.status}`)
        .join('\n');
      throw new Error(
        'Skill drift detected. Run "forge setup" (or "skills sync") to regenerate the ' +
        `agent skill mirrors from skills/.\n${listing}`
      );
    }

    expect(result.drift).toHaveLength(0);
  });

  test('the committed .agents/skills mirror is always among the checked agents; every checked dir exists', () => {
    const result = checkSkillsSync({ repoRoot });
    // .agents/skills is committed, so it is always present and always enforced.
    expect(result.checkedAgents).toContain('.agents/skills');
    // Every checked agent must be a real directory on disk — absent (gitignored)
    // mirrors are skipped (absence ≠ drift), which keeps a fresh clone in sync.
    for (const rel of result.checkedAgents) {
      expect(fs.existsSync(path.join(repoRoot, rel))).toBe(true);
    }
  });
});

// ─── all harnesses render correctly from source (regenerate-into-temp) ─────────
//
// skills/ is the canonical source of truth. `.agents/skills` is the ONE committed
// mirror (Codex's repo-local discovery path — checked in so teammates who clone
// WITHOUT running setup still get discovery; kept byte-identical by a pre-commit
// hook + this drift gate). The other harness mirrors (.claude/skills, .codex/skills,
// .cursor/skills, .hermes/skills) are gitignored and regenerated at `forge setup`.
// Because those mirrors are absent on a clean checkout, we prove drift-freedom for
// ALL harness surfaces by regenerating each into a temp dir from the canonical
// source and asserting a byte-identical render — guarding every harness from
// silently rotting even though only `.agents/skills` is committed.

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
  }, 20000); // 20s budget: regenerates 5 harness mirrors × every skill dir — slow on Windows I/O.
});
