'use strict';

/**
 * CLI kernel broker factory.
 *
 * Assembles the kernel issue `deps` the CLI path needs so `createKernelIssueBackend`
 * (lib/forge-issues.js) can construct a working broker:
 *
 *   B1 — No real driver on the CLI path. We construct `createBuiltinSQLiteDriver`
 *        and inject it as `kernelDriver`, so the broker stops hitting
 *        `requireGuardedDriverMethods(undefined)`.
 *   B2 — Migrations never run on the runtime path. `ensureKernelMigrated` wraps
 *        `broker.initialize()` (pragmas + idempotent migration DDL).
 *
 * The factory does NOT change `createKernelIssueBackend`'s contract — it only
 * supplies the `deps.kernelDriver` / `deps.kernelDatabasePath` it already reads.
 *
 * D19 coordination: the filesystem-doctor (read-only DB-location check) belongs
 * just before the driver opens the file. We expose `resolveKernelDatabasePath`
 * as that seam — D19 hooks the path, this factory does not reimplement it.
 *
 * @module kernel/cli-broker-factory
 */

const path = require('node:path');
const {
  createBuiltinSQLiteDriver,
  selectBuiltinSQLiteRuntime,
} = require('./sqlite-driver');
const { resolveGitCommonDir, createLocalBroker } = require('./broker');

const KERNEL_DB_FILE = 'kernel.sqlite';
const KERNEL_DB_SUBDIR = 'forge';

/**
 * Resolve the kernel database path. Mirrors `buildLocalBrokerConfig`:
 * explicit `databasePath` wins; otherwise `<gitCommonDir>/forge/kernel.sqlite`,
 * where `gitCommonDir` defaults to the resolved git common dir for `projectRoot`.
 *
 * @param {Object} options
 * @param {string} [options.projectRoot]
 * @param {string} [options.gitCommonDir]
 * @param {string} [options.databasePath]
 * @returns {string}
 */
function resolveKernelDatabasePath(options = {}) {
  if (typeof options.databasePath === 'string' && options.databasePath) {
    return options.databasePath;
  }
  const gitCommonDir = options.gitCommonDir
    || resolveGitCommonDir(options.projectRoot, options);
  return path.join(gitCommonDir, KERNEL_DB_SUBDIR, KERNEL_DB_FILE);
}

/**
 * Build the kernel issue deps for the CLI path.
 *
 * @param {Object} options
 * @param {string} [options.projectRoot] - Repo root (used to resolve the git common dir).
 * @param {string} [options.gitCommonDir] - Git common dir (overrides resolution).
 * @param {string} [options.databasePath] - Explicit kernel DB path (overrides default).
 * @param {Object} [options.runtime] - Pre-selected SQLite runtime (tests inject this).
 * @param {Function} [options.requireModule] - Module loader for runtime detection (tests).
 * @returns {{ useKernelBroker: true, kernelDriver: Object, kernelDatabasePath: string, gitCommonDir?: string }}
 * @throws {Error} when no builtin SQLite runtime is available (message names the runtimes).
 */
function buildKernelIssueDeps(options = {}) {
  const databasePath = resolveKernelDatabasePath(options);
  const runtime = options.runtime
    || selectBuiltinSQLiteRuntime({ requireModule: options.requireModule });

  const kernelDriver = createBuiltinSQLiteDriver({ databasePath, runtime });

  return {
    useKernelBroker: true,
    kernelDriver,
    kernelDatabasePath: databasePath,
    gitCommonDir: options.gitCommonDir,
  };
}

/**
 * Run the broker's migrations/pragmas (B2). Idempotent: per-invocation policy —
 * the CLI process is short-lived and `broker.initialize()` swallows
 * duplicate-column DDL, so calling it on every kernel CLI invocation is safe.
 *
 * @param {{ initialize?: Function }} broker
 * @returns {Promise<Object>} the broker.initialize() result.
 * @throws {Error} when the broker cannot be initialized.
 */
async function ensureKernelMigrated(broker) {
  if (!broker || typeof broker.initialize !== 'function') {
    throw new Error('Cannot initialize kernel broker: broker is missing initialize().');
  }
  return broker.initialize();
}

/**
 * Build the kernel deps AND a migrated broker ready for issue ops. Constructs the
 * driver (B1), builds the broker over it, runs `broker.initialize()` so pragmas +
 * migrations are applied (B2), and returns deps carrying the initialized broker as
 * `kernelBroker` — which `createKernelIssueBackend` (forge-issues.js) uses directly
 * instead of constructing a second broker.
 *
 * @param {Object} options - Same shape as buildKernelIssueDeps.
 * @returns {Promise<{ useKernelBroker: true, kernelBroker: Object, kernelDriver: Object, kernelDatabasePath: string }>}
 */
async function buildMigratedKernelIssueDeps(options = {}) {
  const deps = buildKernelIssueDeps(options);
  const broker = createLocalBroker({
    projectRoot: options.projectRoot,
    gitCommonDir: options.gitCommonDir,
    databasePath: deps.kernelDatabasePath,
    driver: deps.kernelDriver,
  });
  await ensureKernelMigrated(broker);
  return {
    useKernelBroker: true,
    kernelBroker: broker,
    kernelDriver: deps.kernelDriver,
    kernelDatabasePath: deps.kernelDatabasePath,
  };
}

module.exports = {
  buildKernelIssueDeps,
  buildMigratedKernelIssueDeps,
  ensureKernelMigrated,
  resolveKernelDatabasePath,
};
