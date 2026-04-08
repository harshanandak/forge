const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  const skillsDir = path.join(sourceRoot, '.codex', 'skills');

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

module.exports = {
  buildCodexSkillInstallPlan,
  formatCodexSkillsInstallDir,
  listCodexSkillEntries,
  resolveCodexHome,
  resolveCodexSkillsInstallDir,
};
