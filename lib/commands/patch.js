'use strict';

const {
  recordPatchIntentFromDiff,
  resolvePatchIntentRecords,
} = require('../patch-intent');

const usage = [
  'forge patch record --from-diff',
  'forge patch status',
].join('\n');

function formatRecordSummary(result) {
  const count = result.records.length;
  const label = count === 1 ? 'patch intent' : 'patch intents';
  return [
    `Recorded ${count} ${label} in ${result.path}.`,
    ...result.records.map(record => `- ${record.id} -> ${record.anchorId} (${record.path})`),
  ].join('\n');
}

async function handler(args, _flags, projectRoot) {
  const [subcommand, ...rest] = args;

  if (subcommand === 'record') {
    if (!rest.includes('--from-diff')) {
      return {
        success: false,
        error: `Missing --from-diff.\n\nUsage:\n${usage}`,
      };
    }
    const result = recordPatchIntentFromDiff(projectRoot);
    return {
      success: true,
      output: formatRecordSummary(result),
    };
  }

  if (subcommand === 'status') {
    const result = resolvePatchIntentRecords(projectRoot);
    const lines = [
      `Patch intent file: ${result.path}`,
      `Records: ${result.records.length}`,
      `Orphans: ${result.orphans.length}`,
    ];
    for (const record of result.records) {
      lines.push(`- ${record.id}: ${record.status} ${record.anchorId} -> ${record.currentPath || record.path}`);
    }
    return {
      success: true,
      output: lines.join('\n'),
    };
  }

  return {
    success: false,
    error: `Unknown patch subcommand: ${subcommand || '(none)'}\n\nUsage:\n${usage}`,
  };
}

module.exports = {
  name: 'patch',
  description: 'Record and inspect patch intent anchored in patch.md',
  usage,
  handler,
};

