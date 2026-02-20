/**
 * Recommend Command
 *
 * Displays tool recommendations based on detected tech stack and budget mode.
 * Read-only — no installations, no side effects.
 */

const { recommend } = require('../plugin-recommender');
const { detectTechStack } = require('../project-discovery');
const { BUDGET_MODES, STAGES } = require('../plugin-catalog');

const TIER_LABELS = {
  free: '[F]',
  'free-public': '[FP]',
  'free-limited': '[FL]',
  paid: '[P]',
};

const STAGE_NAMES = {
  research: 'Research',
  plan: 'Plan',
  dev: 'Dev',
  check: 'Check',
  ship: 'Ship',
  review: 'Review',
  merge: 'Merge',
};

/**
 * Format recommendations into displayable text.
 * @param {{ recommended: Object[], skipped: Object[] }} recommendations
 * @returns {string}
 */
function formatRecommendations(recommendations) {
  const { recommended, skipped } = recommendations;
  const lines = [];

  if (recommended.length === 0) {
    lines.push('No tools recommended for current configuration.');
    return lines.join('\n');
  }

  // Group by stage
  const byStage = {};
  for (const stage of Object.values(STAGES)) {
    byStage[stage] = recommended.filter((t) => t.stage === stage);
  }

  for (const [stage, tools] of Object.entries(byStage)) {
    if (tools.length === 0) continue;
    lines.push('');
    lines.push(`  ${STAGE_NAMES[stage] || stage}`);
    lines.push(`  ${'─'.repeat(40)}`);
    for (const tool of tools) {
      const tier = TIER_LABELS[tool.tier] || `[${tool.tier}]`;
      lines.push(`  ${tier.padEnd(5)} ${tool.name.padEnd(25)} ${tool.install.cmd}`);
      if (tool.alternatives && tool.alternatives.length > 0) {
        const altNames = tool.alternatives.map((a) => `${a.tool} (${a.tier})`).join(', ');
        lines.push(`        Free alternatives: ${altNames}`);
      }
    }
  }

  if (skipped.length > 0) {
    lines.push('');
    lines.push(`  Skipped (${skipped.length} tools not matching budget):`);
    for (const tool of skipped.slice(0, 5)) {
      lines.push(`    ${tool.name}: ${tool.reason}`);
    }
    if (skipped.length > 5) {
      lines.push(`    ... and ${skipped.length - 5} more`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Handle the recommend command.
 * @param {Object} flags - Parsed CLI flags
 * @param {string} [projectPath] - Project path (defaults to cwd)
 * @returns {{ budgetMode: string, recommendations: Object, error?: string }}
 */
function handleRecommend(flags, projectPath) {
  const budgetMode = flags.budget || 'startup';

  // Validate budget mode
  if (!BUDGET_MODES[budgetMode]) {
    return {
      budgetMode,
      recommendations: { recommended: [], skipped: [] },
      error: `Invalid budget mode: '${budgetMode}'. Valid: ${Object.keys(BUDGET_MODES).join(', ')}`,
    };
  }

  const techStack = detectTechStack(projectPath || process.cwd());
  const recommendations = recommend(techStack, budgetMode);

  return { budgetMode, recommendations };
}

module.exports = { formatRecommendations, handleRecommend };
