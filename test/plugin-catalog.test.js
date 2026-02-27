const { describe, test, expect } = require('bun:test');

const {
  CATALOG,
  TIERS,
  TOOL_TYPES,
  STAGES,
  BUDGET_MODES,
  PREREQUISITES,
} = require('../lib/plugin-catalog');

describe('plugin-catalog', () => {
  describe('exports', () => {
    test('exports CATALOG, TIERS, TOOL_TYPES, STAGES, BUDGET_MODES, PREREQUISITES', () => {
      expect(CATALOG).toBeTruthy();
      expect(TIERS).toBeTruthy();
      expect(TOOL_TYPES).toBeTruthy();
      expect(STAGES).toBeTruthy();
      expect(BUDGET_MODES).toBeTruthy();
      expect(PREREQUISITES).toBeTruthy();
    });

    test('CATALOG is a frozen object', () => {
      expect(Object.isFrozen(CATALOG)).toBeTruthy();
    });
  });

  describe('TIERS', () => {
    test('has exactly 4 values: free, free-public, free-limited, paid', () => {
      const values = Object.values(TIERS);
      expect(values.length).toBe(4);
      expect(values.includes('free')).toBeTruthy();
      expect(values.includes('free-public')).toBeTruthy();
      expect(values.includes('free-limited')).toBeTruthy();
      expect(values.includes('paid')).toBeTruthy();
    });
  });

  describe('TOOL_TYPES', () => {
    test('has exactly 5 values: cli, skill, mcp, config, lsp', () => {
      const values = Object.values(TOOL_TYPES);
      expect(values.length).toBe(5);
      expect(values.includes('cli')).toBeTruthy();
      expect(values.includes('skill')).toBeTruthy();
      expect(values.includes('mcp')).toBeTruthy();
      expect(values.includes('config')).toBeTruthy();
      expect(values.includes('lsp')).toBeTruthy();
    });
  });

  describe('STAGES', () => {
    test('covers all 7 workflow stages', () => {
      const values = Object.values(STAGES);
      expect(values.length).toBe(7);
      expect(values.includes('research')).toBeTruthy();
      expect(values.includes('plan')).toBeTruthy();
      expect(values.includes('dev')).toBeTruthy();
      expect(values.includes('check')).toBeTruthy();
      expect(values.includes('ship')).toBeTruthy();
      expect(values.includes('review')).toBeTruthy();
      expect(values.includes('merge')).toBeTruthy();
    });
  });

  describe('BUDGET_MODES', () => {
    test('has exactly 5 modes', () => {
      const keys = Object.keys(BUDGET_MODES);
      expect(keys.length).toBe(5);
      expect(keys.includes('free')).toBeTruthy();
      expect(keys.includes('open-source')).toBeTruthy();
      expect(keys.includes('startup')).toBeTruthy();
      expect(keys.includes('professional')).toBeTruthy();
      expect(keys.includes('custom')).toBeTruthy();
    });

    test('free mode includes only free tier', () => {
      expect(BUDGET_MODES.free.includes).toEqual(['free']);
    });

    test('professional mode includes all 4 tiers', () => {
      const prof = BUDGET_MODES.professional.includes;
      expect(prof.length).toBe(4);
      expect(prof.includes('free')).toBeTruthy();
      expect(prof.includes('free-public')).toBeTruthy();
      expect(prof.includes('free-limited')).toBeTruthy();
      expect(prof.includes('paid')).toBeTruthy();
    });
  });

  describe('catalog tool entries', () => {
    const validTiers = Object.values(TIERS);
    const validTypes = Object.values(TOOL_TYPES);
    const validStages = Object.values(STAGES);
    const validInstallMethods = ['npm', 'skills', 'add-mcp', 'config', 'lsp', 'go', 'binary'];

    test('at least 30 tools in the catalog', () => {
      const toolCount = Object.keys(CATALOG).length;
      expect(toolCount >= 30).toBeTruthy();
    });

    test('no duplicate tool IDs', () => {
      const ids = Object.keys(CATALOG);
      const unique = new Set(ids);
      expect(ids.length).toBe(unique.size);
    });

    test('every tool has required fields: name, type, tier, stage, detectWhen, install', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        expect(tool.name).toBeTruthy();
        expect(tool.type).toBeTruthy();
        expect(tool.tier).toBeTruthy();
        expect(tool.stage).toBeTruthy();
        expect(Array.isArray(tool.detectWhen)).toBeTruthy();
        expect(tool.install).toBeTruthy();
      }
    });

    test('every tool tier is a valid TIERS value', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        expect(validTiers.includes(tool.tier)).toBeTruthy();
      }
    });

    test('every tool type is a valid TOOL_TYPES value', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        expect(validTypes.includes(tool.type)).toBeTruthy();
      }
    });

    test('every tool stage is a valid STAGES value', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        expect(validStages.includes(tool.stage)).toBeTruthy();
      }
    });

    test('every tool install has a valid method', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        expect(validInstallMethods.includes(tool.install.method)).toBeTruthy();
      }
    });

    test('every tool detectWhen is an array', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        expect(Array.isArray(tool.detectWhen)).toBeTruthy();
      }
    });

    test('every paid tool has >= 1 free alternative', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        if (tool.tier === 'paid') {
          expect(tool.alternatives && tool.alternatives.length >= 1).toBeTruthy();
          const hasFreeAlt = tool.alternatives.some((alt) => alt.tier === 'free' || alt.tier === 'free-public');
          expect(hasFreeAlt).toBeTruthy();
        }
      }
    });

    test('every free-limited tool has >= 1 free alternative', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        if (tool.tier === 'free-limited') {
          expect(tool.alternatives && tool.alternatives.length >= 1).toBeTruthy();
          const hasFreeAlt = tool.alternatives.some((alt) => alt.tier === 'free');
          expect(hasFreeAlt).toBeTruthy();
        }
      }
    });

    test('every MCP-type tool has mcpJustified boolean', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        if (tool.type === 'mcp') {
          expect(typeof tool.mcpJustified).toBe('boolean');
        }
      }
    });

    test('each stage has at least 1 free tool', () => {
      for (const stage of validStages) {
        const freeTools = Object.values(CATALOG).filter(
          (t) => t.stage === stage && t.tier === 'free'
        );
        expect(freeTools.length >= 1).toBeTruthy();
      }
    });
  });

  describe('skills restructure (PR5.5)', () => {
    test("catalog has 'parallel-web-search' entry (not 'parallel-ai')", () => {
      expect(CATALOG['parallel-web-search']).toBeTruthy();
      expect(!CATALOG['parallel-ai']).toBeTruthy();
    });

    test("parallel-web-search install.cmd references parallel-web/parallel-agent-skills", () => {
      const entry = CATALOG['parallel-web-search'];
      if (!entry) return;
      expect(entry.install.cmd.includes('parallel-web/parallel-agent-skills')).toBeTruthy();
    });

    test("parallel-web-search has install.cmdCurl referencing harshanandak/forge", () => {
      const entry = CATALOG['parallel-web-search'];
      if (!entry) return;
      expect(entry.install.cmdCurl).toBeTruthy();
      expect(entry.install.cmdCurl.includes('harshanandak/forge')).toBeTruthy();
    });

    test("catalog has 'sonarcloud-analysis' entry (not 'sonarcloud')", () => {
      expect(CATALOG['sonarcloud-analysis']).toBeTruthy();
      expect(!CATALOG['sonarcloud']).toBeTruthy();
    });

    test("sonarcloud-analysis install.cmd references harshanandak/forge", () => {
      const entry = CATALOG['sonarcloud-analysis'];
      if (!entry) return;
      expect(entry.install.cmd.includes('harshanandak/forge')).toBeTruthy();
    });

    test("PREREQUISITES has 'parallel-cli' entry", () => {
      expect(PREREQUISITES['parallel-cli']).toBeTruthy();
    });
  });

  describe('PREREQUISITES', () => {
    test('each prerequisite has check command and installUrl', () => {
      for (const [id, prereq] of Object.entries(PREREQUISITES)) {
        expect(prereq.check).toBeTruthy();
        expect(typeof prereq.check).toBe('string');
        // installUrl can be null (e.g. curl is usually pre-installed)
        expect('installUrl' in prereq).toBeTruthy();
      }
    });
  });
});
