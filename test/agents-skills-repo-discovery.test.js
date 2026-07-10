const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AGENT_SKILL_DIRS,
  listCanonicalSkills,
  diffSkillDir,
  populateAgentSkills,
} = require('../lib/skills-sync');
const {
  CODEX_REPO_SKILLS_DIR,
  resolveCodexRepoSkillsDir,
  populateCodexRepoSkills,
} = require('../lib/codex-skills');
const { STAGE_IDS } = require('../lib/workflow/stages');
const { UTILITY_SKILL_IDS } = require('../lib/harness-capability-matrix');

const repoRoot = path.resolve(__dirname, '..');

// ─── Codex repo-local (.agents/skills) discovery parity ───────────────────────
//
// Codex scans `.agents/skills/<name>/SKILL.md` from cwd up to the repo root for
// repo-scope skill discovery (developers.openai.com/codex/skills — repo skills
// are "checked into .agents/skills, for your team"). Forge previously installed
// only to the GLOBAL $CODEX_HOME/skills, leaving a teammate who clones the repo
// WITHOUT running `forge setup` with zero auto-discovered Forge skills/stages.
// The mirror is now generated at `forge setup` from the canonical skills/ source
// (gitignored, not committed); these tests prove that generation is byte-faithful.

describe('codex repo-local .agents/skills discovery', () => {
  test('.agents/skills is a drift-enforced agent skill dir', () => {
    expect(CODEX_REPO_SKILLS_DIR).toBe('.agents/skills');
    expect(AGENT_SKILL_DIRS).toContain('.agents/skills');
  });

  test('resolveCodexRepoSkillsDir joins projectRoot with .agents/skills', () => {
    const projectRoot = path.join('some', 'project');
    expect(resolveCodexRepoSkillsDir(projectRoot)).toBe(
      path.join(projectRoot, '.agents', 'skills'),
    );
  });

  test('populateCodexRepoSkills writes .agents/skills/<stage>/SKILL.md for every stage', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agents-skills-'));
    try {
      const { targetSkillsDir, written } = populateCodexRepoSkills({
        sourceRoot: repoRoot,
        projectRoot: tmp,
      });

      expect(targetSkillsDir).toBe(path.join(tmp, '.agents', 'skills'));

      // Every workflow stage + utility skill has a repo-local SKILL.md.
      for (const id of [...STAGE_IDS, ...UTILITY_SKILL_IDS]) {
        expect(written).toContain(id);
        const skillFile = path.join(targetSkillsDir, id, 'SKILL.md');
        expect(fs.existsSync(skillFile)).toBe(true);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('generated .agents/skills content is byte-identical to canonical skills/', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agents-skills-'));
    try {
      const { targetSkillsDir } = populateCodexRepoSkills({
        sourceRoot: repoRoot,
        projectRoot: tmp,
      });
      const canonical = listCanonicalSkills(repoRoot);
      expect(canonical.length).toBeGreaterThan(0);
      for (const skill of canonical) {
        const drift = diffSkillDir(skill.sourcePath, path.join(targetSkillsDir, skill.name));
        expect(drift).toEqual([]);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('setup generates BOTH .codex/skills and .agents/skills from skills/ alone (no committed mirror needed)', () => {
    // Simulate a fresh clone: a source root that has ONLY the canonical skills/
    // dir — no committed .codex/skills or .agents/skills mirror to copy from.
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-src-only-skills-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-generated-mirrors-'));
    try {
      const canonicalDir = path.join(source, 'skills', 'plan');
      fs.mkdirSync(canonicalDir, { recursive: true });
      fs.writeFileSync(
        path.join(canonicalDir, 'SKILL.md'),
        '---\ndescription: Plan workflow\n---\n# Plan\nCanonical body.\n'
      );
      // No committed mirrors exist in the source.
      expect(fs.existsSync(path.join(source, '.codex', 'skills'))).toBe(false);
      expect(fs.existsSync(path.join(source, '.agents', 'skills'))).toBe(false);

      // `forge setup` generates each harness mirror from skills/ via populateAgentSkills.
      for (const rel of ['.codex/skills', '.agents/skills']) {
        const targetSkillsDir = path.join(target, rel);
        const { written } = populateAgentSkills({ sourceRoot: source, targetSkillsDir, clean: false });
        expect(written).toContain('plan');
        const generated = path.join(targetSkillsDir, 'plan', 'SKILL.md');
        expect(fs.existsSync(generated)).toBe(true);
        const drift = diffSkillDir(canonicalDir, path.join(targetSkillsDir, 'plan'));
        expect(drift).toEqual([]);
      }
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test('.agents/skills, when present, is drift-free vs canonical (setup-generated, gitignored — absence ≠ drift)', () => {
    const mirror = resolveCodexRepoSkillsDir(repoRoot);
    // Generated at `forge setup` and gitignored, so it is absent on a clean
    // checkout; when present it must be a byte-faithful render of canonical skills/.
    if (!fs.existsSync(mirror)) return;
    for (const skill of listCanonicalSkills(repoRoot)) {
      const drift = diffSkillDir(skill.sourcePath, path.join(mirror, skill.name));
      expect(drift).toEqual([]);
    }
  });
});
