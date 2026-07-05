'use strict';

/**
 * Resolve the per-command opts object that bin/forge.js threads to the registry
 * handler (the 4th arg). For issue/alias commands this:
 *
 *   1. Strips the selector tokens (`--kernel`, `--issue-backend <val>`) from the
 *      args BEFORE they reach the handler / bd. This is load-bearing: bin
 *      parseFlags() early-returns for issue passthrough commands, so these tokens
 *      otherwise flow untouched into the handler and (beads path) into bd, which
 *      rejects the unknown flag — and the positional `kernel`/`beads` value would
 *      be mistaken for an issue id.
 *   2. Resolves the backend (flag > env > config > default) via the backend
 *      authority module (lib/issue-backend.js). The CLI flag tokens are mapped to
 *      that module's `deps.issueBackend` signal; env/config/default precedence is
 *      applied by the resolver itself.
 *   3. When kernel, assembles the kernel deps (driver + flag) via the CLI broker
 *      factory so createKernelIssueBackend has a real driver (B1).
 *
 * Kernel-native tool commands (KERNEL_TOOL_COMMANDS, e.g. `export`) instead get a
 * migrated Kernel broker injected as `_broker` (independent of the selector), and
 * all other non-issue commands get an empty opts object and untouched args.
 *
 * @module commands/resolve-command-opts
 */

const { resolveIssueBackend } = require('../issue-backend');
const {
  buildMigratedKernelIssueDeps: defaultBuildKernelIssueDeps,
} = require('../kernel/cli-broker-factory');

// Commands that route issue operations and therefore honor the selector. Mirrors
// the alias wrappers in lib/commands/ plus the `issue`/`issues` grouping commands.
const ISSUE_COMMANDS = new Set([
  'create',
  'update',
  'claim',
  'release',
  'comment',
  'close',
  'show',
  'list',
  'ready',
  'blocked',
  'stale',
  'orphans',
  'lint',
  // Epic grouping read — must be kernel-routed (its issue.children rollup has no
  // verified Beads equivalent), so it belongs in ISSUE_COMMANDS like the rest.
  'children',
  // Lease-ownership verification — a kernel-only read (leases live in the Kernel),
  // so it is kernel-routed like the rest of the issue surface.
  'owns',
  'search',
  'stats',
  'dep',
  'issue',
  'issues',
]);

// Kernel-native tool commands that operate directly on the Kernel regardless of the
// issue-backend selector, so they need a real (migrated) Kernel broker injected as
// the handler's `_broker`. `export` drains the Kernel projection outbox to
// git-tracked JSONL (D16); without an injected broker its handler always reports
// "No Kernel broker available" and writes nothing.
const KERNEL_TOOL_COMMANDS = new Set([
  'export',
]);

const ISSUE_BACKEND_FLAG = '--issue-backend';
const KERNEL_FLAG = '--kernel';
const KERNEL = 'kernel';

/**
 * Remove the issue-backend selector tokens from an args array and report what
 * they selected. Handles `--kernel`, `--issue-backend <val>` (space form), and
 * `--issue-backend=<val>` (= form). All other tokens pass through unchanged.
 *
 * @param {string[]} rawArgs
 * @returns {{ args: string[], flags: { kernel?: boolean, issueBackend?: string } }}
 */
function stripSelectorTokens(rawArgs = []) {
  const args = [];
  const flags = {};
  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    if (token === KERNEL_FLAG) {
      flags.kernel = true;
      continue;
    }
    if (token === ISSUE_BACKEND_FLAG) {
      // Space form: consume the following value token as the backend name. Only a
      // non-flag token counts — a missing value or a following flag (e.g.
      // `--issue-backend --reason=x`) must throw rather than silently swallow the
      // next flag and fall back to the default backend.
      const next = rawArgs[i + 1];
      if (typeof next === 'string' && !next.startsWith('--')) {
        flags.issueBackend = next;
        i += 1;
      } else {
        throw new Error(`${ISSUE_BACKEND_FLAG} requires a value: kernel or beads.`);
      }
      continue;
    }
    if (typeof token === 'string' && token.startsWith(`${ISSUE_BACKEND_FLAG}=`)) {
      // Equals form: reject an empty value (`--issue-backend=`) for the same reason.
      const value = token.slice(ISSUE_BACKEND_FLAG.length + 1).trim();
      if (!value) {
        throw new Error(`${ISSUE_BACKEND_FLAG} requires a value: kernel or beads.`);
      }
      flags.issueBackend = value;
      continue;
    }
    args.push(token);
  }
  return { args, flags };
}

/**
 * Reduce the stripped selector flags to a single explicit backend value (or null
 * when no flag selects one), honoring `--kernel` / `--issue-backend` equivalence
 * and rejecting a mutually-exclusive conflict. Returned values are NOT validated
 * here — the backend authority module normalizes/warns on unknown values.
 *
 * @param {{ kernel?: boolean, issueBackend?: string }} flags
 * @returns {string|null}
 * @throws {Error} when --kernel and --issue-backend select different backends.
 */
function resolveFlagBackend(flags = {}) {
  const fromBackend = typeof flags.issueBackend === 'string' && flags.issueBackend.trim()
    ? flags.issueBackend.trim()
    : null;
  const fromKernel = flags.kernel === true ? KERNEL : null;

  if (fromKernel && fromBackend && fromKernel !== fromBackend.toLowerCase()) {
    throw new Error(
      `Conflicting issue backend flags: --kernel selects '${KERNEL}' but `
      + `--issue-backend selects '${fromBackend}'. These are mutually exclusive.`,
    );
  }

  return fromKernel || fromBackend || null;
}

/**
 * Resolve the command opts and selector-stripped args for a dispatched command.
 *
 * @param {string} command - The command name (e.g. 'close').
 * @param {string[]} rawArgs - The command args (already `args.slice(1)`).
 * @param {Object} [deps]
 * @param {Object} [deps.env] - Environment snapshot (default process.env).
 * @param {string} [deps.projectRoot] - Repo root for env/config resolution + kernel DB.
 * @param {Function} [deps.buildKernelIssueDeps] - Factory override (tests). May be
 *   sync or async; its result is awaited.
 * @returns {Promise<{ commandOpts: Object, args: string[] }>}
 * @throws {Error} on conflicting flags (surfaced to user).
 */
async function resolveCommandOpts(command, rawArgs = [], deps = {}) {
  const buildKernelIssueDeps = deps.buildKernelIssueDeps || defaultBuildKernelIssueDeps;

  if (KERNEL_TOOL_COMMANDS.has(command)) {
    // Kernel-native tools (e.g. `export`) always get a migrated Kernel broker the
    // same way issue commands do (the CLI broker factory builds the driver, builds
    // the broker, and runs initialize()). The handler consumes it as `_broker`.
    // If no broker can be built (e.g. no SQLite runtime) we fall through with no
    // broker so the handler skips gracefully rather than hard-failing — these tools
    // are explicitly non-fatal when the Kernel is unavailable.
    try {
      const kernelDeps = await buildKernelIssueDeps({
        projectRoot: deps.projectRoot,
        databasePath: deps.databasePath,
        gitCommonDir: deps.gitCommonDir,
      });
      return { commandOpts: { _broker: kernelDeps.kernelBroker }, args: rawArgs };
    } catch {
      return { commandOpts: {}, args: rawArgs };
    }
  }

  if (!ISSUE_COMMANDS.has(command)) {
    return { commandOpts: {}, args: rawArgs };
  }

  const env = deps.env || process.env;

  const { args, flags } = stripSelectorTokens(rawArgs);
  const flagBackend = resolveFlagBackend(flags);
  const issueBackend = resolveIssueBackend({
    deps: flagBackend ? { issueBackend: flagBackend } : {},
    env,
    projectRoot: deps.projectRoot,
  });

  if (issueBackend !== KERNEL) {
    return {
      commandOpts: {
        issueBackend,
        useKernelBroker: false,
      },
      args,
    };
  }

  // Kernel backend: assemble the driver (B1) + migrated broker (B2). The factory
  // builder constructs the driver, builds the broker, and runs initialize().
  const kernelDeps = await buildKernelIssueDeps({
    projectRoot: deps.projectRoot,
    databasePath: deps.databasePath,
    gitCommonDir: deps.gitCommonDir,
  });

  // Safety net: the kernel is the default backend, but onboarding auto-migrate runs
  // only from `forge setup`/`init`. An existing repo whose user merely upgrades forge
  // would read an EMPTY kernel here and their existing Beads issues would appear to
  // vanish. Import them ONCE on first kernel use (idempotent, sentinel next to the DB,
  // stderr only). Wrapped so a safety-net failure NEVER breaks command-opts resolution.
  const autoMigrate = deps.autoMigrateBeadsAtRuntime
    || require('./migrate').autoMigrateBeadsAtRuntime;
  try {
    await autoMigrate({
      projectRoot: deps.projectRoot,
      databasePath: kernelDeps.kernelDatabasePath,
      broker: kernelDeps.kernelBroker,
    });
  } catch {
    // The command must run even if the one-time import hook throws.
  }

  return {
    commandOpts: {
      issueBackend: KERNEL,
      ...kernelDeps,
    },
    args,
  };
}

module.exports = {
  resolveCommandOpts,
  stripSelectorTokens,
  resolveFlagBackend,
  ISSUE_COMMANDS,
  KERNEL_TOOL_COMMANDS,
};
