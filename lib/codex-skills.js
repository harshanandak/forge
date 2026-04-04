const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

function parseFrontmatter(content) {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: {}, body: content };
  }

  const openLen = content.startsWith('---\r\n') ? 5 : 4;
  const closeIndex = content.indexOf('\n---\n', openLen - 1);
  const closeIndexCRLF = content.indexOf('\r\n---\r\n', openLen - 1);

  let yamlStr;
  let bodyStart;

  if (closeIndex === -1 && closeIndexCRLF === -1) {
    const closeAtEnd = content.indexOf('\n---', openLen - 1);
    if (closeAtEnd === -1 || closeAtEnd + 4 !== content.length) {
      return { frontmatter: {}, body: content };
    }
    yamlStr = content.slice(openLen, closeAtEnd + 1);
    bodyStart = content.length;
  } else if (closeIndex !== -1 && (closeIndexCRLF === -1 || closeIndex < closeIndexCRLF)) {
    yamlStr = content.slice(openLen, closeIndex + 1);
    bodyStart = closeIndex + 5;
  } else {
    yamlStr = content.slice(openLen, closeIndexCRLF + 2);
    bodyStart = closeIndexCRLF + 7;
  }

  const trimmed = yamlStr.trim();
  if (trimmed === '') {
    return { frontmatter: {}, body: content.slice(bodyStart) };
  }

  let frontmatter;
  try {
    frontmatter = YAML.parse(trimmed);
  } catch {
    return { frontmatter: {}, body: content };
  }

  if (frontmatter === null || typeof frontmatter !== 'object') {
    return { frontmatter: {}, body: content };
  }

  return { frontmatter, body: content.slice(bodyStart) };
}

function buildFile(frontmatter, body) {
  const keys = Object.keys(frontmatter);

  let yamlBlock = '';
  if (keys.length > 0) {
    yamlBlock = YAML.stringify(frontmatter, {
      lineWidth: 0,
      defaultKeyType: 'PLAIN',
      defaultStringType: 'PLAIN',
    }).trimEnd();
    yamlBlock += '\n';
  }

  return `---\n${yamlBlock}---\n${body}`;
}

function codexFrontmatter(frontmatter) {
  const result = {};
  if (frontmatter.description !== undefined) {
    result.description = frontmatter.description;
  }
  return result;
}

function buildCodexSkillBody(commandName, body) {
  return [
    `> Forge stage adapter`,
    '',
    `Before executing this workflow, invoke \`forge ${commandName}\` so Forge can enforce stage order, runtime prerequisites, and override rules.`,
    'If Forge blocks the stage or asks for an explicit override payload, stop and resolve that first.',
    '',
    body,
  ].join('\n');
}

function listCodexSkillEntries(sourceRoot) {
  const commandsDir = path.join(sourceRoot, 'commands');

  if (!fs.existsSync(commandsDir)) {
    return [];
  }

  return fs.readdirSync(commandsDir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      const commandName = file.replace(/\.md$/, '');
      const raw = fs.readFileSync(path.join(commandsDir, file), 'utf8');
      const { frontmatter, body } = parseFrontmatter(raw);

      return {
        commandName,
        dir: `.codex/skills/${commandName}/`,
        filename: 'SKILL.md',
        content: buildFile(codexFrontmatter(frontmatter), buildCodexSkillBody(commandName, body)),
      };
    });
}

module.exports = {
  listCodexSkillEntries,
};
