'use strict';

const ship = require('./ship');
const preflight = require('./preflight');
const shepherd = require('./shepherd');
const merge = require('./merge');
const { stripGlobalFlags } = require('../global-flags');

// One memorable surface over the EXISTING pull-request commands (kernel issue
// 6ab3f30c): every subcommand delegates to the standalone ship/preflight/shepherd/
// merge handlers — the same code, not a reimplementation. The standalone
// `forge ship`/`preflight`/`shepherd`/`merge` commands remain registered as
// back-compat aliases (see lib/commands/_aliases.js), so nothing that already
// calls them breaks. `pr ship` is the canonical PR-creation form; bare `ship`
// stays a visible shortcut.
//
// Delegates are referenced by MODULE (not a pre-bound `.handler`) so the routed
// handler is resolved at dispatch time — dispatch always reaches whatever the
// command module currently exports, keeping the standalone command the single
// source of truth for its own behaviour.
const SUBCOMMANDS = {
  ship: {
    module: ship,
    summary: 'Create a pull request from validated feature work (= forge ship)',
  },
  preflight: {
    module: preflight,
    summary: 'Fast deterministic-gate parity with CI (= forge preflight; supports --all)',
  },
  shepherd: {
    module: shepherd,
    summary: 'Run one bounded monitor pass over a PR (= forge shepherd; --bundle/--pull/--json, events, watch)',
  },
  merge: {
    module: merge,
    summary: 'Opt-in conditional auto-merge, OFF by default (= forge merge --auto <pr>)',
  },
};

const usage = 'Usage: forge pr <ship|preflight|shepherd|merge> [args]';

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
    'Back-compat: forge ship / forge preflight / forge shepherd / forge merge remain available as aliases.',
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
      error: `Unknown pr subcommand: ${positional}\n\n${renderHelp()}`,
    };
  }

  // Forward everything EXCEPT the consumed subcommand token to the delegate, preserving
  // every remaining token (including flags like `--pull`/`--json`/`--bundle`, and the
  // `events`/`watch` shepherd sub-shapes) so passthrough stays byte-identical.
  const idx = args.indexOf(positional);
  const childArgs = idx >= 0 ? [...args.slice(0, idx), ...args.slice(idx + 1)] : args;
  return sub.module.handler(childArgs, flags, projectRoot, opts);
}

module.exports = {
  name: 'pr',
  description:
    'Unified pull-request surface: forge pr ship|preflight|shepherd|merge (wraps ship/preflight/shepherd/merge)',
  usage,
  handler,
};
