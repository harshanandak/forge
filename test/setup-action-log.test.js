const { describe, test, expect } = require('bun:test');

// Module under test
const { SetupActionLog } = require('../lib/setup-action-log');

describe('SetupActionLog', () => {
  describe('add() and length', () => {
    test('should collect entries and report correct length', () => {
      const log = new SetupActionLog();
      expect(log.length).toBe(0);

      log.add('.claude/settings.json', 'created');
      expect(log.length).toBe(1);

      log.add('.cursor/rules/forge.md', 'skipped', 'already exists');
      expect(log.length).toBe(2);
    });
  });

  describe('getVerbose()', () => {
    test('should return full action list with all fields', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');
      log.add('.cursor/rules/forge.md', 'skipped', 'already exists');

      const verbose = log.getVerbose();
      expect(verbose).toEqual([
        { file: '.claude/settings.json', action: 'created', detail: null },
        { file: '.cursor/rules/forge.md', action: 'skipped', detail: 'already exists' }
      ]);
    });

    test('should return empty array for empty log', () => {
      const log = new SetupActionLog();
      expect(log.getVerbose()).toEqual([]);
    });
  });

  describe('getSummary()', () => {
    test('should return correct grouped counts', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');
      log.add('.claude/commands/dev.md', 'created');
      log.add('.cursor/rules/forge.md', 'skipped');
      log.add('AGENTS.md', 'merged');
      log.add('.claude/settings.json', 'conflict', 'manual resolution needed');
      log.add('.windsurf/old-config.json', 'removed');
      log.add('.claude/CLAUDE.md', 'force-created');

      const summary = log.getSummary();
      expect(summary).toEqual({
        created: 2,
        skipped: 1,
        merged: 1,
        conflict: 1,
        removed: 1,
        'force-created': 1
      });
    });

    test('should return zero counts for empty log', () => {
      const log = new SetupActionLog();
      const summary = log.getSummary();
      expect(summary).toEqual({});
    });

    test('should handle single action type', () => {
      const log = new SetupActionLog();
      log.add('a.js', 'created');
      log.add('b.js', 'created');
      log.add('c.js', 'created');

      expect(log.getSummary()).toEqual({ created: 3 });
    });
  });

  describe('getByAction()', () => {
    test('should filter actions by type', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');
      log.add('.cursor/rules/forge.md', 'skipped');
      log.add('.claude/commands/dev.md', 'created');
      log.add('AGENTS.md', 'merged');

      const created = log.getByAction('created');
      expect(created).toEqual([
        { file: '.claude/settings.json', action: 'created', detail: null },
        { file: '.claude/commands/dev.md', action: 'created', detail: null }
      ]);
    });

    test('should return empty array when no matches', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');

      expect(log.getByAction('removed')).toEqual([]);
    });
  });

  describe('getAgentSummary()', () => {
    test('should group files by agent name detected from path', () => {
      const log = new SetupActionLog();
      log.add('.claude/settings.json', 'created');
      log.add('.claude/commands/dev.md', 'created');
      log.add('.claude/commands/plan.md', 'skipped');
      log.add('.cursor/rules/forge.md', 'created');
      log.add('.cursor/rules/old.md', 'removed');
      log.add('.codex/skills/dev/SKILL.md', 'merged');
      log.add('.cline/settings.json', 'created');
      log.add('.github/prompts/plan.prompt.md', 'skipped');

      const agentSummary = log.getAgentSummary();

      expect(agentSummary['Claude Code']).toBeDefined();
      expect(agentSummary['Claude Code'].created).toEqual([
        'settings.json',
        'commands/dev.md'
      ]);
      expect(agentSummary['Claude Code'].skipped).toEqual([
        'commands/plan.md'
      ]);

      expect(agentSummary['Cursor']).toBeDefined();
      expect(agentSummary['Cursor'].created).toEqual(['rules/forge.md']);
      expect(agentSummary['Cursor'].removed).toEqual(['rules/old.md']);

      expect(agentSummary['Codex']).toBeDefined();
      expect(agentSummary['Codex'].merged).toEqual(['skills/dev/SKILL.md']);

      expect(agentSummary['Cline']).toBeDefined();
      expect(agentSummary['Cline'].created).toEqual(['settings.json']);

      expect(agentSummary['GitHub Copilot']).toBeDefined();
      expect(agentSummary['GitHub Copilot'].skipped).toEqual(['plan.prompt.md']);
    });

    test('should handle files not matching any known agent', () => {
      const log = new SetupActionLog();
      log.add('AGENTS.md', 'created');
      log.add('lefthook.yml', 'created');

      const agentSummary = log.getAgentSummary();
      expect(agentSummary['General']).toBeDefined();
      expect(agentSummary['General'].created).toEqual([
        'AGENTS.md',
        'lefthook.yml'
      ]);
    });

    test('should return empty object for empty log', () => {
      const log = new SetupActionLog();
      expect(log.getAgentSummary()).toEqual({});
    });
  });
});
