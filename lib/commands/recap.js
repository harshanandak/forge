'use strict';

const {
  buildIssueRecap,
  formatOrientationText,
} = require('../orientation');

const usage = 'Usage: forge recap <issue> [--budget N] [--json]';

// Options that consume the following token as their value. The issue-id scan
// must skip these values so `forge recap --budget 220 <issue>` is not misread.
const OPTIONS_WITH_VALUES = new Set(['--budget']);

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
    if (!arg) continue;
    if (OPTIONS_WITH_VALUES.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return null;
}

// `forge recap <issue>` summarizes a single issue from the deterministic
// orientation source assembly — it is issue-scoped, not a project-wide recap.
async function handler(args, _flags, projectRoot) {
  const issueId = readIssueArg(args);
  if (!issueId) {
    // Use `error` (not `output`) so the CLI dispatcher prints the usage line
    // once via console.error instead of also appending a redundant bare
    // "Command failed" (see bin/forge.js registry dispatch).
    return { success: false, error: usage };
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
