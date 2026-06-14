'use strict';

const {
  buildOrientation,
  formatOrientationText,
} = require('../orientation');

const usage = 'Usage: forge orient [--budget N] [--json]';

function readOption(args, name, fallback) {
  const equals = args.find(arg => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('-')) return args[index + 1];
  return fallback;
}

async function handler(args, _flags, projectRoot) {
  const result = buildOrientation(projectRoot, {
    budgetTokens: readOption(args, '--budget', undefined),
  });

  return {
    success: true,
    output: args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatOrientationText(result),
  };
}

module.exports = {
  name: 'orient',
  description: 'Emit bounded project orientation from deterministic source files',
  usage,
  handler,
};
