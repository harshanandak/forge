'use strict';

/**
 * Issue backend selector — pure resolver.
 *
 * Resolves which issue backend ('kernel' | 'beads') a CLI invocation targets,
 * from an explicit precedence chain: flag > env > config > default.
 *
 * No I/O: callers pass an already-read snapshot of flags/env/config. This keeps
 * the bin/forge.js wiring edit minimal (the D19 coordination point) and the
 * selector trivially testable.
 *
 * Output threads into the existing predicates unchanged — both
 * `lib/commands/_issue.js` `shouldUseKernelBroker(opts)` and
 * `lib/forge-issues.js` `shouldUseKernelBroker(deps)` already read
 * `issueBackend === 'kernel'` / `useKernelBroker`, so setting those keys lights
 * the kernel path up with zero predicate changes.
 *
 * @module issue-backend-selector
 */

const KERNEL = 'kernel';
const BEADS = 'beads';

/** Canonical backend names, lowest-to-highest precedence-agnostic. */
const VALID_BACKENDS = Object.freeze([BEADS, KERNEL]);

const ENV_VAR = 'FORGE_ISSUE_BACKEND';

function validList() {
  return VALID_BACKENDS.join(', ');
}

/**
 * Normalize and validate a raw backend value from any source.
 *
 * @param {*} raw - The raw value (flag/env/config).
 * @param {string} sourceLabel - Human label for error messages (e.g. '--issue-backend').
 * @returns {string|null} canonical backend name, or null if the value is absent/blank.
 * @throws {Error} when a non-blank value is not a recognized backend.
 */
function normalizeBackendValue(raw, sourceLabel) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new Error(
      `Invalid ${sourceLabel} value: expected a string backend name (${validList()}).`,
    );
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') {
    return null;
  }
  if (!VALID_BACKENDS.includes(trimmed)) {
    throw new Error(
      `Unknown ${sourceLabel} value '${raw}'. Valid values: ${validList()}.`,
    );
  }
  return trimmed;
}

/**
 * Resolve the backend named by CLI flags, honoring `--kernel`/`--issue-backend`
 * equivalence and rejecting a mutually-exclusive conflict.
 *
 * @param {Object} flags - Flag-like object: `{ kernel?: boolean, issueBackend?: string }`.
 * @returns {string|null} canonical backend name, or null when no flag selects one.
 */
function resolveFromFlags(flags = {}) {
  const fromBackend = normalizeBackendValue(flags.issueBackend, '--issue-backend');
  const fromKernel = flags.kernel === true ? KERNEL : null;

  if (fromKernel && fromBackend && fromKernel !== fromBackend) {
    throw new Error(
      `Conflicting issue backend flags: --kernel selects '${KERNEL}' but ` +
        `--issue-backend selects '${fromBackend}'. These are mutually exclusive.`,
    );
  }

  return fromKernel || fromBackend || null;
}

/**
 * Resolve the active issue backend from a flags/env/config snapshot.
 *
 * Precedence (highest first): flag > env > config > default('beads').
 *
 * @param {Object} [input]
 * @param {Object} [input.flags] - Parsed flag-like object.
 * @param {Object} [input.env] - Environment snapshot (e.g. process.env).
 * @param {Object} [input.config] - Config snapshot (e.g. .forge/config.yaml section).
 * @returns {{ issueBackend: string, useKernelBroker: boolean, source: ('flag'|'env'|'config'|'default') }}
 * @throws {Error} on conflicting flags or unknown values.
 */
function resolveIssueBackend({ flags = {}, env = {}, config = {} } = {}) {
  const fromFlag = resolveFromFlags(flags);
  if (fromFlag) {
    return decorate(fromFlag, 'flag');
  }

  const fromEnv = normalizeBackendValue(env[ENV_VAR], ENV_VAR);
  if (fromEnv) {
    return decorate(fromEnv, 'env');
  }

  const fromConfig = normalizeBackendValue(config.issueBackend, 'config issueBackend');
  if (fromConfig) {
    return decorate(fromConfig, 'config');
  }

  return decorate(BEADS, 'default');
}

function decorate(issueBackend, source) {
  return {
    issueBackend,
    useKernelBroker: issueBackend === KERNEL,
    source,
  };
}

module.exports = {
  resolveIssueBackend,
  VALID_BACKENDS,
  ENV_VAR,
};
