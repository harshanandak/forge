'use strict';

/**
 * Global CLI flags recognized by bin/forge.js parseGlobalFlags().
 *
 * bin/forge.js parses these into the `flags` object but leaves them inside the
 * positional `args` array it hands to command handlers. Free-text commands
 * (remember, recall) that join positionals into content must strip them first,
 * or `forge remember "note" -p <dir>` stores the literal `note -p <dir>`
 * (kernel issue c1e090ff).
 *
 * Keep these sets in sync with parseGlobalFlags() in bin/forge.js.
 * @module lib/global-flags
 */

// Flags that consume a following value token (also accepted as --flag=value).
const GLOBAL_VALUE_FLAGS = new Set([
  '--path', '-p',
  '--agents',
  '--merge',
  '--type',
  '--budget',
]);

const GLOBAL_VALUE_FLAG_PREFIXES = ['--path=', '--agents=', '--merge=', '--type=', '--budget='];

// Boolean flags that take no value.
const GLOBAL_BOOLEAN_FLAGS = new Set([
  '--quick', '-q',
  '--skip-external', '--skip-services',
  '--all',
  '--help', '-h',
  '--version', '-V',
  '--yes', '-y',
  '--non-interactive',
  '--force',
  '--verbose',
  '--dry-run',
  '--symlink',
  '--sync',
  '--interview',
]);

/**
 * Remove recognized global flags (and their values) from a positional args
 * array. Plain words that merely resemble flag names (no leading dash) are
 * always kept.
 *
 * @param {string[]} args - Raw command arguments.
 * @returns {string[]} Arguments with global flags stripped.
 */
function stripGlobalFlags(args) {
  const kept = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (GLOBAL_BOOLEAN_FLAGS.has(arg)) continue;
    if (GLOBAL_VALUE_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix))) continue;
    if (GLOBAL_VALUE_FLAGS.has(arg)) {
      const next = args[index + 1];
      // Mirror parsePathFlag() in bin/forge.js: the value is consumed only
      // when it exists and is not itself a flag.
      if (next !== undefined && !next.startsWith('-')) index += 1;
      continue;
    }
    kept.push(arg);
  }
  return kept;
}

/**
 * Index of the first positional token (a bare, non-flag argument), skipping any
 * leading global flags and their consumed values. Returns -1 when no positional
 * exists. Uses the SAME flag-consumption rules as {@link stripGlobalFlags} so the
 * two agree on what counts as a positional. Unlike stripGlobalFlags this returns
 * an index into the ORIGINAL array, so callers can splice out the positional
 * while preserving the intervening flags.
 *
 * @param {string[]} args - Raw command arguments.
 * @param {number} [start=0] - Index to begin scanning from.
 * @returns {number} Index into `args` of the first positional token, or -1.
 */
function firstPositionalIndex(args, start = 0) {
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index];
    if (GLOBAL_BOOLEAN_FLAGS.has(arg)) continue;
    if (GLOBAL_VALUE_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix))) continue;
    if (GLOBAL_VALUE_FLAGS.has(arg)) {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith('-')) index += 1;
      continue;
    }
    // Any other dash-prefixed token is a non-global flag, not the positional.
    if (arg.startsWith('-')) continue;
    return index;
  }
  return -1;
}

module.exports = {
  GLOBAL_BOOLEAN_FLAGS,
  GLOBAL_VALUE_FLAGS,
  stripGlobalFlags,
  firstPositionalIndex,
};
