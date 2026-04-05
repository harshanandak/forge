'use strict';

const { execFileSync } = require('node:child_process');

const SUBCOMMANDS = {
  create: {
    description: 'Create a Beads issue via Forge',
    usage: 'forge create [title] [bd-create-flags]',
    helpCommand: 'create',
    buildBdArgs: (args) => ['create', ...args],
  },
  update: {
    description: 'Update a Beads issue via Forge',
    usage: 'forge update <id...> [bd-update-flags]',
    helpCommand: 'update',
    buildBdArgs: (args) => ['update', ...args],
  },
  claim: {
    description: 'Claim a Beads issue via Forge',
    usage: 'forge claim <id> [bd-update-flags]',
    helpCommand: 'update',
    buildBdArgs: (args) => {
      const [issueId, ...rest] = args;
      if (!issueId) {
        return { error: 'Missing issue id. Usage: forge claim <id> [bd-update-flags]' };
      }
      return ['update', issueId, '--claim', ...rest];
    },
  },
  close: {
    description: 'Close a Beads issue via Forge',
    usage: 'forge close <id...> [bd-close-flags]',
    helpCommand: 'close',
    buildBdArgs: (args) => ['close', ...args],
  },
  show: {
    description: 'Show a Beads issue via Forge',
    usage: 'forge show <id> [bd-show-flags]',
    helpCommand: 'show',
    buildBdArgs: (args) => ['show', ...args],
  },
  list: {
    description: 'List Beads issues via Forge',
    usage: 'forge list [bd-list-flags]',
    helpCommand: 'list',
    buildBdArgs: (args) => ['list', ...args],
  },
  ready: {
    description: 'Show ready Beads issues via Forge',
    usage: 'forge ready [bd-ready-flags]',
    helpCommand: 'ready',
    buildBdArgs: (args) => ['ready', ...args],
  },
};

function normalizeArgs(args = []) {
  return args.filter(arg => arg !== '--');
}

function getExecOptions(projectRoot) {
  return {
    cwd: projectRoot,
    stdio: 'inherit',
  };
}

function formatIssueHelp() {
  const lines = [
    'Usage: forge issue <subcommand> [...]',
    '',
    'Supported subcommands:',
  ];

  for (const [name, spec] of Object.entries(SUBCOMMANDS)) {
    lines.push(`  ${name.padEnd(6)} ${spec.description}`);
  }

  lines.push('');
  lines.push('Examples:');
  lines.push('  forge create --title "Add feature" --type feature');
  lines.push('  forge claim forge-abc');
  lines.push('  forge update forge-abc --priority 1');
  lines.push('  forge close forge-abc --reason "Done"');
  lines.push('  forge issue show forge-abc --json');

  return lines.join('\n');
}

function extractErrorMessage(error) {
  if (error && error.code === 'ENOENT') {
    return 'Beads (bd) command not found. Install or initialize Beads before using Forge issue commands.';
  }

  const stderr = error && error.stderr ? error.stderr.toString().trim() : '';
  const stdout = error && error.stdout ? error.stdout.toString().trim() : '';
  const message = error && error.message ? error.message.trim() : '';

  return stderr || stdout || message || 'Beads command failed';
}

function buildBdArgs(subcommand, rawArgs) {
  const spec = SUBCOMMANDS[subcommand];
  if (!spec) {
    return { error: `Unknown issue subcommand '${subcommand}'.\n\n${formatIssueHelp()}` };
  }

  const args = normalizeArgs(rawArgs);
  if (args.includes('--help') || args.includes('-h')) {
    return [spec.helpCommand, '--help'];
  }

  return spec.buildBdArgs(args);
}

async function runIssueSubcommand(subcommand, args, projectRoot, opts = {}) {
  const exec = opts._exec || execFileSync;
  const bdArgs = buildBdArgs(subcommand, args);

  if (!Array.isArray(bdArgs)) {
    return { success: false, error: bdArgs.error };
  }

  try {
    exec('bd', bdArgs, getExecOptions(projectRoot));
    return { success: true, subcommand };
  } catch (error) {
    return {
      success: false,
      error: extractErrorMessage(error),
    };
  }
}

function makeAliasCommand(subcommand) {
  const spec = SUBCOMMANDS[subcommand];
  if (!spec) {
    throw new Error(`Unknown issue subcommand '${subcommand}'`);
  }

  return {
    name: subcommand,
    description: spec.description,
    usage: spec.usage,
    flags: {},
    handler: async (args, _flags, projectRoot, opts = {}) =>
      runIssueSubcommand(subcommand, args, projectRoot, opts),
  };
}

function createIssueCommand() {
  return {
    name: 'issue',
    description: 'Manage Beads issues through the Forge command surface',
    usage: 'forge issue <create|update|claim|close|show|list|ready> [...]',
    flags: {},
    handler: async (args, _flags, projectRoot, opts = {}) => {
      const [subcommand, ...rest] = normalizeArgs(args);

      if (!subcommand || subcommand === '--help' || subcommand === '-h') {
        return { success: false, error: formatIssueHelp() };
      }

      return runIssueSubcommand(subcommand, rest, projectRoot, opts);
    },
  };
}

module.exports = {
  SUBCOMMANDS,
  buildBdArgs,
  createIssueCommand,
  makeAliasCommand,
  runIssueSubcommand,
};
