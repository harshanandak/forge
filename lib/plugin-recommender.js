/**
 * Plugin Recommender
 *
 * Filters and sorts tools from the catalog based on tech stack detection
 * and budget mode. Pure logic — no I/O, no side effects.
 */

const { CATALOG, BUDGET_MODES, STAGES } = require('./plugin-catalog');

const STAGE_ORDER = Object.values(STAGES);

// Dependency-to-detection-field mapping for matchesDetection
const DEP_FIELD_MAP = {
  // Frameworks
  next: 'frameworks:nextjs', react: 'frameworks:react', vue: 'frameworks:vue',
  '@angular/core': 'frameworks:angular', express: 'frameworks:express',
  fastify: 'frameworks:fastify', '@nestjs/core': 'frameworks:nestjs',
  // Databases
  '@supabase/supabase-js': 'databases:supabase', '@prisma/client': 'databases:prisma',
  // Payments
  stripe: 'payments:stripe',
  // Testing
  vitest: 'testing:vitest', jest: 'testing:jest', '@playwright/test': 'testing:playwright',
  // Auth
  '@clerk/nextjs': 'auth:clerk',
  // Misc
  typescript: 'languages:typescript', eslint: 'linting:eslint',
};

// File-to-detection-field mapping
const FILE_FIELD_MAP = {
  'tsconfig.json': 'lsps:typescript',
  'biome.json': 'linting:biome',
  '.prettierrc': 'linting:prettier',
  'eslint.config.js': 'linting:eslint',
  'vitest.config.ts': 'testing:vitest',
  'jest.config.js': 'testing:jest',
  'sonar-project.properties': 'linting:sonar',
  'package.json': null, // universal, always matches
};

/**
 * Check if detection conditions match the tech stack.
 * Empty conditions = universal (always matches).
 * Multiple conditions use OR logic.
 */
function matchesDetection(conditions, techStack) {
  if (!conditions || conditions.length === 0) return true;

  return conditions.some((condition) => {
    const [type, value] = condition.split(':');
    if (type === 'dep') {
      // Check if the dependency maps to a detected field
      const mapping = DEP_FIELD_MAP[value];
      if (mapping) {
        const [field, name] = mapping.split(':');
        return techStack[field]?.includes(name);
      }
      // Fallback: check all array fields for the value
      return Object.values(techStack).some(
        (arr) => Array.isArray(arr) && arr.includes(value)
      );
    }
    if (type === 'file') {
      const mapping = FILE_FIELD_MAP[value];
      if (mapping === null) return true; // package.json always matches
      if (mapping) {
        const [field, name] = mapping.split(':');
        return techStack[field]?.includes(name);
      }
      return false;
    }
    if (type === 'framework') {
      return techStack.frameworks?.includes(value);
    }
    return false;
  });
}

/**
 * Recommend tools based on tech stack and budget.
 * @param {Object} techStack - Output from detectTechStack()
 * @param {string} budgetMode - Budget mode key
 * @param {Object} [options] - Additional options
 * @param {string[]} [options.customTiers] - Tiers to include for 'custom' mode
 * @returns {{ recommended: Object[], skipped: Object[] }}
 */
function recommend(techStack, budgetMode, options = {}) {
  const mode = BUDGET_MODES[budgetMode];
  if (!mode) {
    throw new Error(`Invalid budget mode: '${budgetMode}'. Valid modes: ${Object.keys(BUDGET_MODES).join(', ')}`);
  }

  const allowedTiers = budgetMode === 'custom'
    ? (options.customTiers || [])
    : mode.includes;

  const recommended = [];
  const skipped = [];

  for (const [id, tool] of Object.entries(CATALOG)) {
    // Check detection match
    if (!matchesDetection(tool.detectWhen, techStack)) {
      continue; // Not relevant to this project
    }

    // Check tier
    if (!allowedTiers.includes(tool.tier)) {
      skipped.push({
        id,
        ...tool,
        reason: `Tier '${tool.tier}' not included in '${budgetMode}' budget`,
      });
      continue;
    }

    // CLI-first: skip unjustified MCPs
    if (tool.type === 'mcp' && !tool.mcpJustified) {
      skipped.push({
        id,
        ...tool,
        reason: 'MCP not justified — prefer CLI alternative',
      });
      continue;
    }

    recommended.push({ id, ...tool });
  }

  // Sort: free first, then by stage order
  recommended.sort((a, b) => {
    const aFree = a.tier === 'free' ? 0 : 1;
    const bFree = b.tier === 'free' ? 0 : 1;
    if (aFree !== bFree) return aFree - bFree;
    return STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage);
  });

  return { recommended, skipped };
}

module.exports = { recommend, matchesDetection };
