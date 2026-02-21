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
 * Format the skipped tools section.
 * @param {Object[]} skipped
 * @returns {string[]}
 */
function formatSkippedSection(skipped) {
  if (skipped.length === 0) return [];
  const lines = [
    '',
    `  Skipped (${skipped.length} tools not matching budget):`,
    ...skipped.slice(0, 5).map((tool) => `    ${tool.name}: ${tool.reason}`),
  ];
  if (skipped.length > 5) {
    lines.push(`    ... and ${skipped.length - 5} more`);
  }
  return lines;
}

/**
 * Format recommendations into displayable text.
 * @param {{ recommended: Object[], skipped: Object[] }} recommendations
 * @returns {string}
 */
function formatRecommendations(recommendations) {
  const { recommended, skipped } = recommendations;

  if (recommended.length === 0) {
    return 'No tools recommended for current configuration.';
  }

  // Group by stage
  const byStage = {};
  for (const stage of Object.values(STAGES)) {
    byStage[stage] = recommended.filter((t) => t.stage === stage);
  }

  const lines = [];
  for (const [stage, tools] of Object.entries(byStage)) {
    if (tools.length === 0) continue;
    lines.push(
      '',
      `  ${STAGE_NAMES[stage] || stage}`,
      `  ${'─'.repeat(40)}`,
    );
    for (const tool of tools) {
      const tier = TIER_LABELS[tool.tier] || `[${tool.tier}]`;
      if (tool.install.cmdCurl) {
        lines.push(`  ${tier.padEnd(5)} ${tool.name}`);
        lines.push(`        CLI (recommended): ${tool.install.cmd}`);
        lines.push(`        Curl (no install): ${tool.install.cmdCurl}`);
      } else {
        lines.push(`  ${tier.padEnd(5)} ${tool.name.padEnd(25)} ${tool.install.cmd}`);
      }
      if (tool.alternatives && tool.alternatives.length > 0) {
        const altNames = tool.alternatives.map((a) => `${a.tool} (${a.tier})`).join(', ');
        lines.push(`        Free alternatives: ${altNames}`);
      }
    }
  }

  lines.push(...formatSkippedSection(skipped), '');
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
