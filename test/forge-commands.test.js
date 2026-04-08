/**
 * Tests for getWorkflowCommands() and Codex skill generation.
 *
 * Verifies that workflow commands are read from .claude/commands/*.md
 * rather than hardcoded in an array.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { afterEach, describe, test, expect } = require('bun:test');
const {
  buildCodexSkillInstallPlan,
  formatCodexSkillsInstallDir,
  listCodexSkillEntries,
} = require('../lib/codex-skills');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-skills-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

let getWorkflowCommands;
try {
  ({ getWorkflowCommands } = require('../bin/forge.js'));
} catch (_e) {
  // Expected during RED phases in earlier task history.
}

describe('getWorkflowCommands', () => {
  test('returns an array of command names from .claude/commands/*.md', () => {
    const commands = getWorkflowCommands();
    expect(Array.isArray(commands)).toBe(true);
    expect(commands.length).toBeGreaterThan(0);

    const packageDir = path.resolve(__dirname, '..');
    const commandsDir = path.join(packageDir, '.claude', 'commands');
    const expected = fs.readdirSync(commandsDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.replace(/\.md$/, ''))
      .sort();

    expect(commands.sort()).toEqual(expected);
  });

  test('filters out non-.md files', () => {
    const commands = getWorkflowCommands();
    const packageDir = path.resolve(__dirname, '..');
    const commandsDir = path.join(packageDir, '.claude', 'commands');
    for (const command of commands) {
      const mdPath = path.join(commandsDir, `${command}.md`);
      expect(fs.existsSync(mdPath)).toBe(true);
    }
  });

  test('returns empty array and warns when directory does not exist', () => {
    const origReaddir = fs.readdirSync;
    const warns = [];
    const origWarn = console.warn;
    fs.readdirSync = (dirPath, ...rest) => {
      if (String(dirPath).includes('.claude') && String(dirPath).includes('commands')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return origReaddir(dirPath, ...rest);
    };
    console.warn = (...args) => warns.push(args.join(' '));
    try {
      const result = getWorkflowCommands();
      expect(result).toEqual([]);
      expect(warns.length).toBeGreaterThan(0);
    } finally {
      fs.readdirSync = origReaddir;
      console.warn = origWarn;
    }
  });
});

describe('hardcoded command count and copyFile warning', () => {
  const forgeSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'bin', 'forge.js'),
    'utf8'
  );

  test('no hardcoded "9 workflow commands" string in bin/forge.js', () => {
    const matches = forgeSource.match(/9 workflow commands/g);
    expect(matches).toBeNull();
  });

  test('copyFile missing-source warning is not gated behind DEBUG', () => {
    const hasDebugGate = /else if \(process\.env\.DEBUG\)\s*\{[^}]*Source file not found/.test(forgeSource);
    expect(hasDebugGate).toBe(false);
  });
});

describe('agent count consistency', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')
  );
  const readmeContent = fs.readFileSync(
    path.resolve(__dirname, '..', 'README.md'),
    'utf-8'
  );
  const agentsDir = path.resolve(__dirname, '..', 'lib', 'agents');
  let pluginFiles = [];
  try {
    pluginFiles = fs.readdirSync(agentsDir).filter((file) => file.endsWith('.plugin.json'));
  } catch (_e) {
    // lib/agents may not exist in all environments.
  }

  test('package.json description mentions correct agent count or "all AI agents"', () => {
    const desc = packageJson.description;
    const mentionsAll = /all ai/i.test(desc);
    const mentionsCount = desc.includes(String(pluginFiles.length));
    expect(mentionsAll || mentionsCount).toBe(true);
  });

  test('README agent count is consistent with lib/agents/*.plugin.json count', () => {
    const actualCount = pluginFiles.length;
    const countPatterns = [
      /works with \*\*(\d+) (?:AI )?(?:coding )?agents\*\*/i,
      /Multi-Agent.*?(\d+) agents/i,
    ];
    for (const pattern of countPatterns) {
      const match = readmeContent.match(pattern);
      if (match) {
        expect(Number(match[1])).toBe(actualCount);
      }
    }
  });
});

describe('Codex plugin metadata', () => {
  const codexPlugin = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'agents', 'codex.plugin.json'), 'utf-8')
  );

  test('declares Codex as a skills-backed adapter', () => {
    expect(codexPlugin.capabilities.skills).toBe(true);
    expect(codexPlugin.setup.createSkill).toBe(true);
  });

  test('keeps the packaged Codex skill source and global install target aligned', () => {
    expect(codexPlugin.directories.skills).toBe('.codex/skills');
    expect(codexPlugin.installTargets.skills).toBe('$CODEX_HOME/skills');
  });
});

describe('Codex skill entry generation', () => {
  test('returns an empty list when packaged Codex stage skills are missing', () => {
    const tmpDir = makeTempDir();

    expect(listCodexSkillEntries(tmpDir)).toEqual([]);
  });

  test('builds per-stage Codex skills from packaged skill sources', () => {
    const tmpDir = makeTempDir();
    const skillsDir = path.join(tmpDir, '.codex', 'skills', 'plan');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'SKILL.md'),
      '---\ndescription: Plan workflow\nmode: code\n---\n# Plan\nUse Forge runtime.\n'
    );

    const entries = listCodexSkillEntries(tmpDir);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      commandName: 'plan',
      filename: 'SKILL.md',
      content: '---\ndescription: Plan workflow\nmode: code\n---\n\n> Forge stage adapter\n\nBefore executing this workflow, invoke `forge plan` so Forge can enforce stage order, runtime prerequisites, and override rules.\nIf Forge blocks the stage or asks for an explicit override payload, stop and resolve that first.\n# Plan\nUse Forge runtime.\n',
    });
  });

  test('builds a global Codex install plan under CODEX_HOME/skills', () => {
    const tmpDir = makeTempDir();
    const codexHome = path.join(tmpDir, '.codex-home');
    const skillsDir = path.join(tmpDir, '.codex', 'skills', 'status');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'SKILL.md'),
      '---\ndescription: Status workflow\nmode: code\n---\n# Status\nUse Forge runtime.\n'
    );

    const plan = buildCodexSkillInstallPlan(tmpDir, {
      env: { CODEX_HOME: codexHome },
      homeDir: tmpDir,
    });

    expect(plan).toHaveLength(1);
    expect(plan[0].absolutePath).toBe(path.join(codexHome, 'skills', 'status', 'SKILL.md'));
    expect(plan[0].displayPath).toBe('$CODEX_HOME/skills/status/SKILL.md');
    expect(formatCodexSkillsInstallDir({ env: { CODEX_HOME: codexHome }, homeDir: tmpDir })).toBe('$CODEX_HOME/skills');
  });
});

describe('CLAUDE.md content', () => {
  test('does not contain placeholder project description', () => {
    const claudeMdPath = path.resolve(__dirname, '..', 'CLAUDE.md');
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).not.toContain('[describe what this project does');
  });
});
