/**
 * Tests for getWorkflowCommands() — filesystem-derived command list.
 *
 * Verifies that workflow commands are read from .claude/commands/*.md
 * rather than hardcoded in an array.
 */

const path = require('path');
const fs = require('fs');
const { describe, test, expect } = require('bun:test');

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
    // Temporarily rename the commands directory
    const packageDir = path.resolve(__dirname, '..');
    const commandsDir = path.join(packageDir, '.claude', 'commands');
    const backupDir = commandsDir + '.bak';
    let renamed = false;

    try {
      fs.renameSync(commandsDir, backupDir);
      renamed = true;

      // Capture console.warn
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));

      const commands = getWorkflowCommands();

      console.warn = origWarn;

      expect(commands).toEqual([]);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain('.claude/commands');
    } finally {
      if (renamed) {
        fs.renameSync(backupDir, commandsDir);
      }
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
  const pluginFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.plugin.json'));

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

describe('CLAUDE.md content', () => {
  test('does not contain placeholder project description', () => {
    const claudeMdPath = path.resolve(__dirname, '..', 'CLAUDE.md');
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).not.toContain('[describe what this project does');
  });
});
