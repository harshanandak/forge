'use strict';

const {
  buildRecap,
  formatRecapText,
} = require('../insights');

const usage = 'Usage: forge recap [--limit N] [--min-count N] [--since YYYY-MM-DD] [--json]';

function readOption(args, name, fallback) {
  const equals = args.find(arg => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('-')) return args[index + 1];
  return fallback;
}

async function handler(args, _flags, projectRoot) {
  const recap = buildRecap(projectRoot, {
    limit: readOption(args, '--limit', undefined),
    minCount: readOption(args, '--min-count', undefined),
    since: readOption(args, '--since', undefined),
  });
  return {
    success: true,
    output: args.includes('--json') ? `${JSON.stringify(recap, null, 2)}\n` : formatRecapText(recap),
  };
}

module.exports = {
  name: 'recap',
  description: 'Summarize recent work, evidence, issues, review outcomes, and insight candidates',
  usage,
  handler,
};
