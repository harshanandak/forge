/**
 * Tests for agent-parity gaps — verifies that all agents get equal treatment.
 *
 * Ensures that sync-commands.js generates files for ALL agents (no skip),
 * and that the canonical source is commands/ (not .claude/commands/).
 */

const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');
const { AGENT_ADAPTERS, syncCommands } = require('../scripts/sync-commands');

const repoRoot = path.resolve(__dirname, '..');
const clinePlugin = require('../lib/agents/cline.plugin.json');
const rooPlugin = require('../lib/agents/roo.plugin.json');

describe('agent parity gaps', () => {
  test('no agent adapter has skip: true', () => {
    for (const [_name, adapter] of Object.entries(AGENT_ADAPTERS)) {
      expect(adapter.skip).not.toBe(true);
    }
  });

  test('claude-code is a normal adapter (not skipped)', () => {
    const adapter = AGENT_ADAPTERS['claude-code'];
    expect(adapter).toBeDefined();
    expect(adapter.skip).toBeUndefined();
    expect(typeof adapter.transformFrontmatter).toBe('function');
  });

  test('sync generates files for claude-code agent', () => {
    const result = syncCommands({ dryRun: true, check: false, repoRoot });
    const claudeEntries = result.planned.filter(e => e.agent === 'claude-code');
    expect(claudeEntries.length).toBeGreaterThan(0);
  });

  test('sync generates files for ALL registered agents', () => {
    const result = syncCommands({ dryRun: true, check: false, repoRoot });
    const agentsWithEntries = new Set(result.planned.map(e => e.agent));
    for (const agentName of Object.keys(AGENT_ADAPTERS)) {
      expect(agentsWithEntries.has(agentName)).toBe(true);
    }
  });

  test('canonical source is commands/ not .claude/commands/', () => {
    // Verify by checking that syncCommands reads from commands/
    const commandsDir = path.join(repoRoot, 'commands');
    expect(fs.existsSync(commandsDir)).toBe(true);

    // The sync should work with commands/ present
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
    expect(hash.length).toBe(64); // SHA-256 hex
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
