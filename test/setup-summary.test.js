const { describe, test, expect } = require('bun:test');
const { SetupActionLog } = require('../lib/setup-action-log');

// We test renderSetupSummary which will be exported from bin/forge.js internals.
// Since bin/forge.js is a CLI entry point, we extract the renderer as a standalone
// module so it can be tested independently.
const { renderSetupSummary } = require('../lib/setup-summary-renderer');

describe('setup summary renderer', () => {
  describe('--verbose flag recognition', () => {
    test('renderSetupSummary accepts a verbose boolean parameter', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');
      // Should not throw when verbose=true
      const output = renderSetupSummary(log, ['claude'], true);
      expect(output).toBeDefined();
    });
  });

  describe('default (non-verbose) output', () => {
    test('should produce a concise summary with counts and agent names', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');
      log.add('.claude/commands/dev.md', 'created');
      log.add('.cursor/rules/forge.md', 'created');
      log.add('.claude/CLAUDE.md', 'skipped', 'identical content');
      log.add('AGENTS.md', 'merged');

      const output = renderSetupSummary(log, ['claude', 'cursor'], false);

      // Line 1: completion message with agent names
      expect(output).toContain('Forge setup complete');
      expect(output).toContain('claude');
      expect(output).toContain('cursor');

      // Line 2: counts
      expect(output).toContain('Created: 3');
      expect(output).toContain('Skipped: 1');
      expect(output).toContain('Merged: 1');

      // Line 3: verbose hint
      expect(output).toContain('--verbose');
    });

    test('should show agent count in completion message', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');

      const output = renderSetupSummary(log, ['claude'], false);
      expect(output).toContain('1 agent');
    });

    test('should pluralize agents correctly', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');
      log.add('.cursor/rules/forge.md', 'created');

      const output = renderSetupSummary(log, ['claude', 'cursor'], false);
      expect(output).toContain('2 agents');
    });

    test('should not exceed 3 lines', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');
      log.add('.cursor/rules/forge.md', 'skipped', 'identical');

      const output = renderSetupSummary(log, ['claude', 'cursor'], false);
      const lines = output.split('\n').filter(l => l.trim().length > 0);
      expect(lines.length).toBeLessThanOrEqual(3);
    });

    test('should omit zero-count actions from the counts line', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');
      log.add('.claude/commands/dev.md', 'created');
      // No skipped or merged

      const output = renderSetupSummary(log, ['claude'], false);
      expect(output).toContain('Created: 2');
      expect(output).not.toContain('Skipped:');
      expect(output).not.toContain('Merged:');
    });
  });

  describe('verbose output', () => {
    test('should include file-by-file detail grouped by agent', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');
      log.add('.claude/commands/dev.md', 'created');
      log.add('.cursor/rules/forge.md', 'created');
      log.add('AGENTS.md', 'skipped', 'identical');

      const output = renderSetupSummary(log, ['claude', 'cursor'], true);

      // Should contain agent groupings
      expect(output).toContain('Claude Code');
      expect(output).toContain('Cursor');

      // Should contain file names
      expect(output).toContain('settings.json');
      expect(output).toContain('dev.md');
      expect(output).toContain('forge.md');
    });

    test('should show action type in verbose output', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');
      log.add('.cursor/rules/forge.md', 'skipped', 'identical');
      log.add('AGENTS.md', 'merged');

      const output = renderSetupSummary(log, ['claude', 'cursor'], true);
      expect(output).toContain('created');
      expect(output).toContain('skipped');
      expect(output).toContain('merged');
    });

    test('should NOT show --verbose hint when already in verbose mode', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');

      const output = renderSetupSummary(log, ['claude'], true);
      expect(output).not.toContain('Run forge setup --verbose');
    });

    test('should include agent names in verbose output', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');
      log.add('.cursor/rules/forge.md', 'created');

      const output = renderSetupSummary(log, ['claude', 'cursor'], true);
      expect(output).toContain('Claude Code');
      expect(output).toContain('Cursor');
    });
  });

  describe('edge cases', () => {
    test('should handle empty action log gracefully', () => {
      const log = new SetupActionLog();
      const output = renderSetupSummary(log, ['claude'], false);
      expect(output).toContain('Forge setup complete');
      expect(output).toContain('0 files');
    });

    test('should handle empty agent list', () => {
      const log = new SetupActionLog();
      log.add('AGENTS.md', 'created');
      const output = renderSetupSummary(log, [], false);
      expect(output).toContain('Forge setup complete');
    });
  });
});
