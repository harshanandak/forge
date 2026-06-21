'use strict';

const { execFileSync } = require('node:child_process');
const { runIssueOperation } = require('../forge-issues');
const { resolveIssueBackend, hasExplicitBackendSignal, shouldUseKernelBroker } = require('../issue-backend');

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
  // KAP-7: derived read queries. On the Kernel path these route through
  // runIssueOperation with the operation name === subcommand (resolveIssueOperation
  // passes them through unchanged); the Beads passthrough maps each to its bd
  // equivalent. They are READS, so they are intentionally NOT in WRITE_SUBCOMMANDS.
  blocked: {
    description: 'Show blocked issues via Forge',
    usage: 'forge issue blocked [bd-blocked-flags]',
    helpCommand: 'blocked',
    buildBdArgs: (args) => ['blocked', ...args],
  },
  stale: {
    description: 'Show stale issues via Forge',
    usage: 'forge issue stale [--days <n>]',
    helpCommand: 'stale',
    buildBdArgs: (args) => ['stale', ...args],
  },
  orphans: {
    description: 'Show issues with dangling dependency edges via Forge',
    usage: 'forge issue orphans',
    helpCommand: 'orphans',
    buildBdArgs: (args) => ['orphans', ...args],
  },
  // KAP-12: read-only content lint — issues missing required content
  // (task/bug with no acceptance_criteria). A READ, so NOT in WRITE_SUBCOMMANDS;
  // routes through runIssueOperation('lint', ...) on the Kernel path.
  lint: {
    description: 'Show issues missing required content via Forge',
    usage: 'forge issue lint',
    helpCommand: 'lint',
    buildBdArgs: (args) => ['lint', ...args],
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

function resolveIssueOperation(subcommand, args, opts = {}) {
  if (subcommand === 'claim') {
    return shouldUseKernelBroker(opts) ? 'claim' : 'update';
  }

  if (subcommand === 'dep') {
    return `dep.${normalizeArgs(args)[0]}`;
  }

  return subcommand;
}

// Beads accepts a positional title (`forge create "title"`); the Kernel create
// payload (buildCreatePayload) reads only the --title flag, so a bare positional
// would be ignored and the issue title would default to its minted UUID. For
// parity on the KERNEL PATH ONLY, translate a single LEADING bare positional into
// `--title <value>`, but only when no explicit --title/--title= is already present.
// Only args[0] is treated as the title (the Beads `[title]`-first convention), so a
// flag value such as `--type task` is never mistaken for a title. The Beads
// passthrough keeps its native positional handling untouched (this never runs for
// the Beads path).
function withKernelCreateTitle(args) {
  const hasTitle = args.some(
    arg => arg === '--title' || (typeof arg === 'string' && arg.startsWith('--title=')),
  );
  if (hasTitle || args.length === 0) {
    return args;
  }
  const leading = args[0];
  if (typeof leading === 'string' && !leading.startsWith('-')) {
    return ['--title', leading, ...args.slice(1)];
  }
  return args;
}

function resolveOperationArgs(subcommand, args, bdArgs, opts = {}) {
  const normalizedArgs = normalizeArgs(args);

  if (subcommand === 'dep') {
    return normalizedArgs.slice(1);
  }

  if (shouldUseKernelBroker(opts)) {
    return subcommand === 'create'
      ? withKernelCreateTitle(normalizedArgs)
      : normalizedArgs;
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
  const env = opts.env || process.env;
  const signalContext = { deps: opts, env, projectRoot };
  if (!hasExplicitBackendSignal(signalContext)) {
    return opts;
  }

  // Run EVERY explicit value through the resolver — including an explicit
  // opts.issueBackend — so case is normalized and unknown values warn + fall back.
  // An early `return opts` for opts.issueBackend would bypass that contract and let
  // e.g. 'KERNEL' slip past shouldUseKernelBroker's exact `=== 'kernel'` check.
  // opts.issueBackend still wins precedence over env/config inside the resolver.
  // Identity is preserved when the resolved value already matches, keeping the
  // no-op path byte-identical.
  const issueBackend = resolveIssueBackend(signalContext);
  if (opts.issueBackend === issueBackend) {
    return opts;
  }
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
      output: JSON.stringify({
        schema_version: result.schema_version,
        command: result.command,
        data: result.data ?? null,
        next_commands: result.next_commands ?? [],
      }, null, 2),
    };
  }

  const message = result.error?.message
    || result.message
    || `Issue ${operation} failed`;
  return { success: false, error: message };
}

// Split close args into the leading run of positional ids and the trailing flag
// tokens (everything from the first `-`-prefixed token onward). A flag value such
// as `done` in `--reason done` sits after a dash token, so it is correctly kept
// with the flags and never mistaken for an id.
function splitLeadingIds(args = []) {
  const flagIndex = args.findIndex(arg => typeof arg === 'string' && arg.startsWith('-'));
  if (flagIndex === -1) {
    return { ids: [...args], flags: [] };
  }
  return { ids: args.slice(0, flagIndex), flags: args.slice(flagIndex) };
}

// Kernel close fans out one runner call per id (the kernel close op closes a single
// id — the first positional), then aggregates the per-id outcomes into one
// {success,output} result. success is true only when every id closed. KERNEL PATH
// ONLY: the Beads passthrough keeps its single `bd close id1 id2 ...` exec.
async function runKernelBatchClose(runner, operation, ids, flags, projectRoot, opts) {
  const summary = [];
  let allSucceeded = true;
  for (const id of ids) {
    const result = normalizeIssueResult(
      await runner(operation, [id, ...flags], projectRoot, opts),
      operation,
    );
    const entry = { id, success: result.success === true };
    if (!entry.success) {
      allSucceeded = false;
      if (result.error) entry.error = result.error;
    }
    summary.push(entry);
  }
  return {
    success: allSucceeded,
    operation,
    output: JSON.stringify(summary, null, 2),
  };
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

    // Kernel batch close: >1 leading positional id → one runner call per id,
    // aggregated. A single id falls through to the byte-identical single path.
    if (subcommand === 'close' && shouldUseKernelBroker(opts)) {
      const { ids, flags } = splitLeadingIds(operationArgs);
      if (ids.length > 1) {
        return runKernelBatchClose(runner, operation, ids, flags, projectRoot, opts);
      }
    }

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
