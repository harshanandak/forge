'use strict';

const remember = require('./remember');
const recall = require('./recall');
const insights = require('./insights');
const { stripGlobalFlags } = require('../global-flags');
const projectMemory = require('../project-memory');
const { reviewMemories } = require('../memory/hygiene');

function renderReview(review) {
  const lines = [`Memory hygiene: ${review.findings.length} finding(s), ${review.scanned}/${review.total} scanned.`];
  for (const finding of review.findings) {
    lines.push(`${finding.review_id}  ${finding.kind}${finding.claim ? `  ${finding.claim}` : `  ${finding.count} equivalent records`}`);
  }
  if (review.truncated) lines.push('Results truncated by the bounded review limits.');
  return lines.join('\n');
}

async function reviewHandler(args, flags, projectRoot, opts = {}) {
  const listMemories = opts.listMemories || projectMemory.list;
  const review = reviewMemories(await listMemories(projectRoot, opts));
  return {
    success: true,
    output: args.includes('--json') || flags.json ? JSON.stringify(review, null, 2) : renderReview(review),
  };
}

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
  review: {
    handler: reviewHandler,
    summary: 'Report bounded duplicate and explicit-contradiction findings with stable review ids',
  },
  doctor: {
    handler: reviewHandler,
    summary: 'Alias for memory review',
  },
};

const usage = 'Usage: forge memory <add|recall|search|insights|review|doctor> [args]';

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
    'Unified memory surface: add, recall, search, insights, and bounded hygiene review',
  usage,
  handler,
};
