const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { populateAgentSkills } = require('./skills-sync');

/**
 * Codex's documented repo-local skill discovery directory, relative to a project
 * root. Codex scans `.agents/skills/<name>/SKILL.md` from the current working
 * directory up to the repo root (developers.openai.com/codex/skills). Unlike the
 * GLOBAL `$CODEX_HOME/skills` install, this surface is COMMITTED to the repo (kept
 * byte-identical to the canonical `skills/` source by a pre-commit sync hook and
 * the drift gate), so a teammate who clones the repo WITHOUT running `forge setup`
 * still gets the Forge skills/stages auto-discovered.
 */
const CODEX_REPO_SKILLS_DIR = '.agents/skills';

function injectForgeAdapter(content, commandName) {
  const adapter = [
    '> Forge stage adapter',
    '',
    `Before executing this workflow, invoke \`forge ${commandName}\` so Forge can enforce stage order, runtime prerequisites, and override rules.`,
    'If Forge blocks the stage or asks for an explicit override payload, stop and resolve that first.',
    '',
  ].join('\n');

  const match = content.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/);
  if (!match) {
    return `${adapter}\n${content}`;
  }

  return `${match[1]}\n${adapter}${match[2]}`;
}

function listCodexSkillEntries(sourceRoot) {
  // Read from the canonical `skills/` source (single source of truth) rather than
  // a committed `.codex/skills` mirror. The GLOBAL `$CODEX_HOME/skills` install is
  // generated from these entries with the stage adapter injected below.
  const skillsDir = path.join(sourceRoot, 'skills');

  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((commandName) => {
      const sourceFile = path.join(skillsDir, commandName, 'SKILL.md');
      if (!fs.existsSync(sourceFile)) {
        return null;
      }

      return {
        commandName,
        filename: 'SKILL.md',
        content: injectForgeAdapter(fs.readFileSync(sourceFile, 'utf8'), commandName),
      };
    })
    .filter(Boolean);
}

function resolveCodexHome(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const explicitHome = String(env.CODEX_HOME || '').trim();

  if (explicitHome) {
    return path.resolve(explicitHome);
  }

  return path.join(homeDir, '.codex');
}

function resolveCodexSkillsInstallDir(options = {}) {
  return path.join(resolveCodexHome(options), 'skills');
}

function formatCodexSkillsInstallDir(options = {}) {
  const installDir = resolveCodexSkillsInstallDir(options);
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const explicitHome = String((options.env || process.env).CODEX_HOME || '').trim();
  const normalizedInstallDir = installDir.replace(/\\/g, '/');

  if (explicitHome) {
    const explicitInstallDir = path.join(path.resolve(explicitHome), 'skills').replace(/\\/g, '/');
    if (normalizedInstallDir === explicitInstallDir) {
      return '$CODEX_HOME/skills';
    }
  }

  const defaultInstallDir = path.join(homeDir, '.codex', 'skills').replace(/\\/g, '/');
  if (normalizedInstallDir === defaultInstallDir) {
    return '~/.codex/skills';
  }

  return normalizedInstallDir;
}

function buildCodexSkillInstallPlan(sourceRoot, options = {}) {
  const installDir = resolveCodexSkillsInstallDir(options);
  const displayRoot = formatCodexSkillsInstallDir(options);

  return listCodexSkillEntries(sourceRoot).map((entry) => ({
    ...entry,
    absolutePath: path.join(installDir, entry.commandName, entry.filename),
    displayPath: `${displayRoot}/${entry.commandName}/${entry.filename}`,
    displayRoot,
  }));
}

/**
 * Absolute path to a project's repo-local Codex skill discovery dir.
 *
 * @param {string} projectRoot - The project/repo root.
 * @returns {string} `<projectRoot>/.agents/skills`.
 */
function resolveCodexRepoSkillsDir(projectRoot) {
  return path.join(projectRoot, '.agents', 'skills');
}

/**
 * Generate the repo-local Codex skill discovery mirror (`.agents/skills`) from
 * the canonical `skills/` source.
 *
 * Content matches the other harness mirrors byte-for-byte (raw canonical — the
 * `$CODEX_HOME` stage adapter is NOT injected here) so the skills-sync drift gate
 * can enforce it, and so repo-local discovery reaches parity with the
 * `.claude/skills` / `.cursor/skills` discovery surfaces.
 *
 * @param {object} params
 * @param {string} params.sourceRoot - Root containing the canonical `skills/` dir.
 * @param {string} params.projectRoot - Target project/repo root.
 * @param {boolean} [params.clean=false] - Remove stale canonical-managed dirs first.
 * @returns {{targetSkillsDir: string, written: string[]}}
 */
function populateCodexRepoSkills({ sourceRoot, projectRoot, clean = false }) {
  const targetSkillsDir = resolveCodexRepoSkillsDir(projectRoot);
  const { written } = populateAgentSkills({ sourceRoot, targetSkillsDir, clean });
  return { targetSkillsDir, written };
}

module.exports = {
  CODEX_REPO_SKILLS_DIR,
  buildCodexSkillInstallPlan,
  formatCodexSkillsInstallDir,
  listCodexSkillEntries,
  populateCodexRepoSkills,
  resolveCodexHome,
  resolveCodexRepoSkillsDir,
  resolveCodexSkillsInstallDir,
};
