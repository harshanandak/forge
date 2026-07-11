/**
 * @module skills-sync
 *
 * Skills-only surface population + drift detection for Forge.
 *
 * Canonical source of truth is the committed root `skills/` directory — each
 * `skills/<name>/SKILL.md` (plus any sibling files) is an auto-surfacing skill.
 * Agent harness skill directories (`.agents/skills/`, `.claude/skills/`,
 * `.codex/skills/`, `.cursor/skills/`, `.hermes/skills/`) are GENERATED from that
 * canonical source. `.agents/skills` is Codex's documented repo-local discovery
 * path (scanned from cwd up to the repo root) and is the ONE mirror committed to
 * the repo (kept byte-identical by a pre-commit sync hook + the drift gate), so a
 * teammate who clones the repo WITHOUT running `forge setup` still gets the Forge
 * skills/stages auto-discovered. The other mirrors (including `.codex/skills`) are
 * gitignored and populated at setup only.
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
 *  - Existing-mirror scoped: `checkSkillsSync` only validates agent skill dirs
 *    that already exist on disk. The gitignored, setup-populated mirrors
 *    (`.claude/skills`, `.codex/skills`, `.cursor/skills`, `.hermes/skills`) are
 *    absent on a clean checkout and are correctly skipped; `.agents/skills` is the
 *    committed mirror that is always present and thus always enforced against the
 *    canonical source, which is what the gate guarantees.
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
  '.agents/skills',
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
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/** Normalize line endings so Windows CRLF working-tree state is not false drift. */
function normalizeContent(buffer) {
  return buffer.toString('utf8').replace(/\r\n/g, '\n');
}

/**
 * Remove a symlink sitting at a target path so a real directory can be written
 * in its place. Only ever removes the link entry itself — never a real
 * directory (with content) and never the symlink's target.
 *
 * Guards against the exact cruft that broke local skill-sync: a pre-existing
 * DANGLING symlink at a skill dir path, which makes `mkdirSync`/copy fail.
 *
 * @param {string} targetPath - Path that may hold a (possibly dangling) symlink.
 * @returns {boolean} True if a symlink was cleared, false otherwise.
 */
function clearSymlinkAtPath(targetPath) {
  let linkStat;
  try {
    // lstat does NOT follow the link, so a dangling symlink is still detected.
    linkStat = fs.lstatSync(targetPath);
  } catch {
    return false; // nothing at this path
  }

  if (!linkStat.isSymbolicLink()) {
    return false; // a real file/dir — leave it for the normal copy path
  }

  // Remove ONLY the link. Neither unlink nor rm follow a symlink's target, so
  // the (possibly dangling) target's contents are never touched.
  try {
    fs.unlinkSync(targetPath);
  } catch {
    // Windows directory symlinks/junctions can reject unlink; rmSync removes the
    // link entry itself without recursing into the target.
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
  return true;
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
    // Keep-set is the FULL canonical set, not the `only`-filtered subset, so a
    // partial sync (only: [...]) never deletes other canonical skills' dirs.
    const canonicalNames = new Set(listCanonicalSkills(sourceRoot).map((s) => s.name));
    for (const entry of fs.readdirSync(targetSkillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !canonicalNames.has(entry.name)) {
        fs.rmSync(path.join(targetSkillsDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  const written = [];
  for (const skill of skills) {
    const targetPath = path.join(targetSkillsDir, skill.name);
    // Defensive: clear a pre-existing (possibly dangling) symlink so the copy
    // doesn't fail. Only symlinks are removed — real dirs are overwritten in place.
    clearSymlinkAtPath(targetPath);
    copySkillDir(skill.sourcePath, targetPath);
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
 * Check that existing agent skill mirrors match the canonical source.
 *
 * Only agent skill dirs that already EXIST under `repoRoot` are validated. The
 * gitignored, setup-populated mirrors (`.claude/skills`, `.codex/skills`, etc.)
 * are absent on a clean checkout and correctly skipped; the committed
 * `.agents/skills` mirror is always present and always enforced against the
 * canonical source. Any mirror present locally must match canonical.
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
      // A regular file at the skill path is corruption, not a valid mirror:
      // treat it as drift instead of letting diffSkillDir() throw ENOTDIR.
      if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
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
  clearSymlinkAtPath,
  populateAgentSkills,
  diffSkillDir,
  checkSkillsSync,
};
