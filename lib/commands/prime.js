'use strict';

const {
  buildPrime,
  formatOrientationText,
} = require('../orientation');

const usage = 'Usage: forge prime [--budget N] [--json]';

function readOption(args, name, fallback) {
  const equals = args.find(arg => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('-')) return args[index + 1];
  return fallback;
}

async function handler(args, _flags, projectRoot) {
  const result = buildPrime(projectRoot, {
    budgetTokens: readOption(args, '--budget', undefined),
  });

  return {
    success: true,
    output: args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatOrientationText(result),
  };
}

module.exports = {
  name: 'prime',
  description: 'Emit session-entry bounded orientation for agents',
  usage,
  handler,
};
