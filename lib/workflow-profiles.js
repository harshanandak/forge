/**
 * Workflow Profiles
 *
 * Implements hybrid approach: 4 user-facing types (Feature/Fix/Refactor/Chore)
 * map to 6 internal profiles (Critical/Standard/Simple/Hotfix/Docs/Refactor)
 * with keyword-based auto-escalation.
 */

/**
 * Internal workflow profiles aligned with AGENTS.md specification
 */
const PROFILES = {
  critical: {
    name: 'Critical (Maximum Rigor)',
    stages: ['/status', '/research', '/plan', '/dev', '/check', '/ship', '/review', '/merge', '/verify'],
    tdd: 'strict',
    research: 'required',
    openspec: 'required-strategic',
    description: 'Security, auth, payments, data integrity, breaking changes',
    keywords: ['auth', 'security', 'payment', 'crypto', 'password', 'token', 'session', 'data-migration', 'breaking']
  },

  standard: {
    name: 'Standard (Full Workflow)',
    stages: ['/status', '/plan', '/dev', '/check', '/ship', '/merge'],
    tdd: 'required',
    research: 'optional',
    openspec: 'strategic',
    description: 'Most features and non-critical enhancements'
  },

  simple: {
    name: 'Simple (Streamlined)',
    stages: ['/dev', '/check', '/ship', '/merge'],
    tdd: 'recommended',
    research: 'skip',
    openspec: 'no',
    description: 'UI tweaks, small improvements, minor fixes'
  },

  hotfix: {
    name: 'Hotfix (Emergency)',
    stages: ['/dev', '/check', '/ship'],
    tdd: 'required',  // Must reproduce bug
    research: 'skip',
    openspec: 'no',
    description: 'Production bugs, urgent fixes',
    keywords: ['urgent', 'production', 'emergency', 'hotfix', 'critical']
  },

  docs: {
    name: 'Docs (Documentation Only)',
    stages: ['/verify', '/ship', '/merge'],
    tdd: 'no',
    research: 'no',
    openspec: 'no',
    description: 'Documentation updates, README changes'
  },

  refactor: {
    name: 'Refactor (Behavior-Preserving)',
    stages: ['/plan', '/dev', '/check', '/ship', '/merge'],
    tdd: 'strict',  // Must preserve behavior
    research: 'optional',
    openspec: 'architectural',
    description: 'Code cleanup, optimization, behavior-preserving improvements'
  }
};

/**
 * Generic keyword detection helper (DRY utility)
 * @param {string} text - Text to analyze
 * @param {string[]} keywords - Keywords to search for
 * @returns {boolean} - True if any keyword found
 */
function containsKeywords(text, keywords) {
  if (!text || typeof text !== 'string') return false;
  const lowerText = text.toLowerCase();
  return keywords.some(keyword => lowerText.includes(keyword));
}

/**
 * Detects if text contains critical keywords (auth, security, payment, etc.)
 * @param {string} text - Text to analyze (branch name, commit message, etc.)
 * @returns {boolean} - True if critical keywords found
 */
function containsCriticalKeywords(text) {
  const keywords = ['auth', 'security', 'payment', 'crypto', 'password', 'token', 'session', 'migration', 'breaking'];
  return containsKeywords(text, keywords);
}

/**
 * Detects if text contains hotfix keywords (urgent, production, emergency, etc.)
 * @param {string} text - Text to analyze (branch name, commit message, etc.)
 * @returns {boolean} - True if hotfix keywords found
 */
function containsHotfixKeywords(text) {
  const keywords = ['urgent', 'production', 'emergency', 'hotfix', 'critical'];
  return containsKeywords(text, keywords);
}

/**
 * Detects user-facing work type from context (4 simple types)
 * @param {Object} context - Detection context
 * @param {string} context.branch - Git branch name
 * @returns {string} - User type: 'feature' | 'fix' | 'refactor' | 'chore'
 */
function getUserType(context) {
  const branch = context.branch || '';
  const branchLower = branch.toLowerCase();

  // Detect from branch prefix
  if (branchLower.startsWith('feat/')) return 'feature';
  if (branchLower.startsWith('fix/')) return 'fix';
  if (branchLower.startsWith('hotfix/')) return 'fix';
  if (branchLower.startsWith('refactor/')) return 'refactor';
  if (branchLower.startsWith('docs/')) return 'chore';
  if (branchLower.startsWith('chore/')) return 'chore';

  // Default: feature (safest - full workflow)
  return 'feature';
}

/**
 * Maps user type to internal profile with keyword-based escalation (6 granular profiles)
 * @param {string} userType - User-facing type: 'feature' | 'fix' | 'refactor' | 'chore'
 * @param {Object} context - Detection context
 * @param {string[]} context.keywords - Keywords from branch/commit
 * @param {string[]} context.files - Modified files
 * @returns {string} - Internal profile: 'critical' | 'standard' | 'simple' | 'hotfix' | 'docs' | 'refactor'
 */
function getInternalProfile(userType, context) {
  const keywords = context.keywords || [];
  const files = context.files || [];

  // Combine all keywords into a single string for analysis
  const keywordText = keywords.join(' ');

  switch (userType) {
    case 'feature':
      // Auto-escalate to Critical if security-sensitive
      return containsCriticalKeywords(keywordText) ? 'critical' : 'standard';

    case 'fix':
      // Auto-escalate to Hotfix if urgent/production
      return containsHotfixKeywords(keywordText) ? 'hotfix' : 'simple';

    case 'refactor':
      // 1:1 mapping
      return 'refactor';

    case 'chore':
      // Docs if only markdown files, otherwise Simple
      if (files.length > 0 && files.every(f => f.endsWith('.md'))) {
        return 'docs';
      }
      return 'simple';

    default:
      return 'standard';
  }
}

/**
 * Main detection function - detects work type and selects appropriate profile
 * @param {Object} context - Detection context
 * @param {string} context.manualProfile - Manual profile override (optional)
 * @param {string} context.branch - Git branch name
 * @param {string[]} context.keywords - Keywords from branch/commit
 * @param {string[]} context.files - Modified files
 * @returns {Object} - { userType, profile, source }
 */
function detectWorkType(context) {
  // Priority 1: Manual override (power users)
  if (context.manualProfile) {
    return {
      userType: null,
      profile: context.manualProfile,
      source: 'manual'
    };
  }

  // Priority 2: Detect simple user type (4 options)
  const userType = getUserType(context);

  // Priority 3: Auto-select granular internal profile (6 options)
  const profile = getInternalProfile(userType, context);

  return {
    userType,
    profile,
    source: 'auto'
  };
}

module.exports = {
  PROFILES,
  containsCriticalKeywords,
  containsHotfixKeywords,
  getUserType,
  getInternalProfile,
  detectWorkType
};
