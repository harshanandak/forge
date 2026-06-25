'use strict';

const {
  buildIssueRecap,
  formatOrientationText,
} = require('../orientation');

const usage = 'Usage: forge recap <issue> [--budget N] [--json]';

function readOption(args, name, fallback) {
  const equals = args.find(arg => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('-')) return args[index + 1];
  return fallback;
}

function readIssueArg(args) {
  for (const arg of args) {
    if (!arg || arg.startsWith('-')) continue;
    return arg;
  }
  return null;
}

// `forge recap <issue>` summarizes a single issue from the deterministic
// orientation source assembly — it is issue-scoped, not a project-wide recap.
async function handler(args, _flags, projectRoot) {
  const issueId = readIssueArg(args);
  if (!issueId) {
    return { success: false, output: `${usage}\n` };
  }

  const recap = buildIssueRecap(projectRoot, issueId, {
    budgetTokens: readOption(args, '--budget', undefined),
  });
  return {
    success: true,
    output: args.includes('--json') ? `${JSON.stringify(recap, null, 2)}\n` : formatOrientationText(recap),
  };
}

module.exports = {
  name: 'recap',
  description: 'Summarize a single issue from deterministic orientation source files',
  usage,
  handler,
};
