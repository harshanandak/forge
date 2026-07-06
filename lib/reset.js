const fs = require('node:fs');
const path = require('node:path');
const { listCanonicalSkills } = require('./skills-sync');

/**
 * Package root that ships the canonical `skills/` source. Used to determine
 * which skill directories Forge itself installed (so user/third-party skills
 * sharing a skills dir are not removed during reset).
 */
const FORGE_PACKAGE_ROOT = path.resolve(__dirname, '..');

/**
 * Known forge-created file patterns.
 * Used to distinguish forge files from user-created files.
 */
const FORGE_SKILL_DIRS = [
  '.agents/skills',
  '.claude/skills',
  '.cursor/skills',
  '.codex/skills',
];

const FORGE_RULES = [
  '.claude/rules/workflow.md',
  '.claude/rules/greptile-review-process.md',
];

const FORGE_SCRIPTS = [
  '.claude/scripts/greptile-resolve.sh',
  '.claude/scripts/validate.sh',
];

const FORGE_WORKFLOWS = [
  '.github/workflows/beads-to-github.yml',
  '.github/workflows/github-to-beads.yml',
];

const FORGE_DOCS = [
  'docs/forge/TOOLCHAIN.md',
  'docs/forge/VALIDATION.md',
];

const FORGE_AGENT_DIRS = [
  '.cursor',
  '.codex',
];

const FORGE_SYNC_SCRIPTS_DIR = 'scripts/github-beads-sync';

/**
 * Get categorized lists of forge-managed files in a project.
 * Only returns files that actually exist on disk and are known forge templates.
 * User-created files are excluded.
 *
 * @param {string} projectRoot - Project root directory
 * @returns {{
 *   config: string[],
 *   commands: string[],
 *   rules: string[],
 *   scripts: string[],
 *   docs: string[],
 *   agentDirs: string[],
 *   workflows: string[],
 *   syncScripts: string[]
 * }}
 */
function getForgeFiles(projectRoot) {
  const result = {
    config: [],
    skillDirs: [],
    rules: [],
    scripts: [],
    docs: [],
    agentDirs: [],
    workflows: [],
    syncScripts: [],
  };

  // .forge/ directory
  if (fs.existsSync(path.join(projectRoot, '.forge'))) {
    result.config.push('.forge');
  }

  // Known forge skill directories
  for (const dir of FORGE_SKILL_DIRS) {
    if (fs.existsSync(path.join(projectRoot, dir))) {
      result.skillDirs.push(dir);
    }
  }

  // Known forge rules
  for (const f of FORGE_RULES) {
    if (fs.existsSync(path.join(projectRoot, f))) {
      result.rules.push(f);
    }
  }

  // Known forge scripts
  for (const f of FORGE_SCRIPTS) {
    if (fs.existsSync(path.join(projectRoot, f))) {
      result.scripts.push(f);
    }
  }

  // Known forge docs
  for (const f of FORGE_DOCS) {
    if (fs.existsSync(path.join(projectRoot, f))) {
      result.docs.push(f);
    }
  }

  // Agent directories (only if they exist)
  for (const dir of FORGE_AGENT_DIRS) {
    if (fs.existsSync(path.join(projectRoot, dir))) {
      result.agentDirs.push(dir);
    }
  }

  // Beads workflow files
  for (const f of FORGE_WORKFLOWS) {
    if (fs.existsSync(path.join(projectRoot, f))) {
      result.workflows.push(f);
    }
  }

  // Sync scripts directory
  const syncDir = path.join(projectRoot, FORGE_SYNC_SCRIPTS_DIR);
  if (fs.existsSync(syncDir)) {
    try {
      const entries = fs.readdirSync(syncDir);
      for (const entry of entries) {
        const relPath = [FORGE_SYNC_SCRIPTS_DIR, entry].join('/');
        result.syncScripts.push(relPath);
      }
    } catch (_error) {
      // Directory read failed, skip
    }
  }

  return result;
}

/**
 * Remove .forge/ directory only (soft reset).
 * Requires force=true to proceed.
 *
 * @param {string} projectRoot - Project root directory
 * @param {{ force?: boolean }} options
 * @returns {{ removed: string[], preserved: string[] }}
 */
function resetSoft(projectRoot, { force = false } = {}) {
  if (!force) {
    throw new Error('Soft reset requires --force flag. This will remove .forge/ directory.');
  }

  const removed = [];
  const preserved = [];

  const forgePath = path.join(projectRoot, '.forge');
  if (fs.existsSync(forgePath)) {
    fs.rmSync(forgePath, { recursive: true, force: true });
    removed.push('.forge');
  }

  // Record what was preserved
  const inventory = getForgeFiles(projectRoot);
  for (const f of [...inventory.rules, ...inventory.scripts]) {
    preserved.push(f);
  }
  for (const dir of [...inventory.skillDirs, ...inventory.agentDirs]) {
    preserved.push(dir);
  }

  return { removed, preserved };
}

/**
 * Remove ALL forge-managed files (hard reset).
 * Preserves user-created files not in forge template list.
 * Requires force=true to proceed.
 *
 * @param {string} projectRoot - Project root directory
 * @param {{ force?: boolean }} options
 * @returns {{ removed: string[], preserved: string[] }}
 */
function resetHard(projectRoot, { force = false, sourceRoot = FORGE_PACKAGE_ROOT } = {}) {
  if (!force) {
    throw new Error('Hard reset requires --force flag. This will remove ALL forge files.');
  }

  const removed = [];
  const preserved = [];
  const inventory = getForgeFiles(projectRoot);

  // Remove .forge/ directory
  for (const dir of inventory.config) {
    const fullPath = path.join(projectRoot, dir);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(dir);
    }
  }

  // Remove individual forge files
  const allFiles = [
    ...inventory.rules,
    ...inventory.scripts,
    ...inventory.docs,
    ...inventory.workflows,
    ...inventory.syncScripts,
  ];

  for (const f of allFiles) {
    const fullPath = path.join(projectRoot, f);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(f);
    }
  }

  // Remove sync scripts directory if it still exists (empty after file removal)
  const syncDir = path.join(projectRoot, FORGE_SYNC_SCRIPTS_DIR);
  if (fs.existsSync(syncDir)) {
    fs.rmSync(syncDir, { recursive: true, force: true });
    removed.push(FORGE_SYNC_SCRIPTS_DIR);
  }

  // Remove docs/forge/ directory if empty after file removal
  const docsForgeDir = path.join(projectRoot, 'docs', 'forge');
  if (fs.existsSync(docsForgeDir)) {
    try {
      const remaining = fs.readdirSync(docsForgeDir);
      if (remaining.length === 0) {
        fs.rmSync(docsForgeDir, { recursive: true, force: true });
        removed.push('docs/forge');
      }
    } catch (_error) {
      // Directory read failed, skip
    }
  }

  // Remove Forge-managed skill directories ONLY.
  // Shared skills dirs (e.g. .claude/skills) can also hold user/third-party
  // skills. Scope removal to the canonical Forge skill set so user work is
  // preserved; the surrounding dir is removed only if nothing else remains.
  const forgeSkillNames = new Set(
    listCanonicalSkills(sourceRoot).map((s) => s.name)
  );
  for (const dir of inventory.skillDirs) {
    const skillsRoot = path.join(projectRoot, dir);
    if (!fs.existsSync(skillsRoot)) continue;

    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!forgeSkillNames.has(entry.name)) continue;
      fs.rmSync(path.join(skillsRoot, entry.name), { recursive: true, force: true });
      removed.push([dir, entry.name].join('/'));
    }

    // Drop the now-empty skills dir, but keep it if user/third-party skills remain.
    try {
      if (fs.readdirSync(skillsRoot).length === 0) {
        fs.rmSync(skillsRoot, { recursive: true, force: true });
        removed.push(dir);
      }
    } catch (_error) {
      // Directory read failed, skip
    }
  }

  // Remove agent directories
  for (const dir of inventory.agentDirs) {
    const fullPath = path.join(projectRoot, dir);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(dir);
    }
  }

  return { removed, preserved };
}

/**
 * Remove all forge files and re-run setup (reinstall).
 * Accepts a setupFn parameter for testability.
 *
 * @param {string} projectRoot - Project root directory
 * @param {{ force?: boolean, setupFn?: Function }} options
 * @returns {Promise<{ resetResult: object, setupResult: any }>}
 */
async function reinstall(projectRoot, { force = false, setupFn } = {}) {
  if (!force) {
    throw new Error('Reinstall requires --force flag.');
  }

  const resetResult = resetHard(projectRoot, { force: true });

  let setupResult = null;
  if (setupFn) {
    setupResult = await setupFn(projectRoot);
  }

  return { resetResult, setupResult };
}

module.exports = {
  getForgeFiles,
  resetSoft,
  resetHard,
  reinstall,
  FORGE_SKILL_DIRS,
  FORGE_RULES,
  FORGE_SCRIPTS,
  FORGE_DOCS,
  FORGE_WORKFLOWS,
  FORGE_AGENT_DIRS,
};
