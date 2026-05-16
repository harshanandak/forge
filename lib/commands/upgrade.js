'use strict';

const {
  applySelfHeal,
  buildUpgradeDryRunReport,
  renderUpgradeDryRunReport,
} = require('../upgrade-safety');

function hasArg(args, name) {
  return Array.isArray(args) && args.includes(name);
}

const usage = 'Usage: forge upgrade [--dry-run] [--self-heal]';

async function handler(args, flags, projectRoot) {
  const dryRun = flags?.dryRun === true || hasArg(args, '--dry-run');
  const selfHeal = flags?.selfHeal === true || flags?.['self-heal'] === true || hasArg(args, '--self-heal');

  if (!dryRun && !selfHeal) {
    return {
      success: false,
      error: usage,
    };
  }

  const report = buildUpgradeDryRunReport(projectRoot);
  const selfHealResult = selfHeal ? applySelfHeal(report.projectRoot, report) : null;
  const output = renderUpgradeDryRunReport(report, selfHealResult);
  const success = report.ok && !selfHealResult?.refused;

  return {
    success,
    output,
    error: success ? undefined : output,
  };
}

module.exports = {
  name: 'upgrade',
  description: 'Preview and self-heal safe Forge upgrade readiness',
  usage,
  flags: {
    '--dry-run': 'Preview upgrade readiness without writing files',
    '--self-heal': 'Apply safe metadata repairs only; does not snapshot or restore',
  },
  handler,
};
