/**
 * Tests for agent command parity and explicit exceptions.
 *
 * The canonical workflow source remains `.claude/commands/`, with Claude Code
 * intentionally skipped during sync because it is the source adapter.
 */

const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');
const { AGENT_ADAPTERS, syncCommands } = require('../scripts/sync-commands');

const repoRoot = path.resolve(__dirname, '..');
const clinePlugin = require('../lib/agents/cline.plugin.json');
const rooPlugin = require('../lib/agents/roo.plugin.json');

describe('agent parity gaps', () => {
  test('claude-code remains the canonical adapter and is intentionally skipped', () => {
    const adapter = AGENT_ADAPTERS['claude-code'];
    expect(adapter).toBeDefined();
    expect(adapter.skip).toBe(true);
    expect(typeof adapter.transformFrontmatter).toBe('function');
  });

  test('sync does not generate files for the canonical claude-code adapter', () => {
    const result = syncCommands({ dryRun: true, check: false, repoRoot });
    const claudeEntries = result.planned.filter((entry) => entry.agent === 'claude-code');
    expect(claudeEntries).toEqual([]);
  });

  test('sync generates files for every non-skipped registered agent', () => {
    const result = syncCommands({ dryRun: true, check: false, repoRoot });
    const agentsWithEntries = new Set(result.planned.map((entry) => entry.agent));
    for (const agentName of Object.keys(AGENT_ADAPTERS)) {
      if (AGENT_ADAPTERS[agentName].skip) {
        expect(agentsWithEntries.has(agentName)).toBe(false);
      } else {
        expect(agentsWithEntries.has(agentName)).toBe(true);
      }
    }
  });

  test('canonical source is .claude/commands/', () => {
    const commandsDir = path.join(repoRoot, '.claude', 'commands');
    expect(fs.existsSync(commandsDir)).toBe(true);

    const result = syncCommands({ dryRun: true, check: false, repoRoot });
    expect(result.planned.length).toBeGreaterThan(0);
  });

  test('all 8 agents have adapters', () => {
    const expected = [
      'claude-code', 'cursor', 'cline', 'opencode',
      'github-copilot', 'kilo-code', 'roo-code', 'codex',
    ];
    for (const agent of expected) {
      expect(AGENT_ADAPTERS[agent]).toBeDefined();
    }
  });

  test('contentHash is exported from sync-commands', () => {
    const { contentHash } = require('../scripts/sync-commands');
    expect(typeof contentHash).toBe('function');
    const hash = contentHash('test content');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64);
  });

  test('Roo and Cline are explicitly downgraded until native parity is proven', () => {
    for (const plugin of [clinePlugin, rooPlugin]) {
      expect(plugin.support?.status).toBe('deprecated');
      expect(plugin.support?.surface).toBe('editor-native');
      expect(plugin.capabilities.skills).toBe(false);
      expect(plugin.directories.skills).toBeUndefined();
      expect(plugin.setup?.createSkill).toBeUndefined();
    }
  });
});
