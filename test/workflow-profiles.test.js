const { describe, test, expect } = require('bun:test');

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
      expect(PROFILES.critical).toBeTruthy();
      expect(PROFILES.standard).toBeTruthy();
      expect(PROFILES.simple).toBeTruthy();
      expect(PROFILES.hotfix).toBeTruthy();
      expect(PROFILES.docs).toBeTruthy();
      expect(PROFILES.refactor).toBeTruthy();
    });

    test('critical profile should have 9 stages', () => {
      expect(PROFILES.critical.stages.length).toBe(9);
      expect(PROFILES.critical.stages.includes('/status')).toBeTruthy();
      expect(PROFILES.critical.stages.includes('/research')).toBeTruthy();
      expect(PROFILES.critical.stages.includes('/verify')).toBeTruthy();
      expect(PROFILES.critical.tdd).toBe('strict');
    });

    test('standard profile should have 6 stages', () => {
      expect(PROFILES.standard.stages.length).toBe(6);
      expect(PROFILES.standard.stages.includes('/status')).toBeTruthy();
      expect(PROFILES.standard.stages.includes('/plan')).toBeTruthy();
      expect(!PROFILES.standard.stages.includes('/research')).toBeTruthy();
      expect(PROFILES.standard.tdd).toBe('required');
    });

    test('simple profile should have 4 stages', () => {
      expect(PROFILES.simple.stages.length).toBe(4);
      expect(PROFILES.simple.stages.includes('/dev')).toBeTruthy();
      expect(!PROFILES.simple.stages.includes('/research')).toBeTruthy();
      expect(PROFILES.simple.tdd).toBe('recommended');
    });

    test('hotfix profile should have 3 stages', () => {
      expect(PROFILES.hotfix.stages.length).toBe(3);
      expect(PROFILES.hotfix.stages.includes('/dev')).toBeTruthy();
      expect(PROFILES.hotfix.stages.includes('/check')).toBeTruthy();
      expect(PROFILES.hotfix.tdd).toBe('required');
    });

    test('docs profile should have 3 stages', () => {
      expect(PROFILES.docs.stages.length).toBe(3);
      expect(PROFILES.docs.stages.includes('/verify')).toBeTruthy();
      expect(PROFILES.docs.tdd).toBe('no');
    });

    test('refactor profile should have 5 stages', () => {
      expect(PROFILES.refactor.stages.length).toBe(5);
      expect(PROFILES.refactor.stages.includes('/plan')).toBeTruthy();
      expect(PROFILES.refactor.tdd).toBe('strict');
    });
  });

  describe('containsCriticalKeywords', () => {
    test('should detect auth keyword', () => {
      expect(containsCriticalKeywords('feat/add-auth-system')).toBe(true);
    });

    test('should detect security keyword', () => {
      expect(containsCriticalKeywords('implement security middleware')).toBe(true);
    });

    test('should detect payment keyword', () => {
      expect(containsCriticalKeywords('feat/payment-integration')).toBe(true);
    });

    test('should detect crypto keyword', () => {
      expect(containsCriticalKeywords('fix crypto validation')).toBe(true);
    });

    test('should detect token keyword', () => {
      expect(containsCriticalKeywords('feat/token-refresh')).toBe(true);
    });

    test('should detect session keyword', () => {
      expect(containsCriticalKeywords('session management update')).toBe(true);
    });

    test('should detect migration keyword', () => {
      expect(containsCriticalKeywords('data migration script')).toBe(true);
    });

    test('should detect breaking keyword', () => {
      expect(containsCriticalKeywords('breaking change to API')).toBe(true);
    });

    test('should return false for non-critical keywords', () => {
      expect(containsCriticalKeywords('feat/add-ui-button')).toBe(false);
    });

    test('should be case-insensitive', () => {
      expect(containsCriticalKeywords('FEAT/ADD-AUTH')).toBe(true);
    });
  });

  describe('containsHotfixKeywords', () => {
    test('should detect urgent keyword', () => {
      expect(containsHotfixKeywords('urgent fix needed')).toBe(true);
    });

    test('should detect production keyword', () => {
      expect(containsHotfixKeywords('production bug')).toBe(true);
    });

    test('should detect emergency keyword', () => {
      expect(containsHotfixKeywords('emergency patch')).toBe(true);
    });

    test('should detect hotfix keyword', () => {
      expect(containsHotfixKeywords('hotfix/login-crash')).toBe(true);
    });

    test('should detect critical keyword', () => {
      expect(containsHotfixKeywords('critical bug fix')).toBe(true);
    });

    test('should return false for non-hotfix keywords', () => {
      expect(containsHotfixKeywords('fix/minor-typo')).toBe(false);
    });

    test('should be case-insensitive', () => {
      expect(containsHotfixKeywords('URGENT FIX')).toBe(true);
    });
  });

  describe('getUserType', () => {
    test('should detect feature from feat/ branch', () => {
      const context = { branch: 'feat/add-dashboard' };
      expect(getUserType(context)).toBe('feature');
    });

    test('should detect fix from fix/ branch', () => {
      const context = { branch: 'fix/login-bug' };
      expect(getUserType(context)).toBe('fix');
    });

    test('should detect refactor from refactor/ branch', () => {
      const context = { branch: 'refactor/extract-service' };
      expect(getUserType(context)).toBe('refactor');
    });

    test('should detect chore from docs/ branch', () => {
      const context = { branch: 'docs/update-readme' };
      expect(getUserType(context)).toBe('chore');
    });

    test('should detect chore from chore/ branch', () => {
      const context = { branch: 'chore/bump-deps' };
      expect(getUserType(context)).toBe('chore');
    });

    test('should default to feature for unknown branch', () => {
      const context = { branch: 'main' };
      expect(getUserType(context)).toBe('feature');
    });

    test('should default to feature for missing branch', () => {
      const context = {};
      expect(getUserType(context)).toBe('feature');
    });

    test('should handle hotfix/ branch as fix', () => {
      const context = { branch: 'hotfix/production-crash' };
      expect(getUserType(context)).toBe('fix');
    });
  });

  describe('getInternalProfile', () => {
    test('should map feature to critical with auth keyword', () => {
      const context = { keywords: ['auth', 'system'], files: [] };
      expect(getInternalProfile('feature', context)).toBe('critical');
    });

    test('should map feature to critical with security keyword', () => {
      const context = { keywords: ['security', 'middleware'], files: [] };
      expect(getInternalProfile('feature', context)).toBe('critical');
    });

    test('should map feature to critical with payment keyword', () => {
      const context = { keywords: ['payment', 'integration'], files: [] };
      expect(getInternalProfile('feature', context)).toBe('critical');
    });

    test('should map feature to standard without keywords', () => {
      const context = { keywords: ['dashboard', 'ui'], files: [] };
      expect(getInternalProfile('feature', context)).toBe('standard');
    });

    test('should map fix to hotfix with urgent keyword', () => {
      const context = { keywords: ['urgent', 'fix'], files: [] };
      expect(getInternalProfile('fix', context)).toBe('hotfix');
    });

    test('should map fix to hotfix with production keyword', () => {
      const context = { keywords: ['production', 'bug'], files: [] };
      expect(getInternalProfile('fix', context)).toBe('hotfix');
    });

    test('should map fix to simple without keywords', () => {
      const context = { keywords: ['typo', 'minor'], files: [] };
      expect(getInternalProfile('fix', context)).toBe('simple');
    });

    test('should map refactor to refactor (1:1)', () => {
      const context = { keywords: [], files: [] };
      expect(getInternalProfile('refactor', context)).toBe('refactor');
    });

    test('should map chore to docs for markdown files only', () => {
      const context = { keywords: [], files: ['README.md', 'DOCS.md'] };
      expect(getInternalProfile('chore', context)).toBe('docs');
    });

    test('should map chore to simple for code files', () => {
      const context = { keywords: [], files: ['package.json', 'src/config.js'] };
      expect(getInternalProfile('chore', context)).toBe('simple');
    });

    test('should map chore to simple for mixed files', () => {
      const context = { keywords: [], files: ['README.md', 'src/utils.js'] };
      expect(getInternalProfile('chore', context)).toBe('simple');
    });
  });

  describe('detectWorkType', () => {
    test('should use manual profile override', () => {
      const context = {
        manualProfile: 'critical',
        branch: 'fix/minor-bug'
      };
      const result = detectWorkType(context);
      expect(result.profile).toBe('critical');
      expect(result.source).toBe('manual');
    });

    test('should detect feature → standard (no keywords)', () => {
      const context = {
        branch: 'feat/add-dashboard',
        keywords: ['dashboard', 'ui'],
        files: []
      };
      const result = detectWorkType(context);
      expect(result.userType).toBe('feature');
      expect(result.profile).toBe('standard');
      expect(result.source).toBe('auto');
    });

    test('should detect feature → critical (auth keyword)', () => {
      const context = {
        branch: 'feat/user-authentication',
        keywords: ['user', 'authentication', 'system'],
        files: []
      };
      const result = detectWorkType(context);
      expect(result.userType).toBe('feature');
      expect(result.profile).toBe('critical');
      expect(result.source).toBe('auto');
    });

    test('should detect fix → simple (no urgency)', () => {
      const context = {
        branch: 'fix/typo-correction',
        keywords: ['typo', 'correction'],
        files: []
      };
      const result = detectWorkType(context);
      expect(result.userType).toBe('fix');
      expect(result.profile).toBe('simple');
      expect(result.source).toBe('auto');
    });

    test('should detect fix → hotfix (production keyword)', () => {
      const context = {
        branch: 'hotfix/production-crash',
        keywords: ['production', 'crash', 'urgent'],
        files: []
      };
      const result = detectWorkType(context);
      expect(result.userType).toBe('fix');
      expect(result.profile).toBe('hotfix');
      expect(result.source).toBe('auto');
    });

    test('should detect refactor → refactor', () => {
      const context = {
        branch: 'refactor/extract-payment-service',
        keywords: ['extract', 'service'],
        files: []
      };
      const result = detectWorkType(context);
      expect(result.userType).toBe('refactor');
      expect(result.profile).toBe('refactor');
      expect(result.source).toBe('auto');
    });

    test('should detect chore → docs (markdown only)', () => {
      const context = {
        branch: 'docs/update-readme',
        keywords: [],
        files: ['README.md', 'CONTRIBUTING.md']
      };
      const result = detectWorkType(context);
      expect(result.userType).toBe('chore');
      expect(result.profile).toBe('docs');
      expect(result.source).toBe('auto');
    });

    test('should default to feature → standard for unknown branch', () => {
      const context = {
        branch: 'main',
        keywords: [],
        files: []
      };
      const result = detectWorkType(context);
      expect(result.userType).toBe('feature');
      expect(result.profile).toBe('standard');
      expect(result.source).toBe('auto');
    });
  });

  describe('edge cases', () => {
    test('should handle empty context object', () => {
      const context = {};
      const result = detectWorkType(context);
      expect(result.profile).toBeTruthy();
      expect(result.userType).toBe('feature');
    });

    test('should handle null keywords', () => {
      const context = {
        branch: 'feat/add-feature',
        keywords: null,
        files: []
      };
      const result = detectWorkType(context);
      expect(result.profile).toBeTruthy();
    });

    test('should handle undefined files', () => {
      const context = {
        branch: 'chore/update',
        keywords: []
      };
      const result = detectWorkType(context);
      expect(result.profile).toBeTruthy();
    });

    test('should handle ambiguous branch feat/fix-bug', () => {
      const context = {
        branch: 'feat/fix-bug',
        keywords: ['bug'],
        files: []
      };
      const result = detectWorkType(context);
      expect(result.userType).toBe('feature');
    });

    test('should handle multiple critical keywords', () => {
      const context = {
        branch: 'feat/auth-payment-system',
        keywords: ['auth', 'payment', 'security'],
        files: []
      };
      const result = detectWorkType(context);
      expect(result.profile).toBe('critical');
    });
  });
});
