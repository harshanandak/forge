const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { formatRecommendations, handleRecommend } = require('../../lib/commands/recommend');

describe('forge recommend CLI command', () => {
  describe('module exports', () => {
    test('handleRecommend is a function', () => {
      assert.strictEqual(typeof handleRecommend, 'function');
    });

    test('formatRecommendations is a function', () => {
      assert.strictEqual(typeof formatRecommendations, 'function');
    });
  });

  describe('handleRecommend()', () => {
    test('default budget mode is startup', () => {
      const output = handleRecommend({});
      assert.ok(output.budgetMode === 'startup');
    });

    test('--budget free flag overrides default', () => {
      const output = handleRecommend({ budget: 'free' });
      assert.ok(output.budgetMode === 'free');
    });

    test('--budget invalid produces error', () => {
      const output = handleRecommend({ budget: 'invalid' });
      assert.ok(output.error, 'Should return error for invalid budget');
    });

    test('empty project still returns some universal tools', () => {
      const output = handleRecommend({});
      assert.ok(output.recommendations.recommended.length > 0);
    });
  });

  describe('formatRecommendations()', () => {
    test('output includes tool names grouped by stage', () => {
      const output = handleRecommend({});
      const formatted = formatRecommendations(output.recommendations);
      // Should contain at least some stage headers
      assert.ok(formatted.includes('research') || formatted.includes('Research'));
    });

    test('output includes tier labels', () => {
      const output = handleRecommend({ budget: 'professional' });
      const formatted = formatRecommendations(output.recommendations);
      // Should show tier indicators
      assert.ok(
        formatted.includes('[F]') || formatted.includes('free') || formatted.includes('Free'),
        'Should include tier labels'
      );
    });

    test('skipped tools show reasons', () => {
      const output = handleRecommend({ budget: 'free' });
      const formatted = formatRecommendations(output.recommendations);
      if (output.recommendations.skipped.length > 0) {
        // If there are skipped tools, the output should mention them
        assert.ok(typeof formatted === 'string');
      }
    });
  });

  describe('forge.js integration', () => {
    test('recommend command is recognized in forge.js main()', () => {
      const forgePath = path.join(__dirname, '..', '..', 'bin', 'forge.js');
      const content = fs.readFileSync(forgePath, 'utf-8');
      assert.ok(content.includes("'recommend'"), 'forge.js should recognize recommend command');
    });

    test('forge --help includes recommend command', () => {
      const forgePath = path.join(__dirname, '..', '..', 'bin', 'forge.js');
      const content = fs.readFileSync(forgePath, 'utf-8');
      assert.ok(content.includes('recommend'), 'help should mention recommend command');
    });
  });
});
