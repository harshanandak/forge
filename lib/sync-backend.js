'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * SyncBackend resolver + seam.
 *
 * This is the single seam between `forge` sync-aware commands and whatever moves
 * Kernel state off this machine. It deliberately mirrors `lib/issue-backend.js`
 * (the storage resolver) so sync selection follows the same precedence and the
 * server era is a backend swap, not a rewrite.
 *
 * Precedence (highest first):
 *   explicit deps.syncBackend > FORGE_SYNC_BACKEND env > .forge/config.yaml
 *   `syncBackend` > 'local-noop'.
 *
 * Implementations:
 *   - 'local-noop' (default, ships now): the local kernel is single-machine
 *     authority; sync is a graceful, honest no-op that names the model.
 *   - 'git-jsonl' (TODO — first real backend): drain the projection outbox to
 *     committable `.forge/kernel/*.jsonl` and re-import on pull, per
 *     docs/work/2026-06-26-sync-authority/design.md §3/§5. Not implemented yet
 *     because its push/pull ride the kernel broker (a separate lane).
 *   - 'server' (TODO — future): push/pull/status against the Forge server.
 *
 * See docs/work/2026-06-26-sync-authority/design.md for the full contract.
 *
 * @module sync-backend
 */

const VALID_BACKENDS = new Set(['local-noop', 'git-jsonl', 'server']);
const DEFAULT_BACKEND = 'local-noop';
const ENV_VAR = 'FORGE_SYNC_BACKEND';

const LOCAL_NOOP_MESSAGE =
  'Local kernel is single-machine authority; no remote configured.';

/**
 * Read the `syncBackend` key from `<projectRoot>/.forge/config.yaml`, if the
 * file exists and is parseable. Returns `null` when the file is missing, the
 * key is absent, or the YAML cannot be parsed. Never throws.
 *
 * @param {string|undefined} projectRoot
 * @returns {string|null}
 */
function readConfigBackend(projectRoot) {
  if (!projectRoot) {
    return null;
  }

  const configPath = path.join(projectRoot, '.forge', 'config.yaml');
  if (!fs.existsSync(configPath)) {
    return null;
  }

  let parsed;
  try {
    // Lazy-require so the default (no-config) sync path imports no YAML parser at
    // module load — only a project that actually ships .forge/config.yaml pays for it.
    const YAML = require('yaml');
    parsed = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // A malformed config file should not crash sync commands; treat as absent.
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const value = parsed.syncBackend;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Gather a candidate backend value (without validation) following the documented
 * precedence: explicit deps > env > config. Returns `{ value, source }` or
 * `{ value: null, source: null }` when no signal exists.
 */
function collectBackendSignal({ deps = {}, env = process.env, projectRoot } = {}) {
  if (typeof deps.syncBackend === 'string' && deps.syncBackend.trim()) {
    return { value: deps.syncBackend.trim(), source: 'deps' };
  }

  const envValue = env && env[ENV_VAR];
  if (typeof envValue === 'string' && envValue.trim()) {
    return { value: envValue.trim(), source: 'env' };
  }

  const configValue = readConfigBackend(projectRoot);
  if (configValue) {
    return { value: configValue, source: 'config' };
  }

  return { value: null, source: null };
}

/**
 * Resolve the active sync backend name by precedence:
 *   explicit deps.syncBackend > FORGE_SYNC_BACKEND env > .forge/config.yaml > 'local-noop'.
 *
 * An unknown value (from any source) falls back to the default backend and emits
 * a warning via the injected `warn` callback (defaults to console.warn).
 *
 * @param {object} [options]
 * @param {object} [options.deps]
 * @param {object} [options.env]
 * @param {string} [options.projectRoot]
 * @param {function(string): void} [options.warn]
 * @returns {'local-noop'|'git-jsonl'|'server'}
 */
function resolveSyncBackend({
  deps = {},
  env = process.env,
  projectRoot,
  warn = console.warn,
} = {}) {
  const { value } = collectBackendSignal({ deps, env, projectRoot });

  if (!value) {
    return DEFAULT_BACKEND;
  }

  const normalized = value.toLowerCase();
  if (VALID_BACKENDS.has(normalized)) {
    return normalized;
  }

  warn(
    `Unknown sync backend "${value}" — falling back to "${DEFAULT_BACKEND}". ` +
      `Valid values: ${[...VALID_BACKENDS].join(', ')}.`,
  );
  return DEFAULT_BACKEND;
}

/**
 * LocalNoopSyncBackend — the default backend shipped today.
 *
 * The local kernel (SQLite WAL in the git common dir) is the single-machine
 * authority, so there is nothing to push or pull until a remote/server is
 * configured. Every method is async and returns a plain result object; none
 * throw for the "nothing configured" case — that path must stay a graceful
 * no-op.
 */
const LocalNoopSyncBackend = {
  name: 'local-noop',

  /** One-shot convenience used by `forge sync`. */
  async sync() {
    return { success: true, synced: false, message: LOCAL_NOOP_MESSAGE };
  },

  /** No remote configured — nothing to push. */
  async push() {
    return { pushed: 0, accepted: [], duplicate: [], quarantine: [] };
  },

  /** No remote configured — nothing to pull. */
  async pull() {
    return { pulled: 0, appliedThrough: null };
  },

  /** Health/info for `forge doctor`, preflight, setup. */
  async status() {
    return { configured: false, endpoint: undefined, cursor: null, ahead: 0, behind: 0 };
  },
};

/**
 * Construct the SyncBackend instance for the resolved (or supplied) backend name.
 *
 * Only `local-noop` ships today. `git-jsonl` and `server` are the documented
 * swap targets and throw a clear "not implemented" error until their PRs land
 * (see design.md §3/§5) — rather than silently degrading, so an operator who
 * explicitly selected one is told the truth.
 *
 * @param {object} [options] - Same shape as resolveSyncBackend, plus `backend`
 *   to bypass resolution.
 * @returns {typeof LocalNoopSyncBackend}
 */
function createSyncBackend(options = {}) {
  const name = options.backend || resolveSyncBackend(options);

  if (name === 'local-noop') {
    return LocalNoopSyncBackend;
  }

  throw new Error(
    `Sync backend "${name}" is not implemented yet. ` +
      `Only "local-noop" ships today; "git-jsonl" and "server" are the documented ` +
      `swap targets (see docs/work/2026-06-26-sync-authority/design.md §3/§5).`,
  );
}

module.exports = {
  resolveSyncBackend,
  createSyncBackend,
  LocalNoopSyncBackend,
  DEFAULT_BACKEND,
  VALID_BACKENDS,
};
