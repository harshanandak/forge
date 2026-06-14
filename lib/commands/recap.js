'use strict';

const {
  buildRecap,
  formatRecapText,
} = require('../insights');
const {
  buildIssueRecap,
  formatOrientationText,
} = require('../orientation');

const usage = 'Usage: forge recap [issue] [--budget N] [--limit N] [--min-count N] [--since YYYY-MM-DD] [--json]';
const OPTIONS_WITH_VALUES = new Set(['--budget', '--limit', '--min-count', '--since']);

function readOption(args, name, fallback) {
  const equals = args.find(arg => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('-')) return args[index + 1];
  return fallback;
}

function readIssueArg(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === '--json') continue;
    if (OPTIONS_WITH_VALUES.has(arg)) {
      index += 1;
      continue;
    }
    if ([...OPTIONS_WITH_VALUES].some(option => arg.startsWith(`${option}=`))) continue;
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return null;
}

async function handler(args, _flags, projectRoot) {
  const issueId = readIssueArg(args);

  if (issueId) {
    const recap = buildIssueRecap(projectRoot, issueId, {
      budgetTokens: readOption(args, '--budget', undefined),
    });
    return {
      success: true,
      output: args.includes('--json') ? `${JSON.stringify(recap, null, 2)}\n` : formatOrientationText(recap),
    };
  }

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
