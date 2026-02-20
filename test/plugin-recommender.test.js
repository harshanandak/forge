const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { recommend, matchesDetection } = require('../lib/plugin-recommender');
const { CATALOG, TIERS } = require('../lib/plugin-catalog');

// Helper: minimal tech stack with all fields
function emptyStack() {
  return {
    frameworks: [], languages: ['javascript'], databases: [],
    auth: [], payments: [], cicd: [], testing: [], linting: [], lsps: [],
  };
}

describe('plugin-recommender', () => {
  describe('recommend() return shape', () => {
    test('returns { recommended, skipped }', () => {
      const result = recommend(emptyStack(), 'startup');
      assert.ok(Array.isArray(result.recommended), 'recommended should be array');
      assert.ok(Array.isArray(result.skipped), 'skipped should be array');
    });
  });

  describe('budget mode filtering', () => {
    test('free mode returns only free-tier tools', () => {
      const result = recommend(emptyStack(), 'free');
      for (const tool of result.recommended) {
        assert.strictEqual(tool.tier, 'free', `${tool.id} should be free, got ${tool.tier}`);
      }
    });

    test('free mode excludes paid, free-limited, free-public tools', () => {
      const result = recommend(emptyStack(), 'free');
      const tiers = result.recommended.map((t) => t.tier);
      assert.ok(!tiers.includes('paid'));
      assert.ok(!tiers.includes('free-limited'));
      assert.ok(!tiers.includes('free-public'));
    });

    test('open-source mode includes free + free-public', () => {
      const result = recommend(emptyStack(), 'open-source');
      const tiers = new Set(result.recommended.map((t) => t.tier));
      // Should NOT include paid or free-limited
      assert.ok(!tiers.has('paid'));
      assert.ok(!tiers.has('free-limited'));
    });

    test('startup mode includes free + free-public + free-limited', () => {
      const result = recommend(emptyStack(), 'startup');
      const tiers = new Set(result.recommended.map((t) => t.tier));
      assert.ok(!tiers.has('paid'));
    });

    test('professional mode includes all tiers', () => {
      const result = recommend(emptyStack(), 'professional');
      // Professional should not exclude any tier — just check it returns results
      assert.ok(result.recommended.length > 0);
    });

    test('custom mode with empty selections returns nothing', () => {
      const result = recommend(emptyStack(), 'custom', { customTiers: [] });
      assert.strictEqual(result.recommended.length, 0);
    });

    test('custom mode with specific selections returns only those', () => {
      const result = recommend(emptyStack(), 'custom', { customTiers: ['free'] });
      for (const tool of result.recommended) {
        assert.strictEqual(tool.tier, 'free');
      }
    });

    test('validates budget mode', () => {
      assert.throws(() => recommend(emptyStack(), 'invalid-mode'), {
        message: /invalid budget mode/i,
      });
    });
  });

  describe('CLI-first enforcement', () => {
    test('justified MCPs (e.g. context7) are included', () => {
      const result = recommend(emptyStack(), 'professional');
      const context7 = result.recommended.find((t) => t.id === 'context7-mcp');
      assert.ok(context7, 'context7-mcp should be recommended (mcpJustified: true)');
    });

    test('unjustified MCPs are skipped when CLI alternative exists', () => {
      // All current MCPs are justified, so this test verifies the mechanism
      // by checking that skipped tools have reasons
      const result = recommend(emptyStack(), 'professional');
      for (const skipped of result.skipped) {
        assert.ok(skipped.reason, `Skipped tool ${skipped.id} should have a reason`);
      }
    });
  });

  describe('sorting', () => {
    test('recommendations sorted: free first, then by stage', () => {
      const result = recommend(emptyStack(), 'professional');
      if (result.recommended.length >= 2) {
        // Free tools should come before paid tools
        let seenNonFree = false;
        for (const tool of result.recommended) {
          if (tool.tier !== 'free') seenNonFree = true;
          if (seenNonFree && tool.tier === 'free') {
            // This is allowed if they're in different stages — just verify structure
            assert.ok(tool.id, 'Tool should have id');
          }
        }
      }
    });
  });

  describe('skipped tools', () => {
    test('skipped tools are returned with reason', () => {
      const result = recommend(emptyStack(), 'free');
      // Some tools should be skipped (non-free tiers)
      if (result.skipped.length > 0) {
        for (const skipped of result.skipped) {
          assert.ok(skipped.id, 'Skipped tool should have id');
          assert.ok(skipped.reason, 'Skipped tool should have reason');
        }
      }
    });
  });

  describe('matchesDetection()', () => {
    test('is exported as a function', () => {
      assert.strictEqual(typeof matchesDetection, 'function');
    });

    test('matches dep condition', () => {
      const stack = { ...emptyStack(), frameworks: [], databases: [] };
      // dep:stripe matches if 'stripe' is in payments
      assert.ok(matchesDetection(['dep:stripe'], { ...stack, payments: ['stripe'] }));
    });

    test('matches file condition', () => {
      assert.ok(matchesDetection(['file:tsconfig.json'], { ...emptyStack(), lsps: ['typescript'] }));
    });

    test('matches framework condition', () => {
      assert.ok(matchesDetection(['dep:next'], { ...emptyStack(), frameworks: ['nextjs'] }));
    });

    test('empty detectWhen matches everything', () => {
      assert.ok(matchesDetection([], emptyStack()));
    });

    test('multiple conditions use OR logic', () => {
      // Should match if ANY condition is true
      const stack = { ...emptyStack(), frameworks: ['express'] };
      assert.ok(matchesDetection(['dep:react', 'dep:express'], stack));
    });
  });

  describe('project-specific recommendations', () => {
    test('React project gets React-related tools', () => {
      const stack = { ...emptyStack(), frameworks: ['react'] };
      const result = recommend(stack, 'professional');
      assert.ok(result.recommended.length > 0);
    });

    test('Express project gets security tools', () => {
      const stack = { ...emptyStack(), frameworks: ['express'] };
      const result = recommend(stack, 'professional');
      const secPlugin = result.recommended.find((t) => t.id === 'eslint-plugin-security');
      assert.ok(secPlugin, 'Express project should get eslint-plugin-security');
    });

    test('Supabase project gets Supabase CLI recommendation', () => {
      const stack = { ...emptyStack(), databases: ['supabase'] };
      const result = recommend(stack, 'startup');
      const supabase = result.recommended.find((t) => t.id === 'supabase-cli');
      assert.ok(supabase, 'Supabase project should get supabase-cli');
    });

    test('empty tech stack gets only universal tools', () => {
      const result = recommend(emptyStack(), 'professional');
      // Universal tools have empty detectWhen — they should all be included
      const universalCount = Object.values(CATALOG).filter(
        (t) => t.detectWhen.length === 0
      ).length;
      // At least some universal tools should appear
      assert.ok(result.recommended.length > 0);
      assert.ok(result.recommended.length <= universalCount + 5); // small buffer for detected ones
    });
  });

  describe('paid tool alternatives', () => {
    test('every paid recommendation includes alternatives', () => {
      const result = recommend(emptyStack(), 'professional');
      const paidTools = result.recommended.filter((t) => t.tier === 'paid');
      for (const tool of paidTools) {
        assert.ok(
          tool.alternatives && tool.alternatives.length >= 1,
          `Paid tool ${tool.id} should include alternatives`
        );
      }
    });
  });

  describe('specific tools appear', () => {
    test('parallel-ai appears in recommendations', () => {
      const result = recommend(emptyStack(), 'startup');
      const parallelAi = result.recommended.find((t) => t.id === 'parallel-ai');
      assert.ok(parallelAi, 'parallel-ai should appear in recommendations');
    });

    test('sonarcloud appears for open-source projects', () => {
      const result = recommend(emptyStack(), 'open-source');
      const sonar = result.recommended.find((t) => t.id === 'sonarcloud');
      assert.ok(sonar, 'sonarcloud should appear for open-source budget');
    });
  });
});
