/**
 * @module run-bd
 * @description Wrapper around the `bd` (Beads) CLI for GitHub-Beads sync.
 *
 * Exports pure arg-building and output-parsing functions (unit-testable),
 * plus thin exec wrappers that shell out to the real `bd` binary.
 */

import { execFileSync } from 'node:child_process';

const EXEC_OPTS = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };

// ---------------------------------------------------------------------------
// Arg builders (pure)
// ---------------------------------------------------------------------------

/**
 * Build args array for `bd create`.
 * Omits flags whose values are null or undefined.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.type]
 * @param {number|string} [opts.priority]
 * @param {string} [opts.assignee]
 * @param {string} [opts.description]
 * @param {string} [opts.externalRef]
 * @returns {string[]}
 */
export function buildCreateArgs({ title, type, priority, assignee, description, externalRef } = {}) {
  const args = ['create', '--title', title];

  if (type != null) args.push('--type', type);
  if (priority != null) args.push('--priority', String(priority));
  if (assignee != null) args.push('--assignee', assignee);
  if (description != null) args.push('--description', description);
  if (externalRef != null) args.push('--external-ref', externalRef);

  return args;
}

/**
 * Build args array for `bd close`.
 * @param {string} beadsId
 * @param {string} [reason]
 * @returns {string[]}
 */
export function buildCloseArgs(beadsId, reason) {
  const args = ['close', beadsId];
  if (reason != null) args.push('--reason', reason);
  return args;
}

/**
 * Build args array for `bd show`.
 * @param {string} beadsId
 * @returns {string[]}
 */
export function buildShowArgs(beadsId) {
  return ['show', beadsId];
}

/**
 * Build args array for `bd search`.
 * @param {string} query
 * @returns {string[]}
 */
export function buildSearchArgs(query) {
  return ['search', query];
}

// ---------------------------------------------------------------------------
// Output parsers (pure)
// ---------------------------------------------------------------------------

/**
 * Extract beads ID from `bd create` stdout.
 * Expects pattern: "Created issue: forge-xxxx"
 * @param {string} stdout
 * @returns {string|null}
 */
export function parseCreateOutput(stdout) {
  const match = stdout.match(/Created issue:\s+(forge-[\w-]+)/);
  return match ? match[1] : null;
}

/**
 * Extract status from `bd show` stdout.
 * Looks for bracketed status like [OPEN], [CLOSED], [IN_PROGRESS].
 * @param {string} stdout
 * @returns {string|null} Lowercase status or null
 */
export function parseShowOutput(stdout) {
  const match = stdout.match(/\[([A-Z_]+)\]/);
  return match ? match[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Exec wrappers (side-effectful — not unit-tested)
// ---------------------------------------------------------------------------

/**
 * Run `bd create` and return the parsed beads ID.
 * @param {object} opts - Same as buildCreateArgs
 * @returns {string|null} The created beads ID, or null if parsing failed
 */
export function bdCreate(opts) {
  const stdout = execFileSync('bd', buildCreateArgs(opts), EXEC_OPTS);
  return parseCreateOutput(stdout);
}

/**
 * Run `bd close`.
 * @param {string} beadsId
 * @param {string} [reason]
 */
export function bdClose(beadsId, reason) {
  execFileSync('bd', buildCloseArgs(beadsId, reason), EXEC_OPTS);
}

/**
 * Run `bd show` and return the parsed status.
 * @param {string} beadsId
 * @returns {string|null} Lowercase status or null
 */
export function bdShow(beadsId) {
  const stdout = execFileSync('bd', buildShowArgs(beadsId), EXEC_OPTS);
  return parseShowOutput(stdout);
}

/**
 * Run `bd search` and return raw stdout.
 * @param {string} query
 * @returns {string}
 */
export function bdSearch(query) {
  return execFileSync('bd', buildSearchArgs(query), EXEC_OPTS);
}
