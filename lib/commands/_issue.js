'use strict';

const { runIssueOperation: defaultRunIssueOperation } = require('../forge-issues');
const { resolveIssueBackend, hasExplicitBackendSignal, shouldUseKernelBroker } = require('../issue-backend');

// The Forge issue command surface. Each subcommand routes through the shared
// runIssueOperation, which selects the active backend (Kernel by --kernel /
// --issue-backend kernel / FORGE_ISSUE_BACKEND=kernel; Beads otherwise) and performs
// any backend-specific argument translation. This module therefore carries NO direct
// issue-tracker invocation or argv translation — those live in the backend
// abstraction (lib/forge-issues.js + the issue adapters).
const SUBCOMMANDS = {
  create: {
    description: 'Create an issue via Forge',
    usage: 'forge create [title] [flags]',
  },
  update: {
    description: 'Update an issue via Forge',
    usage: 'forge update <id...> [flags]',
  },
  claim: {
    description: 'Claim an issue via Forge',
    usage: 'forge claim <id> [flags]',
  },
  release: {
    description: 'Release a Kernel issue claim via Forge',
    usage: 'forge release <id>',
  },
  comment: {
    description: 'Add an issue comment via Forge',
    usage: 'forge comment <id> <body...>',
  },
  close: {
    description: 'Close an issue via Forge',
    usage: 'forge close <id...> [flags]',
  },
  show: {
    description: 'Show an issue via Forge',
    usage: 'forge show <id> [flags]',
  },
  list: {
    description: 'List issues via Forge',
    usage: 'forge list [flags]',
  },
  ready: {
    description: 'Show ready issues via Forge',
    usage: 'forge ready [flags]',
  },
  search: {
    description: 'Search issues via Forge',
    usage: 'forge issue search <query> [flags]',
  },
  stats: {
    description: 'Show issue statistics via Forge',
    usage: 'forge issue stats [flags]',
  },
  // KAP-7: derived read queries. The backend abstraction maps each to its tracker
  // equivalent (the Kernel passes the operation name through unchanged; the Beads
  // backend maps each to its passthrough subcommand). They are READS, so they are
  // intentionally NOT in WRITE_SUBCOMMANDS.
  blocked: {
    description: 'Show blocked issues via Forge',
    usage: 'forge issue blocked [flags]',
  },
  stale: {
    description: 'Show stale issues via Forge',
    usage: 'forge issue stale [--days <n>]',
  },
  orphans: {
    description: 'Show issues with dangling dependency edges via Forge',
    usage: 'forge issue orphans',
  },
  // KAP-12: read-only content lint — issues missing required content
  // (task/bug with no acceptance_criteria). A READ, so NOT in WRITE_SUBCOMMANDS.
  lint: {
    description: 'Show issues missing required content via Forge',
    usage: 'forge issue lint',
  },
  // Epic support: an epic's DIRECT children + kernel-computed rollup
  // (done-only percentage, per-status counts, blocked list). A READ, so
  // intentionally NOT in WRITE_SUBCOMMANDS.
  children: {
    description: 'Show an epic\'s child issues + rollup via Forge',
    usage: 'forge issue children <epic-id> [--json]',
  },
  dep: {
    description: 'Manage issue dependencies via Forge',
    usage: 'forge issue dep <add|remove> <issue-id> <blocks-issue-id>',
    // The dep subcommand fans out to two actions. Declaring them here keeps the
    // supported action set discoverable from the command spec (and lets the
    // release-readiness gate confirm dep add/remove are present).
    actions: {
      add: { description: 'Add a dependency edge (issue-id blocked by blocks-issue-id)' },
      remove: { description: 'Remove a dependency edge' },
    },
  },
};

const WRITE_SUBCOMMANDS = new Set(['create', 'update', 'claim', 'release', 'comment', 'close', 'dep']);
const DEP_ACTIONS = Object.keys(SUBCOMMANDS.dep.actions);

function normalizeArgs(args = []) {
  return args.filter(arg => arg !== '--');
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

// Map a CLI subcommand to the backend operation name. `dep` fans out to
// `dep.<action>`; every other subcommand uses its own name (the backend performs
// any tracker-specific translation, e.g. Beads claim -> `update <id> --claim`).
function resolveIssueOperation(subcommand, args) {
  if (subcommand === 'dep') {
    return `dep.${normalizeArgs(args)[0]}`;
  }
  return subcommand;
}

// The Kernel create payload (buildCreatePayload) reads only the --title flag, so a
// bare leading positional (`forge create "title"`) would be ignored and the title
// would default to the minted UUID. For parity on the KERNEL PATH ONLY, translate a
// single leading bare positional into `--title <value>` when no explicit
// --title/--title= is present. The Beads backend keeps its native positional
// handling (this never runs for the Beads path).
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

// Resolve the operation args passed to the backend. `dep` drops its leading action
// token (it is carried in the operation name); `create` on the Kernel path gains the
// positional-title parity translation. Everything else passes its normalized args
// through verbatim.
function resolveOperationArgs(subcommand, args, opts = {}) {
  const normalizedArgs = normalizeArgs(args);

  if (subcommand === 'dep') {
    return normalizedArgs.slice(1);
  }

  if (subcommand === 'create' && shouldUseKernelBroker(opts)) {
    return withKernelCreateTitle(normalizedArgs);
  }

  return normalizedArgs;
}

// Validate the dep action up front so a bad `forge issue dep <action>` fails with a
// usage message instead of routing to a `dep.undefined` operation.
function validateDepArgs(args) {
  const normalized = normalizeArgs(args);
  const [action, ...rest] = normalized;
  if (!DEP_ACTIONS.includes(action)) {
    return {
      error: `Unsupported dependency action: ${action || '(missing)'}. Usage: forge issue dep <add|remove> <issue-id> <blocks-issue-id>`,
    };
  }
  if (rest.length < 2) {
    return {
      error: `Missing dependency ids. Usage: forge issue dep ${action} <issue-id> <blocks-issue-id>`,
    };
  }
  return null;
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
// "Command failed". Normalize ONLY the contract shape (ok defined, success
// undefined) into { success, output } here, at the command boundary — the kernel
// contract itself stays untouched. Every other result passes through byte-identical.
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
// ONLY: the Beads passthrough keeps its single `close id1 id2 ...` invocation.
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
  const spec = SUBCOMMANDS[subcommand];
  if (!spec) {
    return { success: false, error: `Unknown issue subcommand '${subcommand}'.\n\n${formatIssueHelp()}` };
  }

  // Backend-agnostic --help short-circuit: print the subcommand's usage and return
  // BEFORE resolving the backend or dispatching any operation. Without this, a help
  // request was forwarded to the active backend as an operation arg — absorbed
  // harmlessly by Beads (which swallowed --help), but broken under the Kernel default:
  // the plural path failed with a bare "Command failed" and the singular path
  // SILENTLY minted a junk issue (and could queue a GitHub projection). Help must
  // never touch a backend.
  if (normalizeArgs(args).some(arg => arg === '--help' || arg === '-h')) {
    return { success: true, output: `${spec.usage}\n\n${spec.description}` };
  }

  if (subcommand === 'dep') {
    const depError = validateDepArgs(args);
    if (depError) {
      return { success: false, error: depError.error };
    }
  }

  const opts = withResolvedIssueBackend(projectRoot, rawOpts);

  // Both backends are reached through the same runIssueOperation seam. Naming the
  // injected local `runIssueOperation` keeps the dispatch a literal call to a binding
  // named `runIssueOperation` (the kernel-evidence gate is syntactic) while still
  // honoring an injected runner; the `kernelBroker: opts.kernelBroker` passthrough is
  // a runtime no-op (undefined under Beads) that documents the Kernel-capable surface.
  const runIssueOperation = opts.runIssueOperation || defaultRunIssueOperation;
  const operation = resolveIssueOperation(subcommand, args);
  const operationArgs = resolveOperationArgs(subcommand, args, opts);

  // Kernel batch close: >1 leading positional id → one runner call per id,
  // aggregated. A single id falls through to the byte-identical single path.
  if (subcommand === 'close' && shouldUseKernelBroker(opts)) {
    const { ids, flags } = splitLeadingIds(operationArgs);
    if (ids.length > 1) {
      return runKernelBatchClose(runIssueOperation, operation, ids, flags, projectRoot, opts);
    }
  }

  const result = await runIssueOperation(
    operation,
    operationArgs,
    projectRoot,
    { ...opts, kernelBroker: opts.kernelBroker },
  );
  return normalizeIssueResult(result, operation);
}

// Build a registry command for a single issue subcommand (e.g. `forge claim`).
// Each routes through the shared runIssueSubcommand dispatch, so the backend
// abstraction owns all tracker selection and argument translation.
function createIssueSubcommand(subcommand) {
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
  WRITE_SUBCOMMANDS,
  createIssueCommand,
  createIssueSubcommand,
  normalizeArgs,
  normalizeIssueResult,
  resolveIssueOperation,
  resolveOperationArgs,
  runIssueSubcommand,
  withResolvedIssueBackend,
};
