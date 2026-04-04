const fs = require('node:fs');
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
        dir: `.codex/skills/${commandName}/`,
        filename: 'SKILL.md',
        content: injectForgeAdapter(fs.readFileSync(sourceFile, 'utf8'), commandName),
      };
    })
    .filter(Boolean);
}

module.exports = {
  listCodexSkillEntries,
};
