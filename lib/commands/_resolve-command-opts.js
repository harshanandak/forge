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
 *   2. Resolves the backend (flag > env > config > default) via the selector.
 *   3. When kernel, assembles the kernel deps (driver + flag) via the CLI broker
 *      factory so createKernelIssueBackend has a real driver (B1).
 *
 * Non-issue commands get an empty opts object and untouched args.
 *
 * @module commands/resolve-command-opts
 */

const { resolveIssueBackend } = require('../issue-backend-selector');
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
  'search',
  'stats',
  'dep',
  'issue',
  'issues',
]);

const ISSUE_BACKEND_FLAG = '--issue-backend';
const KERNEL_FLAG = '--kernel';

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
      // Space form: consume the following value token as the backend name.
      const next = rawArgs[i + 1];
      if (typeof next === 'string') {
        flags.issueBackend = next;
        i += 1;
      }
      continue;
    }
    if (typeof token === 'string' && token.startsWith(`${ISSUE_BACKEND_FLAG}=`)) {
      flags.issueBackend = token.slice(ISSUE_BACKEND_FLAG.length + 1);
      continue;
    }
    args.push(token);
  }
  return { args, flags };
}

/**
 * Resolve the command opts and selector-stripped args for a dispatched command.
 *
 * @param {string} command - The command name (e.g. 'close').
 * @param {string[]} rawArgs - The command args (already `args.slice(1)`).
 * @param {Object} [deps]
 * @param {Object} [deps.env] - Environment snapshot (default process.env).
 * @param {Object} [deps.config] - Config snapshot (.forge issueBackend section).
 * @param {string} [deps.projectRoot] - Repo root for kernel DB resolution.
 * @param {Function} [deps.buildKernelIssueDeps] - Factory override (tests). May be
 *   sync or async; its result is awaited.
 * @returns {Promise<{ commandOpts: Object, args: string[] }>}
 * @throws {Error} on conflicting flags or unknown backend values (surfaced to user).
 */
async function resolveCommandOpts(command, rawArgs = [], deps = {}) {
  if (!ISSUE_COMMANDS.has(command)) {
    return { commandOpts: {}, args: rawArgs };
  }

  const env = deps.env || process.env;
  const config = deps.config || {};
  const buildKernelIssueDeps = deps.buildKernelIssueDeps || defaultBuildKernelIssueDeps;

  const { args, flags } = stripSelectorTokens(rawArgs);
  const resolution = resolveIssueBackend({ flags, env, config });

  if (resolution.issueBackend !== 'kernel') {
    return {
      commandOpts: {
        issueBackend: resolution.issueBackend,
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

  return {
    commandOpts: {
      issueBackend: 'kernel',
      ...kernelDeps,
    },
    args,
  };
}

module.exports = {
  resolveCommandOpts,
  stripSelectorTokens,
  ISSUE_COMMANDS,
};
