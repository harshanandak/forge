const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  AGENT_SKILL_DIRS,
  listCanonicalSkills,
  diffSkillDir,
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
// These tests prove Forge now generates the committed repo-local mirror.

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

  test('populateCodexRepoSkills preserves automatic ignored-path exclusions', () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agents-source-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agents-project-'));
    try {
      execFileSync('git', ['init'], { cwd: source, stdio: 'ignore' });
      fs.mkdirSync(path.join(source, 'skills/plan'), { recursive: true });
      fs.writeFileSync(path.join(source, '.gitignore'), '/skills/**/*.tmp\n');
      fs.writeFileSync(path.join(source, 'skills/plan/SKILL.md'), 'plan\n');
      fs.writeFileSync(path.join(source, 'skills/plan/editor.tmp'), 'scratch\n');

      const { targetSkillsDir } = populateCodexRepoSkills({ sourceRoot: source, projectRoot: project });
      expect(fs.existsSync(path.join(targetSkillsDir, 'plan/SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(targetSkillsDir, 'plan/editor.tmp'))).toBe(false);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  test('the committed repo .agents/skills mirror is drift-free vs canonical', () => {
    const committed = resolveCodexRepoSkillsDir(repoRoot);
    expect(fs.existsSync(committed)).toBe(true);
    for (const skill of listCanonicalSkills(repoRoot)) {
      const drift = diffSkillDir(skill.sourcePath, path.join(committed, skill.name));
      expect(drift).toEqual([]);
    }
  });
});
