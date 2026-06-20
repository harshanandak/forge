'use strict';

const { execFileSync } = require('node:child_process');
const { runIssueOperation } = require('../forge-issues');
const { resolveIssueBackend, hasExplicitBackendSignal } = require('../issue-backend');

const SUBCOMMANDS = {
  create: {
    description: 'Create an issue via Forge',
    usage: 'forge create [title] [bd-create-flags]',
    helpCommand: 'create',
    buildBdArgs: (args) => ['create', ...args],
  },
  update: {
    description: 'Update an issue via Forge',
    usage: 'forge update <id...> [bd-update-flags]',
    helpCommand: 'update',
    buildBdArgs: (args) => ['update', ...args],
  },
  claim: {
    description: 'Claim an issue via Forge',
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
  release: {
    description: 'Release a Kernel issue claim via Forge',
    usage: 'forge release <id>',
    helpCommand: 'update',
    buildBdArgs: (args) => {
      const [issueId] = args;
      if (!issueId) {
        return { error: 'Missing issue id. Usage: forge release <id>' };
      }
      return ['release', ...args];
    },
  },
  comment: {
    description: 'Add an issue comment via Forge',
    usage: 'forge comment <id> <body...>',
    helpCommand: 'comments',
    buildBdArgs: (args) => ['comments', 'add', ...args],
  },
  close: {
    description: 'Close an issue via Forge',
    usage: 'forge close <id...> [bd-close-flags]',
    helpCommand: 'close',
    buildBdArgs: (args) => ['close', ...args],
  },
  show: {
    description: 'Show an issue via Forge',
    usage: 'forge show <id> [bd-show-flags]',
    helpCommand: 'show',
    buildBdArgs: (args) => ['show', ...args],
  },
  list: {
    description: 'List issues via Forge',
    usage: 'forge list [bd-list-flags]',
    helpCommand: 'list',
    buildBdArgs: (args) => ['list', ...args],
  },
  ready: {
    description: 'Show ready issues via Forge',
    usage: 'forge ready [bd-ready-flags]',
    helpCommand: 'ready',
    buildBdArgs: (args) => ['ready', ...args],
  },
  search: {
    description: 'Search issues via Forge',
    usage: 'forge issue search <query> [bd-search-flags]',
    helpCommand: 'search',
    buildBdArgs: (args) => ['search', ...args],
  },
  stats: {
    description: 'Show issue statistics via Forge',
    usage: 'forge issue stats [bd-status-flags]',
    helpCommand: 'status',
    buildBdArgs: (args) => ['status', ...args],
  },
  dep: {
    description: 'Manage issue dependencies via Forge',
    usage: 'forge issue dep <add|remove> <issue-id> <blocks-issue-id>',
    helpCommand: 'dep',
    buildBdArgs: (args) => {
      const [action, ...rest] = args;
      if (!['add', 'remove'].includes(action)) {
        return {
          error: `Unsupported dependency action: ${action || '(missing)'}. Usage: forge issue dep <add|remove> <issue-id> <blocks-issue-id>`,
        };
      }
      if (rest.length < 2) {
        return {
          error: `Missing dependency ids. Usage: forge issue dep ${action} <issue-id> <blocks-issue-id>`,
        };
      }
      return ['dep', action, ...rest];
    },
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
  lines.push('  forge comment forge-abc "Handoff note"');
  lines.push('  forge issue show forge-abc --json');
  lines.push('  forge issue search "kernel contract" --json');
  lines.push('  forge issue stats --json');
  lines.push('  forge issue dep add forge-work forge-blocker');

  return lines.join('\n');
}

function extractErrorMessage(error) {
  if (error?.code === 'ENOENT') {
    return 'Beads (bd) command not found. Install or initialize Beads before using Forge issue commands.';
  }

  // With stdio: 'inherit', error.stderr and error.stdout are always null.
  // Only error.message is available for diagnostics.
  return error?.message?.trim() || 'Beads command failed';
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

const WRITE_SUBCOMMANDS = new Set(['create', 'update', 'claim', 'release', 'comment', 'close', 'dep']);
const RELEASE_KERNEL_ONLY_ERROR = 'forge release <id> is defined for the Kernel issue backend; Beads passthrough has no verified release operation.';

function shouldUseKernelBroker(opts = {}) {
  return Boolean(opts.useKernelBroker || opts.kernelBroker || opts.issueBackend === 'kernel');
}

function resolveIssueOperation(subcommand, args, opts = {}) {
  if (subcommand === 'claim') {
    return shouldUseKernelBroker(opts) ? 'claim' : 'update';
  }

  if (subcommand === 'dep') {
    return `dep.${normalizeArgs(args)[0]}`;
  }

  return subcommand;
}

function resolveOperationArgs(subcommand, args, bdArgs, opts = {}) {
  const normalizedArgs = normalizeArgs(args);

  if (subcommand === 'dep') {
    return normalizedArgs.slice(1);
  }

  if (shouldUseKernelBroker(opts)) {
    return normalizedArgs;
  }

  if (subcommand === 'comment') {
    return normalizedArgs;
  }

  return bdArgs.slice(1);
}

// Resolve the active issue backend (kernel|beads) and thread it into opts so the
// shared runIssueOperation deps see it. OPT-IN ONLY: opts is left byte-identical
// when no explicit signal is present (env/config/explicit), preserving the Beads
// default path. A copy is returned — the caller's opts object is never mutated.
function withResolvedIssueBackend(projectRoot, opts = {}) {
  if (opts.issueBackend) {
    // An explicit caller value always wins and is already on opts; nothing to add.
    return opts;
  }

  const env = opts.env || process.env;
  const signalContext = { deps: opts, env, projectRoot };
  if (!hasExplicitBackendSignal(signalContext)) {
    return opts;
  }

  const issueBackend = resolveIssueBackend(signalContext);
  return { ...opts, issueBackend };
}

// The Kernel broker returns the issue-command contract shape
// ({ ok, schema_version, command, data, next_commands } or { ok:false, error })
// rather than the Beads-style { success, output }. The bin/forge.js result printer
// keys on `success`/`output`, so a raw kernel contract would render as
// "Command failed" with a non-zero exit even on success. Normalize ONLY the
// contract shape (ok defined, success undefined) into { success, output } here, at
// the command boundary — the kernel contract itself stays untouched for the
// adapter/broker/kernel tests that pin it. Every other result passes through
// byte-identical, preserving the Beads default path.
function normalizeIssueResult(result, operation) {
  if (!result || typeof result !== 'object') {
    return result;
  }
  if (result.ok === undefined || result.success !== undefined) {
    return result;
  }

  if (result.ok === true) {
    return {
      success: true,
      operation,
      output: JSON.stringify(result.data ?? null, null, 2),
    };
  }

  const message = result.error?.message
    || result.message
    || `Issue ${operation} failed`;
  return { success: false, error: message };
}

async function runIssueSubcommand(subcommand, args, projectRoot, rawOpts = {}) {
  const opts = withResolvedIssueBackend(projectRoot, rawOpts);

  if (subcommand === 'release' && !shouldUseKernelBroker(opts)) {
    return { success: false, error: RELEASE_KERNEL_ONLY_ERROR };
  }

  const bdArgs = buildBdArgs(subcommand, args);

  if (!Array.isArray(bdArgs)) {
    return { success: false, error: bdArgs.error };
  }

  if (WRITE_SUBCOMMANDS.has(subcommand) || shouldUseKernelBroker(opts)) {
    const runner = opts.runIssueOperation || runIssueOperation;
    const operation = resolveIssueOperation(subcommand, args, opts);
    const operationArgs = resolveOperationArgs(subcommand, args, bdArgs, opts);
    const result = await runner(operation, operationArgs, projectRoot, opts);
    return normalizeIssueResult(result, operation);
  }

  const exec = opts._exec || execFileSync;

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
    description: 'Manage issues through the Forge command surface',
    usage: 'forge issue <create|update|claim|release|close|show|list|ready|search|stats|dep> [...]',
    flags: {},
    handler: async (args, _flags, projectRoot, opts = {}) => {
      const [subcommand, ...rest] = normalizeArgs(args);

      if (!subcommand || subcommand === '--help' || subcommand === '-h') {
        return { success: true, output: formatIssueHelp() };
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
