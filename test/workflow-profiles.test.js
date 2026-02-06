const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// Module under test
const {
  getUserType,
  getInternalProfile,
  detectWorkType,
  containsCriticalKeywords,
  containsHotfixKeywords,
  PROFILES
} = require('../lib/workflow-profiles');

describe('workflow-profiles', () => {
  describe('PROFILES definition', () => {
    test('should have all 6 internal profiles defined', () => {
      assert.ok(PROFILES.critical, 'Critical profile missing');
      assert.ok(PROFILES.standard, 'Standard profile missing');
      assert.ok(PROFILES.simple, 'Simple profile missing');
      assert.ok(PROFILES.hotfix, 'Hotfix profile missing');
      assert.ok(PROFILES.docs, 'Docs profile missing');
      assert.ok(PROFILES.refactor, 'Refactor profile missing');
    });

    test('critical profile should have 9 stages', () => {
      assert.strictEqual(PROFILES.critical.stages.length, 9);
      assert.ok(PROFILES.critical.stages.includes('/status'));
      assert.ok(PROFILES.critical.stages.includes('/research'));
      assert.ok(PROFILES.critical.stages.includes('/verify'));
      assert.strictEqual(PROFILES.critical.tdd, 'strict');
    });

    test('standard profile should have 6 stages', () => {
      assert.strictEqual(PROFILES.standard.stages.length, 6);
      assert.ok(PROFILES.standard.stages.includes('/status'));
      assert.ok(PROFILES.standard.stages.includes('/plan'));
      assert.ok(!PROFILES.standard.stages.includes('/research'));
      assert.strictEqual(PROFILES.standard.tdd, 'required');
    });

    test('simple profile should have 4 stages', () => {
      assert.strictEqual(PROFILES.simple.stages.length, 4);
      assert.ok(PROFILES.simple.stages.includes('/dev'));
      assert.ok(!PROFILES.simple.stages.includes('/research'));
      assert.strictEqual(PROFILES.simple.tdd, 'recommended');
    });

    test('hotfix profile should have 3 stages', () => {
      assert.strictEqual(PROFILES.hotfix.stages.length, 3);
      assert.ok(PROFILES.hotfix.stages.includes('/dev'));
      assert.ok(PROFILES.hotfix.stages.includes('/check'));
      assert.strictEqual(PROFILES.hotfix.tdd, 'required');
    });

    test('docs profile should have 3 stages', () => {
      assert.strictEqual(PROFILES.docs.stages.length, 3);
      assert.ok(PROFILES.docs.stages.includes('/verify'));
      assert.strictEqual(PROFILES.docs.tdd, 'no');
    });

    test('refactor profile should have 5 stages', () => {
      assert.strictEqual(PROFILES.refactor.stages.length, 5);
      assert.ok(PROFILES.refactor.stages.includes('/plan'));
      assert.strictEqual(PROFILES.refactor.tdd, 'strict');
    });
  });

  describe('containsCriticalKeywords', () => {
    test('should detect auth keyword', () => {
      assert.strictEqual(containsCriticalKeywords('feat/add-auth-system'), true);
    });

    test('should detect security keyword', () => {
      assert.strictEqual(containsCriticalKeywords('implement security middleware'), true);
    });

    test('should detect payment keyword', () => {
      assert.strictEqual(containsCriticalKeywords('feat/payment-integration'), true);
    });

    test('should detect crypto keyword', () => {
      assert.strictEqual(containsCriticalKeywords('fix crypto validation'), true);
    });

    test('should detect token keyword', () => {
      assert.strictEqual(containsCriticalKeywords('feat/token-refresh'), true);
    });

    test('should detect session keyword', () => {
      assert.strictEqual(containsCriticalKeywords('session management update'), true);
    });

    test('should detect migration keyword', () => {
      assert.strictEqual(containsCriticalKeywords('data migration script'), true);
    });

    test('should detect breaking keyword', () => {
      assert.strictEqual(containsCriticalKeywords('breaking change to API'), true);
    });

    test('should return false for non-critical keywords', () => {
      assert.strictEqual(containsCriticalKeywords('feat/add-ui-button'), false);
    });

    test('should be case-insensitive', () => {
      assert.strictEqual(containsCriticalKeywords('FEAT/ADD-AUTH'), true);
    });
  });

  describe('containsHotfixKeywords', () => {
    test('should detect urgent keyword', () => {
      assert.strictEqual(containsHotfixKeywords('urgent fix needed'), true);
    });

    test('should detect production keyword', () => {
      assert.strictEqual(containsHotfixKeywords('production bug'), true);
    });

    test('should detect emergency keyword', () => {
      assert.strictEqual(containsHotfixKeywords('emergency patch'), true);
    });

    test('should detect hotfix keyword', () => {
      assert.strictEqual(containsHotfixKeywords('hotfix/login-crash'), true);
    });

    test('should detect critical keyword', () => {
      assert.strictEqual(containsHotfixKeywords('critical bug fix'), true);
    });

    test('should return false for non-hotfix keywords', () => {
      assert.strictEqual(containsHotfixKeywords('fix/minor-typo'), false);
    });

    test('should be case-insensitive', () => {
      assert.strictEqual(containsHotfixKeywords('URGENT FIX'), true);
    });
  });

  describe('getUserType', () => {
    test('should detect feature from feat/ branch', () => {
      const context = { branch: 'feat/add-dashboard' };
      assert.strictEqual(getUserType(context), 'feature');
    });

    test('should detect fix from fix/ branch', () => {
      const context = { branch: 'fix/login-bug' };
      assert.strictEqual(getUserType(context), 'fix');
    });

    test('should detect refactor from refactor/ branch', () => {
      const context = { branch: 'refactor/extract-service' };
      assert.strictEqual(getUserType(context), 'refactor');
    });

    test('should detect chore from docs/ branch', () => {
      const context = { branch: 'docs/update-readme' };
      assert.strictEqual(getUserType(context), 'chore');
    });

    test('should detect chore from chore/ branch', () => {
      const context = { branch: 'chore/bump-deps' };
      assert.strictEqual(getUserType(context), 'chore');
    });

    test('should default to feature for unknown branch', () => {
      const context = { branch: 'main' };
      assert.strictEqual(getUserType(context), 'feature');
    });

    test('should default to feature for missing branch', () => {
      const context = {};
      assert.strictEqual(getUserType(context), 'feature');
    });

    test('should handle hotfix/ branch as fix', () => {
      const context = { branch: 'hotfix/production-crash' };
      assert.strictEqual(getUserType(context), 'fix');
    });
  });

  describe('getInternalProfile', () => {
    test('should map feature to critical with auth keyword', () => {
      const context = { keywords: ['auth', 'system'], files: [] };
      assert.strictEqual(getInternalProfile('feature', context), 'critical');
    });

    test('should map feature to critical with security keyword', () => {
      const context = { keywords: ['security', 'middleware'], files: [] };
      assert.strictEqual(getInternalProfile('feature', context), 'critical');
    });

    test('should map feature to critical with payment keyword', () => {
      const context = { keywords: ['payment', 'integration'], files: [] };
      assert.strictEqual(getInternalProfile('feature', context), 'critical');
    });

    test('should map feature to standard without keywords', () => {
      const context = { keywords: ['dashboard', 'ui'], files: [] };
      assert.strictEqual(getInternalProfile('feature', context), 'standard');
    });

    test('should map fix to hotfix with urgent keyword', () => {
      const context = { keywords: ['urgent', 'fix'], files: [] };
      assert.strictEqual(getInternalProfile('fix', context), 'hotfix');
    });

    test('should map fix to hotfix with production keyword', () => {
      const context = { keywords: ['production', 'bug'], files: [] };
      assert.strictEqual(getInternalProfile('fix', context), 'hotfix');
    });

    test('should map fix to simple without keywords', () => {
      const context = { keywords: ['typo', 'minor'], files: [] };
      assert.strictEqual(getInternalProfile('fix', context), 'simple');
    });

    test('should map refactor to refactor (1:1)', () => {
      const context = { keywords: [], files: [] };
      assert.strictEqual(getInternalProfile('refactor', context), 'refactor');
    });

    test('should map chore to docs for markdown files only', () => {
      const context = { keywords: [], files: ['README.md', 'DOCS.md'] };
      assert.strictEqual(getInternalProfile('chore', context), 'docs');
    });

    test('should map chore to simple for code files', () => {
      const context = { keywords: [], files: ['package.json', 'src/config.js'] };
      assert.strictEqual(getInternalProfile('chore', context), 'simple');
    });

    test('should map chore to simple for mixed files', () => {
      const context = { keywords: [], files: ['README.md', 'src/utils.js'] };
      assert.strictEqual(getInternalProfile('chore', context), 'simple');
    });
  });

  describe('detectWorkType', () => {
    test('should use manual profile override', () => {
      const context = {
        manualProfile: 'critical',
        branch: 'fix/minor-bug'
      };
      const result = detectWorkType(context);
      assert.strictEqual(result.profile, 'critical');
      assert.strictEqual(result.source, 'manual');
    });

    test('should detect feature → standard (no keywords)', () => {
      const context = {
        branch: 'feat/add-dashboard',
        keywords: ['dashboard', 'ui'],
        files: []
      };
      const result = detectWorkType(context);
      assert.strictEqual(result.userType, 'feature');
      assert.strictEqual(result.profile, 'standard');
      assert.strictEqual(result.source, 'auto');
    });

    test('should detect feature → critical (auth keyword)', () => {
      const context = {
        branch: 'feat/user-authentication',
        keywords: ['user', 'authentication', 'system'],
        files: []
      };
      const result = detectWorkType(context);
      assert.strictEqual(result.userType, 'feature');
      assert.strictEqual(result.profile, 'critical');
      assert.strictEqual(result.source, 'auto');
    });

    test('should detect fix → simple (no urgency)', () => {
      const context = {
        branch: 'fix/typo-correction',
        keywords: ['typo', 'correction'],
        files: []
      };
      const result = detectWorkType(context);
      assert.strictEqual(result.userType, 'fix');
      assert.strictEqual(result.profile, 'simple');
      assert.strictEqual(result.source, 'auto');
    });

    test('should detect fix → hotfix (production keyword)', () => {
      const context = {
        branch: 'hotfix/production-crash',
        keywords: ['production', 'crash', 'urgent'],
        files: []
      };
      const result = detectWorkType(context);
      assert.strictEqual(result.userType, 'fix');
      assert.strictEqual(result.profile, 'hotfix');
      assert.strictEqual(result.source, 'auto');
    });

    test('should detect refactor → refactor', () => {
      const context = {
        branch: 'refactor/extract-payment-service',
        keywords: ['extract', 'service'],
        files: []
      };
      const result = detectWorkType(context);
      assert.strictEqual(result.userType, 'refactor');
      assert.strictEqual(result.profile, 'refactor');
      assert.strictEqual(result.source, 'auto');
    });

    test('should detect chore → docs (markdown only)', () => {
      const context = {
        branch: 'docs/update-readme',
        keywords: [],
        files: ['README.md', 'CONTRIBUTING.md']
      };
      const result = detectWorkType(context);
      assert.strictEqual(result.userType, 'chore');
      assert.strictEqual(result.profile, 'docs');
      assert.strictEqual(result.source, 'auto');
    });

    test('should default to feature → standard for unknown branch', () => {
      const context = {
        branch: 'main',
        keywords: [],
        files: []
      };
      const result = detectWorkType(context);
      assert.strictEqual(result.userType, 'feature');
      assert.strictEqual(result.profile, 'standard');
      assert.strictEqual(result.source, 'auto');
    });
  });

  describe('edge cases', () => {
    test('should handle empty context object', () => {
      const context = {};
      const result = detectWorkType(context);
      assert.ok(result.profile);
      assert.strictEqual(result.userType, 'feature');
    });

    test('should handle null keywords', () => {
      const context = {
        branch: 'feat/add-feature',
        keywords: null,
        files: []
      };
      const result = detectWorkType(context);
      assert.ok(result.profile);
    });

    test('should handle undefined files', () => {
      const context = {
        branch: 'chore/update',
        keywords: []
      };
      const result = detectWorkType(context);
      assert.ok(result.profile);
    });

    test('should handle ambiguous branch feat/fix-bug', () => {
      const context = {
        branch: 'feat/fix-bug',
        keywords: ['bug'],
        files: []
      };
      const result = detectWorkType(context);
      assert.strictEqual(result.userType, 'feature');
    });

    test('should handle multiple critical keywords', () => {
      const context = {
        branch: 'feat/auth-payment-system',
        keywords: ['auth', 'payment', 'security'],
        files: []
      };
      const result = detectWorkType(context);
      assert.strictEqual(result.profile, 'critical');
    });
  });
});
