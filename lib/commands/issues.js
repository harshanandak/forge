'use strict';

const { runIssueOperation } = require('../forge-issues');

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

    const runner = opts.runIssueOperation || runIssueOperation;
    return runner(subcommand, rest, projectRoot, opts);
  },
};
