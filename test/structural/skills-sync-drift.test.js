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
// Canonical skills live in root skills/ — the single committed skill source. All
// agent mirrors (.agents/skills, .claude/skills, .codex/skills, .cursor/skills,
// .hermes/skills) are gitignored and generated at `forge setup`; checkSkillsSync
// only validates the ones that already exist on disk, so a clean checkout with no
// mirrors is trivially in sync. This is the in-repo equivalent of
// `skills sync --check`; it uses the dependency-free lib so it runs in `bun test`
// without the @forge/skills deps.

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

  test('checkSkillsSync only validates mirror dirs that exist (no-op on a clean checkout)', () => {
    const result = checkSkillsSync({ repoRoot });
    // Every checked agent must be a real directory on disk — absent mirrors are
    // skipped (absence ≠ drift), which is what keeps a fresh clone in sync.
    for (const rel of result.checkedAgents) {
      expect(fs.existsSync(path.join(repoRoot, rel))).toBe(true);
    }
  });
});

// ─── all harnesses render correctly from source (regenerate-into-temp) ─────────
//
// NO skill mirror is committed — skills/ is the single source of truth and every
// harness mirror (.agents/skills, .claude/skills, .codex/skills, .cursor/skills,
// .hermes/skills) is gitignored and regenerated at `forge setup`. Because the
// mirrors are absent on a clean checkout, we prove drift-freedom for ALL harness
// surfaces by regenerating each into a temp dir from the canonical source and
// asserting a byte-identical render — guarding every harness from silently rotting
// even though none of their dirs are committed.

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
