/**
 * Tests for getWorkflowCommands() — filesystem-derived command list.
 *
 * Verifies that workflow commands are read from .claude/commands/*.md
 * rather than hardcoded in an array.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { afterEach, describe, test, expect } = require('bun:test');
const { listCodexSkillEntries } = require('../lib/codex-skills');

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

// We will import getWorkflowCommands from bin/forge.js once it is exported
let getWorkflowCommands;
try {
  ({ getWorkflowCommands } = require('../bin/forge.js'));
} catch (_e) {
  // Will fail in RED phase — expected
}

describe('getWorkflowCommands', () => {
  test('returns an array of command names from .claude/commands/*.md', () => {
    const commands = getWorkflowCommands();
    expect(Array.isArray(commands)).toBe(true);
    expect(commands.length).toBeGreaterThan(0);

    // Should match the actual .md files in .claude/commands/
    const packageDir = path.resolve(__dirname, '..');
    const commandsDir = path.join(packageDir, '.claude', 'commands');
    const expected = fs.readdirSync(commandsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''))
      .sort();

    expect(commands.sort()).toEqual(expected);
  });

  test('filters out non-.md files', () => {
    const commands = getWorkflowCommands();
    // Every returned name should correspond to a .md file
    const packageDir = path.resolve(__dirname, '..');
    const commandsDir = path.join(packageDir, '.claude', 'commands');
    for (const cmd of commands) {
      const mdPath = path.join(commandsDir, `${cmd}.md`);
      expect(fs.existsSync(mdPath)).toBe(true);
    }
  });

  test('returns empty array and warns when directory does not exist', () => {
    // Mock readdirSync to throw only for .claude/commands path
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
    // The pattern "else if (process.env.DEBUG) { ... Source file not found"
    // should NOT exist — warning should always fire
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
    pluginFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.plugin.json'));
  } catch (_e) {
    // lib/agents/ may not exist in all environments
  }

  test('package.json description mentions correct agent count or "all AI agents"', () => {
    const desc = packageJson.description;
    // Must either say "ALL AI" (case-insensitive) or mention the actual plugin count
    const mentionsAll = /all ai/i.test(desc);
    const mentionsCount = desc.includes(String(pluginFiles.length));
    expect(mentionsAll || mentionsCount).toBe(true);
  });

  test('README agent count is consistent with lib/agents/*.plugin.json count', () => {
    const actualCount = pluginFiles.length;
    // Check all numeric agent count claims in README
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

  test('keeps the Codex skill directory aligned with stage skills', () => {
    expect(codexPlugin.directories.skills).toBe('.codex/skills');
  });
});

describe('Codex skill entry generation', () => {
  test('returns an empty list when canonical commands are missing', () => {
    const tmpDir = makeTempDir();

    expect(listCodexSkillEntries(tmpDir)).toEqual([]);
  });

  test('builds per-stage Codex skills from canonical commands', () => {
    const tmpDir = makeTempDir();
    const commandsDir = path.join(tmpDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDir, 'plan.md'),
      '---\ndescription: Plan workflow\nmode: code\n---\n# Plan\nUse Forge runtime.\n'
    );

    const entries = listCodexSkillEntries(tmpDir);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      commandName: 'plan',
      dir: '.codex/skills/plan/',
      filename: 'SKILL.md',
      content: '---\ndescription: Plan workflow\n---\n> Forge stage adapter\n\nBefore executing this workflow, invoke `forge plan` so Forge can enforce stage order, runtime prerequisites, and override rules.\nIf Forge blocks the stage or asks for an explicit override payload, stop and resolve that first.\n\n# Plan\nUse Forge runtime.\n',
    });
  });
});

describe('CLAUDE.md content', () => {
  test('does not contain placeholder project description', () => {
    const claudeMdPath = path.resolve(__dirname, '..', 'CLAUDE.md');
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).not.toContain('[describe what this project does');
  });
});
