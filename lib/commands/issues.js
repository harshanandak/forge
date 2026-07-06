'use strict';

const { runIssueOperation } = require('../forge-issues');
const { SUBCOMMANDS } = require('./_issue');

const SUPPORTED_SUBCOMMANDS = ['create', 'list', 'show', 'close', 'update'];

function normalizeArgs(args = []) {
  return args.filter(arg => arg !== '--');
}

function formatHelp() {
  return [
    'Usage: forge issues <subcommand> [...]',
    '',
    'Supported subcommands:',
    '  create  Create an issue through Forge',
    '  list    List issues through Forge',
    '  show    Show a single issue through Forge',
    '  close   Close an issue through Forge',
    '  update  Update an issue through Forge',
  ].join('\n');
}

module.exports = {
  name: 'issues',
  description: 'Manage issues through the Forge authority layer',
  usage: 'forge issues <subcommand> [...]',
  // Undocumented back-compat alias for the canonical `forge issue` surface. It stays
  // registered and executable, but `hidden: true` omits it from `forge --help` so the
  // singular `issue` reads as the one canonical issue surface (kernel issue 450c6e34).
  hidden: true,
  flags: {},
  handler: async (args, _flags, projectRoot, opts = {}) => {
    const [subcommand, ...rest] = normalizeArgs(args);

    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      return {
        success: true,
        output: formatHelp(),
      };
    }

    if (!SUPPORTED_SUBCOMMANDS.includes(subcommand)) {
      return {
        success: false,
        error: `Unknown issue subcommand '${subcommand}'.\n\n${formatHelp()}`,
      };
    }

    // --help for a specific subcommand: print its usage and return BEFORE dispatching
    // to any backend. Otherwise --help is forwarded as an operation arg, which is
    // absorbed by Beads but fails with a bare "Command failed" on the Kernel default
    // (mirrors the short-circuit in lib/commands/_issue.js runIssueSubcommand).
    if (rest.some(arg => arg === '--help' || arg === '-h')) {
      const spec = SUBCOMMANDS[subcommand];
      return {
        success: true,
        output: spec ? `${spec.usage}\n\n${spec.description}` : formatHelp(),
      };
    }

    const runner = opts.runIssueOperation || runIssueOperation;
    return runner(subcommand, rest, projectRoot, opts);
  },
};
