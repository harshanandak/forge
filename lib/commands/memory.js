'use strict';

const remember = require('./remember');
const recall = require('./recall');
const insights = require('./insights');
const { stripGlobalFlags } = require('../global-flags');
const projectMemory = require('../project-memory');
const { MEMORY_REVIEW_ENTRY_LIMIT, reviewMemories, stalenessForMemory } = require('../memory/hygiene');

function renderReview(review) {
  const lines = [`Memory hygiene: ${review.findings.length} finding(s), ${review.scanned}/${review.total} scanned.`];
  for (const finding of review.findings) {
    const detail = finding.claim ? finding.claim : `${finding.count} equivalent records`;
    lines.push(`${finding.review_id}  ${finding.kind}  ${detail}`);
  }
  if (!review.usage.available) lines.push('Usage staleness: unavailable; no demotion applied.');
  else if (review.usage.demoted > 0) lines.push(`Usage staleness: ${review.usage.demoted} memory record(s) demoted after 90 days.`);
  if (review.truncated) lines.push('Results truncated by the bounded review limits.');
  return lines.join('\n');
}

async function reviewHandler(args, flags, projectRoot, opts = {}) {
  const recentMemories = opts.recentMemories || projectMemory.recent;
  const countMemories = opts.countMemories || projectMemory.count;
  const loadUsageStatus = opts.usageProjections
    ? async (root, keys, options) => {
      try {
        const projections = await opts.usageProjections(root, keys, options);
        return projections instanceof Map
          ? { available: true, projections }
          : { available: false, projections: new Map() };
      } catch {
        return { available: false, projections: new Map() };
      }
    }
    : projectMemory.usageProjectionStatus;
  const store = opts.store || projectMemory.resolveStore(projectRoot, opts);
  const sharedOptions = { ...opts, store };
  const entries = await recentMemories(projectRoot, MEMORY_REVIEW_ENTRY_LIMIT, sharedOptions);
  const total = await countMemories(projectRoot, sharedOptions);
  const usageStatus = await loadUsageStatus(projectRoot, entries.map(entry => entry.key), sharedOptions);
  const usageAvailable = usageStatus?.available === true && usageStatus.projections instanceof Map;
  const projections = usageAvailable ? usageStatus.projections : new Map();
  const now = typeof opts.now === 'string' ? opts.now : new Date().toISOString();
  const usageFindings = usageAvailable ? entries.map(entry => {
    if (typeof entry?.key !== 'string' || typeof entry.timestamp !== 'string') return null;
    try {
      const status = stalenessForMemory({ created_at: entry.timestamp }, projections.get(entry.key) || null, { now });
      return status.demote ? { memory_id: projectMemory.memoryUsageIdentity(entry.key), ...status } : null;
    } catch {
      return null;
    }
  }).filter(Boolean).map(({ age_days: _ageDays, ...finding }) => finding) : [];
  const review = {
    ...reviewMemories(entries, { total }),
    usage: { available: usageAvailable, demoted: usageFindings.length, findings: usageFindings },
  };
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
