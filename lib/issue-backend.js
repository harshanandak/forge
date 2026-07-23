'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VALID_BACKENDS = new Set(['kernel']);
const DEFAULT_BACKEND = 'kernel';
const ENV_VAR = 'FORGE_ISSUE_BACKEND';

// Backends that Forge used to accept and has since retired. Kept as an explicit set
// (rather than folding them into the generic "unknown backend" path) so a user who
// still carries `issueBackend: beads` in config — or `FORGE_ISSUE_BACKEND=beads` in a
// shell profile — gets the ONE actionable instruction instead of a bare valid-values
// list: import the Beads store into the kernel.
const REMOVED_BACKENDS = new Set(['beads']);

// The single migrate pointer shared by every removed-backend surface (the resolver's
// warning and the CLI flag's hard error) so the two can never drift.
const BEADS_REMOVED_HINT =
  'the beads backend was removed; run `forge migrate --from beads` to import a Beads store into the kernel';

/**
 * The migrate-pointer hint for a retired backend value, or null when the value is
 * not a retired backend (callers then use the generic unknown-backend wording).
 *
 * @param {string} value
 * @returns {string|null}
 */
function removedBackendHint(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return REMOVED_BACKENDS.has(normalized) ? BEADS_REMOVED_HINT : null;
}

/**
 * Read the `issueBackend` key from `<projectRoot>/.forge/config.yaml`, if the
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
    // Lazy-require so the default (no-config) issue path imports no YAML parser at
    // module load — only a project that actually ships .forge/config.yaml pays for it.
    const YAML = require('yaml');
    parsed = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // A malformed config file should not crash issue commands; treat as absent.
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const value = parsed.issueBackend;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Gather a candidate backend value (without validation) following the documented
 * precedence: explicit deps > env > config. Returns `{ value, source }` or
 * `{ value: null, source: null }` when no signal exists.
 */
function collectBackendSignal({ deps = {}, env = process.env, projectRoot } = {}) {
  if (typeof deps.issueBackend === 'string' && deps.issueBackend.trim()) {
    return { value: deps.issueBackend.trim(), source: 'deps' };
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
 * Resolve the active issue backend by precedence:
 *   explicit deps.issueBackend > FORGE_ISSUE_BACKEND env > .forge/config.yaml > 'kernel'.
 *
 * An unknown value (from any source) falls back to the default backend and emits
 * a warning via the injected `warn` callback (defaults to console.warn). A RETIRED
 * value (`beads`) takes the same fallback path but warns with the migrate pointer,
 * because "unknown backend, valid backends: kernel" would not tell a user carrying
 * `issueBackend: beads` in config what to actually do about it.
 *
 * @param {object} [options]
 * @param {object} [options.deps]
 * @param {object} [options.env]
 * @param {string} [options.projectRoot]
 * @param {function(string): void} [options.warn]
 * @returns {'kernel'}
 */
function resolveIssueBackend({
  deps = {},
  env = process.env,
  projectRoot,
  warn = console.warn,
} = {}) {
  const { value, source } = collectBackendSignal({ deps, env, projectRoot });

  if (!value) {
    return DEFAULT_BACKEND;
  }

  const normalized = value.toLowerCase();
  if (VALID_BACKENDS.has(normalized)) {
    return normalized;
  }

  const removedHint = removedBackendHint(normalized);
  if (removedHint) {
    warn(
      `Issue backend "${value}" from ${source} is no longer available: ${removedHint}. `
      + `Falling back to "${DEFAULT_BACKEND}".`,
    );
    return DEFAULT_BACKEND;
  }

  warn(
    `Unknown issue backend "${value}" from ${source}; `
    + `falling back to "${DEFAULT_BACKEND}". Valid backends: ${[...VALID_BACKENDS].join(', ')}.`,
  );
  return DEFAULT_BACKEND;
}

/**
 * Returns true when an explicit backend signal exists in any source (deps, env,
 * or config) — regardless of whether the value is valid. Used by the CLI to
 * decide whether to inject a resolved backend into command opts, so the default
 * (no-signal) path stays byte-identical and opt-in.
 *
 * @param {object} [options] — same shape as resolveIssueBackend options.
 * @returns {boolean}
 */
function hasExplicitBackendSignal(options = {}) {
  return collectBackendSignal(options).value !== null;
}

/**
 * Returns true when the active selection routes to the Kernel broker. Centralized
 * in the backend-authority module so the command layer (_issue.js) and the issue
 * service (forge-issues.js) share ONE definition and cannot drift. Accepts either
 * CLI command opts or service deps — both carry the same selection keys.
 *
 * Note: this is an exact `=== 'kernel'` check, so callers must pass an already
 * normalized backend value (use resolveIssueBackend to normalize case/validate).
 *
 * @param {object} [opts]
 * @returns {boolean}
 */
function shouldUseKernelBroker(opts = {}) {
  return Boolean(opts.useKernelBroker || opts.kernelBroker || opts.issueBackend === 'kernel');
}

module.exports = {
  resolveIssueBackend,
  hasExplicitBackendSignal,
  shouldUseKernelBroker,
  readConfigBackend,
  removedBackendHint,
  VALID_BACKENDS,
  REMOVED_BACKENDS,
  BEADS_REMOVED_HINT,
  DEFAULT_BACKEND,
  ENV_VAR,
};
