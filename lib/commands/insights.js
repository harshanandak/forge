'use strict';

const {
  analyzeInsights,
  formatInsightsText,
  recordInsightDecision,
} = require('../insights');

const usage = [
  'Usage: forge insights [--limit N] [--min-count N] [--since YYYY-MM-DD] [--json]',
  '       forge insights accept <candidate-id> [--note text]',
  '       forge insights reject <candidate-id> [--note text]',
].join('\n');

function readOption(args, name, fallback) {
  const equals = args.find(arg => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('-')) return args[index + 1];
  return fallback;
}

function positionals(args) {
  const values = [];
  const flagsWithValues = new Set(['--limit', '--min-count', '--since', '--note', '--path', '-p']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith('--') && arg.includes('=')) continue;
    if (flagsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    values.push(arg);
  }
  return values;
}

async function handler(args, flags, projectRoot) {
  const commandFlags = flags ?? {};
  const [subcommand, candidateId] = positionals(args);
  if (subcommand === 'accept' || subcommand === 'reject') {
    if (!candidateId) {
      return { success: false, error: usage };
    }
    const status = subcommand === 'accept' ? 'accepted' : 'rejected';
    const decision = recordInsightDecision(projectRoot, candidateId, status, {
      note: readOption(args, '--note', ''),
      memory: commandFlags.memory,
    });
    return {
      success: true,
      output: `Insight ${candidateId} ${status}. Decision recorded at ${decision.key}.\n`,
    };
  }

  const result = analyzeInsights(projectRoot, {
    limit: readOption(args, '--limit', undefined),
    minCount: readOption(args, '--min-count', undefined),
    since: readOption(args, '--since', undefined),
  });
  if (args.includes('--review-feedback')) {
    result.limitations = [
      'Compatibility note: --review-feedback now reads Beads interactions and issue evidence; external review-provider comments are not inferred.',
      ...result.limitations,
    ];
  }
  return {
    success: true,
    output: args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatInsightsText(result),
  };
}

module.exports = {
  name: 'insights',
  description: 'Detect recurring evidence patterns and suggest conservative workflow follow-ups',
  usage,
  handler,
};
