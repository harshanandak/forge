/**
 * Tests for getWorkflowCommands() — filesystem-derived command list.
 *
 * Verifies that workflow commands are read from .claude/commands/*.md
 * rather than hardcoded in an array.
 */

const path = require('path');
const fs = require('fs');
const { describe, test, expect, beforeEach, afterEach } = require('bun:test');

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
