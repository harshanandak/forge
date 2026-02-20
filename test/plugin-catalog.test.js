const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

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
      assert.ok(CATALOG, 'CATALOG should be exported');
      assert.ok(TIERS, 'TIERS should be exported');
      assert.ok(TOOL_TYPES, 'TOOL_TYPES should be exported');
      assert.ok(STAGES, 'STAGES should be exported');
      assert.ok(BUDGET_MODES, 'BUDGET_MODES should be exported');
      assert.ok(PREREQUISITES, 'PREREQUISITES should be exported');
    });

    test('CATALOG is a frozen object', () => {
      assert.ok(Object.isFrozen(CATALOG));
    });
  });

  describe('TIERS', () => {
    test('has exactly 4 values: free, free-public, free-limited, paid', () => {
      const values = Object.values(TIERS);
      assert.strictEqual(values.length, 4);
      assert.ok(values.includes('free'));
      assert.ok(values.includes('free-public'));
      assert.ok(values.includes('free-limited'));
      assert.ok(values.includes('paid'));
    });
  });

  describe('TOOL_TYPES', () => {
    test('has exactly 5 values: cli, skill, mcp, config, lsp', () => {
      const values = Object.values(TOOL_TYPES);
      assert.strictEqual(values.length, 5);
      assert.ok(values.includes('cli'));
      assert.ok(values.includes('skill'));
      assert.ok(values.includes('mcp'));
      assert.ok(values.includes('config'));
      assert.ok(values.includes('lsp'));
    });
  });

  describe('STAGES', () => {
    test('covers all 7 workflow stages', () => {
      const values = Object.values(STAGES);
      assert.strictEqual(values.length, 7);
      assert.ok(values.includes('research'));
      assert.ok(values.includes('plan'));
      assert.ok(values.includes('dev'));
      assert.ok(values.includes('check'));
      assert.ok(values.includes('ship'));
      assert.ok(values.includes('review'));
      assert.ok(values.includes('merge'));
    });
  });

  describe('BUDGET_MODES', () => {
    test('has exactly 5 modes', () => {
      const keys = Object.keys(BUDGET_MODES);
      assert.strictEqual(keys.length, 5);
      assert.ok(keys.includes('free'));
      assert.ok(keys.includes('open-source'));
      assert.ok(keys.includes('startup'));
      assert.ok(keys.includes('professional'));
      assert.ok(keys.includes('custom'));
    });

    test('free mode includes only free tier', () => {
      assert.deepStrictEqual(BUDGET_MODES.free.includes, ['free']);
    });

    test('professional mode includes all 4 tiers', () => {
      const prof = BUDGET_MODES.professional.includes;
      assert.strictEqual(prof.length, 4);
      assert.ok(prof.includes('free'));
      assert.ok(prof.includes('free-public'));
      assert.ok(prof.includes('free-limited'));
      assert.ok(prof.includes('paid'));
    });
  });

  describe('catalog tool entries', () => {
    const validTiers = Object.values(TIERS);
    const validTypes = Object.values(TOOL_TYPES);
    const validStages = Object.values(STAGES);
    const validInstallMethods = ['npm', 'skills', 'add-mcp', 'config', 'lsp', 'go', 'binary'];

    test('at least 30 tools in the catalog', () => {
      const toolCount = Object.keys(CATALOG).length;
      assert.ok(toolCount >= 30, `Expected >= 30 tools, got ${toolCount}`);
    });

    test('no duplicate tool IDs', () => {
      const ids = Object.keys(CATALOG);
      const unique = new Set(ids);
      assert.strictEqual(ids.length, unique.size, 'Duplicate tool IDs found');
    });

    test('every tool has required fields: name, type, tier, stage, detectWhen, install', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        assert.ok(tool.name, `${id} missing name`);
        assert.ok(tool.type, `${id} missing type`);
        assert.ok(tool.tier, `${id} missing tier`);
        assert.ok(tool.stage, `${id} missing stage`);
        assert.ok(Array.isArray(tool.detectWhen), `${id} missing or invalid detectWhen`);
        assert.ok(tool.install, `${id} missing install`);
      }
    });

    test('every tool tier is a valid TIERS value', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        assert.ok(validTiers.includes(tool.tier), `${id} has invalid tier: ${tool.tier}`);
      }
    });

    test('every tool type is a valid TOOL_TYPES value', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        assert.ok(validTypes.includes(tool.type), `${id} has invalid type: ${tool.type}`);
      }
    });

    test('every tool stage is a valid STAGES value', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        assert.ok(validStages.includes(tool.stage), `${id} has invalid stage: ${tool.stage}`);
      }
    });

    test('every tool install has a valid method', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        assert.ok(
          validInstallMethods.includes(tool.install.method),
          `${id} has invalid install method: ${tool.install.method}`
        );
      }
    });

    test('every tool detectWhen is an array', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        assert.ok(Array.isArray(tool.detectWhen), `${id} detectWhen is not an array`);
      }
    });

    test('every paid tool has >= 1 free alternative', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        if (tool.tier === 'paid') {
          assert.ok(
            tool.alternatives && tool.alternatives.length >= 1,
            `Paid tool ${id} must have at least 1 free alternative`
          );
          const hasFreeAlt = tool.alternatives.some((alt) => alt.tier === 'free' || alt.tier === 'free-public');
          assert.ok(hasFreeAlt, `Paid tool ${id} must have at least 1 free/free-public alternative`);
        }
      }
    });

    test('every free-limited tool has >= 1 free alternative', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        if (tool.tier === 'free-limited') {
          assert.ok(
            tool.alternatives && tool.alternatives.length >= 1,
            `Free-limited tool ${id} must have at least 1 free alternative`
          );
          const hasFreeAlt = tool.alternatives.some((alt) => alt.tier === 'free');
          assert.ok(hasFreeAlt, `Free-limited tool ${id} must have at least 1 free alternative`);
        }
      }
    });

    test('every MCP-type tool has mcpJustified boolean', () => {
      for (const [id, tool] of Object.entries(CATALOG)) {
        if (tool.type === 'mcp') {
          assert.strictEqual(
            typeof tool.mcpJustified,
            'boolean',
            `MCP tool ${id} must have mcpJustified boolean`
          );
        }
      }
    });

    test('each stage has at least 1 free tool', () => {
      for (const stage of validStages) {
        const freeTools = Object.values(CATALOG).filter(
          (t) => t.stage === stage && t.tier === 'free'
        );
        assert.ok(
          freeTools.length >= 1,
          `Stage '${stage}' must have at least 1 free tool, found ${freeTools.length}`
        );
      }
    });
  });

  describe('PREREQUISITES', () => {
    test('each prerequisite has check command and installUrl', () => {
      for (const [id, prereq] of Object.entries(PREREQUISITES)) {
        assert.ok(prereq.check, `${id} missing check command`);
        assert.strictEqual(typeof prereq.check, 'string', `${id} check must be a string`);
        // installUrl can be null (e.g. curl is usually pre-installed)
        assert.ok('installUrl' in prereq, `${id} missing installUrl field`);
      }
    });
  });
});
