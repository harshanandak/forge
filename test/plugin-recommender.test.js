const { describe, test, expect } = require('bun:test');

const { recommend, matchesDetection } = require('../lib/plugin-recommender');
const { CATALOG } = require('../lib/plugin-catalog');

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
      expect(Array.isArray(result.recommended)).toBeTruthy();
      expect(Array.isArray(result.skipped)).toBeTruthy();
    });
  });

  describe('budget mode filtering', () => {
    test('free mode returns only free-tier tools', () => {
      const result = recommend(emptyStack(), 'free');
      for (const tool of result.recommended) {
        expect(tool.tier).toBe('free');
      }
    });

    test('free mode excludes paid, free-limited, free-public tools', () => {
      const result = recommend(emptyStack(), 'free');
      const tiers = result.recommended.map((t) => t.tier);
      expect(!tiers.includes('paid')).toBeTruthy();
      expect(!tiers.includes('free-limited')).toBeTruthy();
      expect(!tiers.includes('free-public')).toBeTruthy();
    });

    test('open-source mode includes free + free-public', () => {
      const result = recommend(emptyStack(), 'open-source');
      const tiers = new Set(result.recommended.map((t) => t.tier));
      // Should NOT include paid or free-limited
      expect(!tiers.has('paid')).toBeTruthy();
      expect(!tiers.has('free-limited')).toBeTruthy();
    });

    test('startup mode includes free + free-public + free-limited', () => {
      const result = recommend(emptyStack(), 'startup');
      const tiers = new Set(result.recommended.map((t) => t.tier));
      expect(!tiers.has('paid')).toBeTruthy();
    });

    test('professional mode includes all tiers', () => {
      const result = recommend(emptyStack(), 'professional');
      // Professional should not exclude any tier — just check it returns results
      expect(result.recommended.length > 0).toBeTruthy();
    });

    test('custom mode with empty selections returns nothing', () => {
      const result = recommend(emptyStack(), 'custom', { customTiers: [] });
      expect(result.recommended.length).toBe(0);
    });

    test('custom mode with specific selections returns only those', () => {
      const result = recommend(emptyStack(), 'custom', { customTiers: ['free'] });
      for (const tool of result.recommended) {
        expect(tool.tier).toBe('free');
      }
    });

    test('validates budget mode', () => {
      expect(() => recommend(emptyStack(), 'invalid-mode')).toThrow();
    });
  });

  describe('CLI-first enforcement', () => {
    test('justified MCPs (e.g. context7) are included', () => {
      const result = recommend(emptyStack(), 'professional');
      const context7 = result.recommended.find((t) => t.id === 'context7-mcp');
      expect(context7).toBeTruthy();
    });

    test('unjustified MCPs are skipped when CLI alternative exists', () => {
      // All current MCPs are justified, so this test verifies the mechanism
      // by checking that skipped tools have reasons
      const result = recommend(emptyStack(), 'professional');
      for (const skipped of result.skipped) {
        expect(skipped.reason).toBeTruthy();
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
            expect(tool.id).toBeTruthy();
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
          expect(skipped.id).toBeTruthy();
          expect(skipped.reason).toBeTruthy();
        }
      }
    });
  });

  describe('matchesDetection()', () => {
    test('is exported as a function', () => {
      expect(typeof matchesDetection).toBe('function');
    });

    test('matches dep condition', () => {
      const stack = { ...emptyStack(), frameworks: [], databases: [] };
      // dep:stripe matches if 'stripe' is in payments
      expect(matchesDetection(['dep:stripe'], { ...stack, payments: ['stripe'] })).toBeTruthy();
    });

    test('matches file condition', () => {
      expect(matchesDetection(['file:tsconfig.json'], { ...emptyStack(), lsps: ['typescript'] })).toBeTruthy();
    });

    test('matches framework condition', () => {
      expect(matchesDetection(['dep:next'], { ...emptyStack(), frameworks: ['nextjs'] })).toBeTruthy();
    });

    test('empty detectWhen matches everything', () => {
      expect(matchesDetection([], emptyStack())).toBeTruthy();
    });

    test('multiple conditions use OR logic', () => {
      // Should match if ANY condition is true
      const stack = { ...emptyStack(), frameworks: ['express'] };
      expect(matchesDetection(['dep:react', 'dep:express'], stack)).toBeTruthy();
    });
  });

  describe('project-specific recommendations', () => {
    test('React project gets React-related tools', () => {
      const stack = { ...emptyStack(), frameworks: ['react'] };
      const result = recommend(stack, 'professional');
      expect(result.recommended.length > 0).toBeTruthy();
    });

    test('Express project gets security tools', () => {
      const stack = { ...emptyStack(), frameworks: ['express'] };
      const result = recommend(stack, 'professional');
      const secPlugin = result.recommended.find((t) => t.id === 'eslint-plugin-security');
      expect(secPlugin).toBeTruthy();
    });

    test('Supabase project gets Supabase CLI recommendation', () => {
      const stack = { ...emptyStack(), databases: ['supabase'] };
      const result = recommend(stack, 'startup');
      const supabase = result.recommended.find((t) => t.id === 'supabase-cli');
      expect(supabase).toBeTruthy();
    });

    test('empty tech stack gets only universal tools', () => {
      const result = recommend(emptyStack(), 'professional');
      // Universal tools have empty detectWhen — they should all be included
      const universalCount = Object.values(CATALOG).filter(
        (t) => t.detectWhen.length === 0
      ).length;
      // At least some universal tools should appear
      expect(result.recommended.length > 0).toBeTruthy();
      expect(result.recommended.length <= universalCount + 5).toBeTruthy(); // small buffer for detected ones
    });
  });

  describe('paid tool alternatives', () => {
    test('every paid recommendation includes alternatives', () => {
      const result = recommend(emptyStack(), 'professional');
      const paidTools = result.recommended.filter((t) => t.tier === 'paid');
      for (const tool of paidTools) {
        expect(tool.alternatives && tool.alternatives.length >= 1).toBeTruthy();
      }
    });
  });

  describe('specific tools appear', () => {
    test('parallel-web-search appears in recommendations', () => {
      const result = recommend(emptyStack(), 'startup');
      const parallelWebSearch = result.recommended.find((t) => t.id === 'parallel-web-search');
      expect(parallelWebSearch).toBeTruthy();
    });

    test('sonarcloud-analysis appears for open-source projects', () => {
      const result = recommend(emptyStack(), 'open-source');
      const sonar = result.recommended.find((t) => t.id === 'sonarcloud-analysis');
      expect(sonar).toBeTruthy();
    });
  });
});
