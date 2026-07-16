'use strict';

const remember = require('./remember');
const recall = require('./recall');
const insights = require('./insights');
const { stripGlobalFlags } = require('../global-flags');

// One memorable surface over the EXISTING memory commands (kernel issue 25362344): every
// subcommand delegates to the standalone remember/recall/insights handlers — the same
// kernel-backed store, not a reimplementation. The standalone `forge remember`/`forge
// recall`/`forge insights` commands remain registered as back-compat aliases, so nothing
// that already calls them breaks.
const SUBCOMMANDS = {
  add: {
    handler: remember.handler,
    summary: 'Persist a memory note (= forge remember; supports --type + What/Why/Where/Learned)',
  },
  recall: {
    handler: recall.handler,
    summary: 'Retrieve memory notes, newest first (= forge recall; filter with --type)',
  },
  search: {
    // Search IS recall with a query — recall runs a BM25 token-AND search when a query is
    // present, so the same handler serves both without a second code path.
    handler: recall.handler,
    summary: 'Search memory notes by query (recall with a query; filter with --type)',
  },
  insights: {
    handler: insights.handler,
    summary: 'Detect recurring evidence patterns and suggest follow-ups (= forge insights)',
  },
};

const usage = 'Usage: forge memory <add|recall|search|insights> [args]';

function renderHelp() {
  const width = Math.max(...Object.keys(SUBCOMMANDS).map(name => name.length));
  const lines = [
    usage,
    '',
    'Subcommands:',
    ...Object.entries(SUBCOMMANDS).map(
      ([name, { summary }]) => `  ${name.padEnd(width)}  ${summary}`
    ),
    '',
    'Back-compat: forge remember / forge recall / forge insights remain available as aliases.',
  ];
  return lines.join('\n');
}

async function handler(args, flags, projectRoot, opts) {
  // The subcommand is the first positional token; global flags (e.g. `-p <dir>`) are stripped
  // first so they never masquerade as the subcommand.
  const positional = stripGlobalFlags(args).find(arg => !arg.startsWith('-'));

  if (!positional || positional === 'help' || args.includes('--help') || args.includes('-h')) {
    return { success: true, output: renderHelp() };
  }

  const sub = SUBCOMMANDS[positional];
  if (!sub) {
    return {
      success: false,
      error: `Unknown memory subcommand: ${positional}\n\n${renderHelp()}`,
    };
  }

  // Forward everything EXCEPT the consumed subcommand token to the delegate, preserving any
  // global flags the delegate re-parses (e.g. `-p <dir>`, `--all`).
  const idx = args.indexOf(positional);
  const childArgs = idx >= 0 ? [...args.slice(0, idx), ...args.slice(idx + 1)] : args;
  return sub.handler(childArgs, flags, projectRoot, opts);
}

module.exports = {
  name: 'memory',
  description:
    'Unified memory surface: forge memory add|recall|search|insights (wraps remember/recall/insights)',
  usage,
  handler,
};
