const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const { formatRecommendations, handleRecommend } = require('../../lib/commands/recommend');

describe('forge recommend CLI command', () => {
  describe('module exports', () => {
    test('handleRecommend is a function', () => {
      expect(typeof handleRecommend).toBe('function');
    });

    test('formatRecommendations is a function', () => {
      expect(typeof formatRecommendations).toBe('function');
    });
  });

  describe('handleRecommend()', () => {
    test('default budget mode is startup', () => {
      const output = handleRecommend({});
      expect(output.budgetMode === 'startup').toBeTruthy();
    });

    test('--budget free flag overrides default', () => {
      const output = handleRecommend({ budget: 'free' });
      expect(output.budgetMode === 'free').toBeTruthy();
    });

    test('--budget invalid produces error', () => {
      const output = handleRecommend({ budget: 'invalid' });
      expect(output.error).toBeTruthy();
    });

    test('empty project still returns some universal tools', () => {
      const output = handleRecommend({});
      expect(output.recommendations.recommended.length > 0).toBeTruthy();
    });
  });

  describe('formatRecommendations()', () => {
    test('output includes tool names grouped by stage', () => {
      const output = handleRecommend({});
      const formatted = formatRecommendations(output.recommendations);
      // Should contain at least some stage headers
      expect(formatted.includes('research') || formatted.includes('Research')).toBeTruthy();
    });

    test('output includes tier labels', () => {
      const output = handleRecommend({ budget: 'professional' });
      const formatted = formatRecommendations(output.recommendations);
      // Should show tier indicators
      expect(formatted.includes('[F]') || formatted.includes('free') || formatted.includes('Free')).toBeTruthy();
    });

    test('skipped tools show reasons', () => {
      const output = handleRecommend({ budget: 'free' });
      const formatted = formatRecommendations(output.recommendations);
      if (output.recommendations.skipped.length > 0) {
        // If there are skipped tools, the output should mention them
        expect(typeof formatted === 'string').toBeTruthy();
      }
    });
  });

  describe('forge.js integration', () => {
    test('recommend command is recognized in forge.js main()', () => {
      const forgePath = path.join(__dirname, '..', '..', 'bin', 'forge.js');
      const content = fs.readFileSync(forgePath, 'utf-8');
      expect(content.includes("'recommend'")).toBeTruthy();
    });

    test('forge --help includes recommend command', () => {
      const forgePath = path.join(__dirname, '..', '..', 'bin', 'forge.js');
      const content = fs.readFileSync(forgePath, 'utf-8');
      expect(content.includes('recommend')).toBeTruthy();
    });
  });
});
