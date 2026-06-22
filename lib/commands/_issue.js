'use strict';

const { execFileSync } = require('node:child_process');
const { runIssueOperation } = require('../forge-issues');

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

// Render a kernel envelope to a printable output string. With --json we emit the
// FULL envelope (so next_commands + schema_version reach JSON consumers); the
// human path prints the data payload.
function renderKernelEnvelope(raw, { json = false } = {}) {
  if (json) {
    return JSON.stringify(raw, null, 2);
  }
  if (raw.data === undefined || raw.data === null) {
    return '';
  }
  return typeof raw.data === 'string' ? raw.data : JSON.stringify(raw.data, null, 2);
}

// B3 — Result-envelope normalization. Kernel mutations/reads return
// { ok, schema_version, command, data, next_commands } with NO `success` field,
// so bin/forge.js's `!result.success` check reads a kernel success as a failure.
// Map ok→success and render data as output WITHOUT dropping next_commands /
// schema_version (preserved on `_envelope` for --json consumers). Beads-shaped
// results ({ success, output }) and null/undefined pass through untouched.
function normalizeIssueResult(raw, { json = false } = {}) {
  if (!raw || typeof raw !== 'object' || raw.ok === undefined) {
    return raw;
  }
  return {
    success: Boolean(raw.ok),
    output: renderKernelEnvelope(raw, { json }),
    error: raw.ok ? undefined : (raw.error?.message || raw.error || 'Kernel issue command failed'),
    _envelope: raw,
  };
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

// Verbs that accept multiple issue ids in one invocation. The kernel broker
// builds ONE event per call (firstPositionalArg), so the CLI must fan these out
// per-id — but ONLY under the kernel backend. Beads fans out internally
// (`bd close <all ids>`), so looping there would regress one spawn into N.
const MULTI_ID_KERNEL_SUBCOMMANDS = new Set(['close', 'update']);

// Split kernel operation args into positional ids and the trailing flag tokens
// (e.g. `--reason=x`, `--status done`) that must ride along to EVERY per-id call.
function splitIdsAndFlags(operationArgs) {
  const ids = [];
  const flagTokens = [];
  for (let i = 0; i < operationArgs.length; i += 1) {
    const token = operationArgs[i];
    if (typeof token === 'string' && token.startsWith('-')) {
      flagTokens.push(token);
      // A `--key value` pair (space form) drags its value with it; `--key=value`
      // and bare booleans do not.
      const next = operationArgs[i + 1];
      if (!token.includes('=') && typeof next === 'string' && !next.startsWith('-')) {
        flagTokens.push(next);
        i += 1;
      }
    } else {
      ids.push(token);
    }
  }
  return { ids, flagTokens };
}

// Aggregate per-id kernel results: success iff every id succeeded; preserve every
// id's envelope (never just the last). On any failure, surface per-id errors.
function aggregateKernelResults(normalized) {
  const failures = normalized.filter(result => !result.success);
  const envelopes = normalized.map(result => result._envelope).filter(Boolean);
  if (failures.length === 0) {
    return {
      success: true,
      output: normalized.map(result => result.output).filter(Boolean).join('\n'),
      _envelopes: envelopes,
    };
  }
  return {
    success: false,
    error: failures.map(result => result.error).filter(Boolean).join('; '),
    _envelopes: envelopes,
  };
}

async function runIssueSubcommand(subcommand, args, projectRoot, opts = {}) {
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
    const json = normalizeArgs(args).includes('--json');

    // B4a — kernel-gated multi-id fan-out. Only under the kernel backend and only
    // for multi-id verbs with 2+ ids; the beads path stays a single spawn.
    if (shouldUseKernelBroker(opts) && MULTI_ID_KERNEL_SUBCOMMANDS.has(subcommand)) {
      const { ids, flagTokens } = splitIdsAndFlags(operationArgs);
      if (ids.length > 1) {
        const normalized = [];
        for (const id of ids) {
          const perIdRaw = await runner(operation, [id, ...flagTokens], projectRoot, opts);
          normalized.push(normalizeIssueResult(perIdRaw, { json }));
        }
        return aggregateKernelResults(normalized);
      }
    }

    const raw = await runner(operation, operationArgs, projectRoot, opts);
    // Normalize the kernel envelope to the dispatcher's { success, output } shape
    // (B3). Beads results already match and pass through untouched.
    return normalizeIssueResult(raw, { json });
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
  normalizeIssueResult,
  runIssueSubcommand,
};
