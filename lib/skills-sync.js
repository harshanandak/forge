/**
 * @module skills-sync
 *
 * Skills-only surface population + drift detection for Forge.
 *
 * Canonical source of truth is the committed root `skills/` directory — each
 * `skills/<name>/SKILL.md` (plus any sibling files) is an auto-surfacing skill.
 * Agent harness skill directories (`.claude/skills/`, `.codex/skills/`,
 * `.cursor/skills/`, `.hermes/skills/`) are GENERATED from that canonical source.
 *
 * This module is the Forge-internal port of the `@forge/skills` CLI sync step.
 * Forge cannot depend on `@forge/skills` at runtime (the `packages/` workspace is
 * excluded from the published npm package), so the minimal population + check
 * logic lives here. It mirrors the CLI's whole-directory copy semantics so that
 * `skills sync --check` and this module agree on what "in sync" means.
 *
 * Design constraints (locked in kernel-skill-surface-design.md §6):
 *  - Registry-independent: never requires `.skills/.registry.json` (the registry
 *    is gitignored and absent on a fresh checkout).
 *  - AGENTS.md-safe: never writes AGENTS.md (it is the protected workflow contract).
 *  - Committed-mirror scoped: `checkSkillsSync` only validates agent skill dirs
 *    that already exist on disk. `.claude/skills` / `.cursor/skills` are gitignored
 *    and populated at setup time, so their absence is not drift; `.codex/skills`
 *    is committed and is the mirror the gate enforces.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Canonical skills live under this directory at the repo/package root. */
const CANONICAL_SKILLS_DIR = 'skills';

/**
 * Standard agent harness skill directories, relative to a project root.
 * Order is stable for deterministic reporting.
 */
const AGENT_SKILL_DIRS = [
  '.claude/skills',
  '.codex/skills',
  '.cursor/skills',
  '.hermes/skills',
];

/** Skill name must be a safe single path segment (no traversal). */
function isValidSkillName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

/**
 * List canonical skills under `<sourceRoot>/skills`.
 *
 * A skill is any direct subdirectory that contains a `SKILL.md` file.
 *
 * @param {string} sourceRoot - Directory containing the canonical `skills/` dir.
 * @param {object} [options]
 * @param {Set<string>|string[]} [options.only] - Restrict to these skill names.
 * @returns {{name: string, sourcePath: string}[]} Sorted list of skills.
 */
function listCanonicalSkills(sourceRoot, options = {}) {
  const skillsDir = path.join(sourceRoot, CANONICAL_SKILLS_DIR);
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  const only = options.only ? new Set(options.only) : null;
  const skills = [];

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isValidSkillName(entry.name)) continue;
    if (only && !only.has(entry.name)) continue;

    const sourcePath = path.join(skillsDir, entry.name);
    if (!fs.existsSync(path.join(sourcePath, 'SKILL.md'))) continue;

    skills.push({ name: entry.name, sourcePath });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * List all files under a directory as paths relative to that directory,
 * using forward slashes for stable cross-platform comparison.
 *
 * @param {string} dir - Directory to walk.
 * @returns {string[]} Sorted relative file paths.
 */
function listFilesRecursive(dir) {
  const out = [];

  function walk(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }

  if (fs.existsSync(dir)) {
    walk(dir, '');
  }
  out.sort();
  return out;
}

/** Normalize line endings so Windows CRLF working-tree state is not false drift. */
function normalizeContent(buffer) {
  return buffer.toString('utf8').replace(/\r\n/g, '\n');
}

/**
 * Copy a single skill directory (recursively) from source to target,
 * overwriting existing files. Byte-for-byte copy (matches CLI cpSync).
 *
 * @param {string} sourcePath - Source skill directory.
 * @param {string} targetPath - Target skill directory.
 */
function copySkillDir(sourcePath, targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const src = path.join(sourcePath, entry.name);
    const dest = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      copySkillDir(src, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * Populate an agent harness skills directory from the canonical source.
 *
 * Writes `<targetSkillsDir>/<name>/...` for every canonical skill. Existing
 * skills are overwritten; pre-existing unrelated skill dirs are left untouched
 * unless `clean` is set.
 *
 * @param {object} params
 * @param {string} params.sourceRoot - Root containing the canonical `skills/` dir.
 * @param {string} params.targetSkillsDir - Absolute path to the agent skills dir.
 * @param {Set<string>|string[]} [params.only] - Restrict to these skill names.
 * @param {boolean} [params.clean=false] - Remove canonical-managed stale dirs first.
 * @returns {{written: string[]}} Names of skills written.
 */
function populateAgentSkills({ sourceRoot, targetSkillsDir, only, clean = false }) {
  const skills = listCanonicalSkills(sourceRoot, { only });
  fs.mkdirSync(targetSkillsDir, { recursive: true });

  if (clean) {
    const canonicalNames = new Set(skills.map((s) => s.name));
    for (const entry of fs.readdirSync(targetSkillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !canonicalNames.has(entry.name)) {
        fs.rmSync(path.join(targetSkillsDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  const written = [];
  for (const skill of skills) {
    copySkillDir(skill.sourcePath, path.join(targetSkillsDir, skill.name));
    written.push(skill.name);
  }
  return { written };
}

/**
 * Compare a canonical skill directory against a target copy.
 *
 * @param {string} sourcePath - Canonical skill dir.
 * @param {string} targetPath - Target (generated) skill dir.
 * @returns {{file: string, status: 'missing'|'changed'|'extra'}[]} Drift entries.
 */
function diffSkillDir(sourcePath, targetPath) {
  const drift = [];
  const sourceFiles = new Set(listFilesRecursive(sourcePath));
  const targetFiles = new Set(listFilesRecursive(targetPath));

  for (const rel of sourceFiles) {
    if (!targetFiles.has(rel)) {
      drift.push({ file: rel, status: 'missing' });
      continue;
    }
    const a = normalizeContent(fs.readFileSync(path.join(sourcePath, rel)));
    const b = normalizeContent(fs.readFileSync(path.join(targetPath, rel)));
    if (a !== b) {
      drift.push({ file: rel, status: 'changed' });
    }
  }

  for (const rel of targetFiles) {
    if (!sourceFiles.has(rel)) {
      drift.push({ file: rel, status: 'extra' });
    }
  }

  return drift;
}

/**
 * Check that committed agent skill mirrors match the canonical source.
 *
 * Only agent skill dirs that already EXIST under `repoRoot` are validated —
 * gitignored, setup-populated dirs (`.claude/skills`, `.cursor/skills`) are
 * absent on a clean checkout and are correctly skipped; `.codex/skills` is the
 * committed mirror the gate enforces.
 *
 * @param {object} params
 * @param {string} params.repoRoot - Repo root (contains `skills/` + agent dirs).
 * @param {Set<string>|string[]} [params.only] - Restrict canonical set.
 * @param {string[]} [params.agentSkillDirs] - Override the agent dirs to scan.
 * @returns {{inSync: boolean, checkedAgents: string[], drift: object[]}}
 */
function checkSkillsSync({ repoRoot, only, agentSkillDirs = AGENT_SKILL_DIRS }) {
  const skills = listCanonicalSkills(repoRoot, { only });
  const canonicalByName = new Map(skills.map((s) => [s.name, s]));
  const drift = [];
  const checkedAgents = [];

  for (const rel of agentSkillDirs) {
    const agentDir = path.join(repoRoot, rel);
    if (!fs.existsSync(agentDir)) continue; // populated at setup time; absence ≠ drift
    checkedAgents.push(rel);

    const targetNames = fs
      .readdirSync(agentDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    // Skills present canonically but missing/changed in the mirror.
    for (const skill of skills) {
      const targetPath = path.join(agentDir, skill.name);
      if (!fs.existsSync(targetPath)) {
        drift.push({ agent: rel, skill: skill.name, file: 'SKILL.md', status: 'missing' });
        continue;
      }
      for (const entry of diffSkillDir(skill.sourcePath, targetPath)) {
        drift.push({ agent: rel, skill: skill.name, ...entry });
      }
    }

    // Skill dirs in the mirror with no canonical source = stale.
    for (const name of targetNames) {
      if (!canonicalByName.has(name)) {
        drift.push({ agent: rel, skill: name, file: '*', status: 'stale' });
      }
    }
  }

  return { inSync: drift.length === 0, checkedAgents, drift };
}

module.exports = {
  CANONICAL_SKILLS_DIR,
  AGENT_SKILL_DIRS,
  isValidSkillName,
  listCanonicalSkills,
  listFilesRecursive,
  populateAgentSkills,
  diffSkillDir,
  checkSkillsSync,
};
