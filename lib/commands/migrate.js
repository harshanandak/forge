'use strict';

const {
  buildMigrationDryRunReport,
  renderMigrationDryRunReport,
} = require('../migrate-dry-run');

function hasArg(args, name) {
  return Array.isArray(args) && args.includes(name);
}

module.exports = {
  name: 'migrate',
  description: 'Preview v2 to v3 migration changes',
  usage: 'forge migrate --dry-run [--fixture-corpus]',
  flags: {
    '--dry-run': 'Required for the Wave 0 PoC; preview migration without writing files',
    '--fixture-corpus': 'Also materialize and dry-run the source-tree v2 fixture corpus when available',
  },

  async handler(args, flags, projectRoot) {
    const dryRun = flags?.dryRun === true || hasArg(args, '--dry-run');
    if (!dryRun) {
      return {
        success: false,
        error: 'Only forge migrate --dry-run is implemented in the Wave 0 PoC.',
      };
    }

    const report = buildMigrationDryRunReport(projectRoot, {
      fixtureCorpus: hasArg(args, '--fixture-corpus'),
    });
    const output = renderMigrationDryRunReport(report);

    return {
      success: report.ok,
      output,
      error: report.ok ? undefined : output,
    };
  },
};
