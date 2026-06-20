'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VALID_BACKENDS = new Set(['kernel', 'beads']);
const DEFAULT_BACKEND = 'beads';
const ENV_VAR = 'FORGE_ISSUE_BACKEND';

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
 *   explicit deps.issueBackend > FORGE_ISSUE_BACKEND env > .forge/config.yaml > 'beads'.
 *
 * An unknown value (from any source) falls back to the default backend and emits
 * a warning via the injected `warn` callback (defaults to console.warn).
 *
 * @param {object} [options]
 * @param {object} [options.deps]
 * @param {object} [options.env]
 * @param {string} [options.projectRoot]
 * @param {function(string): void} [options.warn]
 * @returns {'kernel'|'beads'}
 */
function resolveIssueBackend({
  deps = {},
  env = process.env,
  projectRoot,
  warn = (message) => console.warn(message),
} = {}) {
  const { value, source } = collectBackendSignal({ deps, env, projectRoot });

  if (!value) {
    return DEFAULT_BACKEND;
  }

  const normalized = value.toLowerCase();
  if (VALID_BACKENDS.has(normalized)) {
    return normalized;
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

module.exports = {
  resolveIssueBackend,
  hasExplicitBackendSignal,
  readConfigBackend,
  VALID_BACKENDS,
  DEFAULT_BACKEND,
  ENV_VAR,
};
