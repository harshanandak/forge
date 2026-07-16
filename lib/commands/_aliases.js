/**
 * Command Aliases — declarative back-compat alias map.
 *
 * Generalises the former hardcoded `ISSUE_ALIAS_COMMANDS` allowlist (bin/forge.js)
 * into a single declarative source of truth for command-surface unification
 * (kernel issue 33d1a906, epic eea186fa). Each entry maps a bare top-level alias
 * to the canonical `<noun> <sub>` form it stands in for, plus two flags:
 *
 *   { canonical: 'issue create', visible: false, deprecated?: true }
 *
 *   - `canonical`  — the canonical noun+subcommand this alias resolves to.
 *   - `visible`    — true → routable AND shown in `forge --help`;
 *                    false → routable but hidden from help (back-compat only).
 *   - `deprecated` — optional; when true, using the alias emits a one-line hint
 *                    to STDERR, but ONLY when `FORGE_DEPRECATION_WARNINGS` is set.
 *                    Aliases are NEVER removed or broken (docker still ships
 *                    `docker pull`).
 *
 * P0 SCOPE: seeds ONLY the existing issue aliases migrated verbatim from
 * `ISSUE_ALIAS_COMMANDS` (all hidden, none deprecated) so behaviour is identical.
 * No new noun mappings are added here — those land in later phases. The bare
 * files (create.js, update.js, …) still exist and remain the routed handlers, so
 * `resolveDispatch` is a strict no-op for the seed set (its first clause skips any
 * name that is still a registered command).
 *
 * Files starting with `_` are excluded from command auto-discovery (see
 * `_registry.js`), so this module is never mistaken for a command itself.
 *
 * @module _aliases
 */

/**
 * @typedef {Object} AliasDescriptor
 * @property {string} canonical - Canonical `<noun> <sub>` form the alias resolves to.
 * @property {boolean} visible - Whether the alias appears in `forge --help`.
 * @property {boolean} [deprecated] - Whether using the alias emits an opt-in hint.
 */

/** @type {Object<string, AliasDescriptor>} */
const ALIASES = {
  create: { canonical: 'issue create', visible: false },
  update: { canonical: 'issue update', visible: false },
  claim: { canonical: 'issue claim', visible: false },
  close: { canonical: 'issue close', visible: false },
  show: { canonical: 'issue show', visible: false },
  list: { canonical: 'issue list', visible: false },
  ready: { canonical: 'issue ready', visible: false },
  blocked: { canonical: 'issue blocked', visible: false },
  stale: { canonical: 'issue stale', visible: false },
  orphans: { canonical: 'issue orphans', visible: false },
  lint: { canonical: 'issue lint', visible: false },
  claims: { canonical: 'issue claims', visible: false },
  // `issues` is the plural convenience form of `issue list`.
  issues: { canonical: 'issue list', visible: false },

  // P1 (kernel issue febf7690) — memory noun shortcuts. The `memory` noun
  // (add/recall/search/insights) shipped in PR #392 (issue 25362344); P1 wires the
  // bare verbs as VISIBLE back-compat shortcuts of the canonical `memory <sub>`
  // form. The canonical WRITE verb is `memory add` (there is NO `save`). These stay
  // registered command files (remember.js/recall.js/insights.js), so resolveDispatch
  // is a strict no-op for them and bare-verb dispatch stays byte-identical; the
  // entries exist to document the mapping and drive the `forge --help` Shortcuts
  // block. They are deliberately NOT issue-backend flag-passthrough aliases (see
  // passthroughAliasNames) so global flags (`-p`, `--help`, `--all`) still parse
  // exactly as they did for the standalone commands.
  remember: { canonical: 'memory add', visible: true },
  recall: { canonical: 'memory recall', visible: true },
  insights: { canonical: 'memory insights', visible: true },

  // P2 (kernel issue 6ab3f30c) — the `pr` noun (ship/preflight/shepherd/merge) plus
  // folding doc-gate under the existing `gate` noun. `pr ship` is the canonical
  // PR-creation form, but bare `ship` stays a VISIBLE shortcut (hot workflow verb,
  // zero keystroke loss); `preflight` is likewise VISIBLE. shepherd/merge/doc-gate
  // are less-hot, so they stay HIDDEN back-compat aliases. Every one keeps its own
  // registered command file (ship.js/preflight.js/shepherd.js/merge.js/doc-gate.js),
  // so resolveDispatch is a strict no-op for them and bare-verb dispatch stays
  // byte-identical — the entries document the mapping and drive the `forge --help`
  // Shortcuts block. Their canonical is a `pr `/`gate ` form (NOT `issue `), so
  // passthroughAliasNames() excludes them and their global flags (`--pull`,
  // `--json`, `--bundle`, `--all`, `-h`) parse exactly as the standalone commands'.
  ship: { canonical: 'pr ship', visible: true },
  preflight: { canonical: 'pr preflight', visible: true },
  shepherd: { canonical: 'pr shepherd', visible: false },
  merge: { canonical: 'pr merge', visible: false },
  'doc-gate': { canonical: 'gate doc', visible: false },
};

/**
 * Look up an alias descriptor by bare name.
 * @param {string} name
 * @returns {AliasDescriptor|undefined}
 */
function resolveAlias(name) {
  return Object.prototype.hasOwnProperty.call(ALIASES, name) ? ALIASES[name] : undefined;
}

/**
 * @param {string} name
 * @returns {boolean} true if `name` is a registered alias.
 */
function isAlias(name) {
  return resolveAlias(name) !== undefined;
}

/**
 * All alias names. Replaces the flat `ISSUE_ALIAS_COMMANDS` array — used to skip
 * global flag parsing so passthrough flags reach the handler intact.
 * @returns {string[]}
 */
function aliasNames() {
  return Object.keys(ALIASES);
}

/**
 * The subset of aliases that delegate ALL flag parsing to the issue backend
 * and therefore must SKIP global flag parsing in bin/forge.js so flags like
 * `--type` / `-p` / `--help` reach the handler intact. This is issue-specific:
 * only issue-canonical aliases passthrough. Non-issue aliases (e.g. the P1 memory
 * shortcuts) parse global flags normally — exactly as their standalone command
 * files did — so their behaviour stays byte-identical after becoming aliases.
 * @returns {string[]}
 */
function passthroughAliasNames() {
  return Object.keys(ALIASES).filter(name => ALIASES[name].canonical.startsWith('issue '));
}

/**
 * Names of aliases shown in the `forge --help` Shortcuts block — visible
 * back-compat shortcuts for a canonical `<noun> <sub>` form. Hidden (back-compat
 * only) aliases are excluded.
 * @returns {string[]}
 */
function visibleAliasNames() {
  return Object.keys(ALIASES).filter(name => ALIASES[name].visible === true);
}

/**
 * Whether a descriptor is hidden from help. Pure predicate over the `visible`
 * flag so the visible-vs-hidden distinction can be tested independent of the
 * P0 seed (which is entirely hidden).
 * @param {AliasDescriptor|undefined} descriptor
 * @returns {boolean}
 */
function isHidden(descriptor) {
  return !!descriptor && descriptor.visible === false;
}

/**
 * Whether the named alias is hidden from `forge --help`. Drives the help filter.
 * @param {string} name
 * @returns {boolean}
 */
function isHiddenAlias(name) {
  return isHidden(resolveAlias(name));
}

/**
 * Whether the named alias is a visible (help-listed) shortcut.
 * @param {string} name
 * @returns {boolean}
 */
function isVisibleAlias(name) {
  const descriptor = resolveAlias(name);
  return !!descriptor && descriptor.visible === true;
}

/**
 * Render the one-line deprecation hint for an alias.
 * @param {string} name
 * @param {AliasDescriptor} descriptor
 * @returns {string}
 */
function renderHint(name, descriptor) {
  return `forge ${name} is a back-compat alias; prefer 'forge ${descriptor.canonical}'`;
}

/**
 * Whether a deprecation hint should be emitted: requires BOTH the opt-in env flag
 * AND a descriptor explicitly marked deprecated. Default (flag unset) is silent,
 * so scripted stdout is never affected.
 * @param {AliasDescriptor|undefined} descriptor
 * @param {Object} env
 * @returns {boolean}
 */
function shouldWarn(descriptor, env) {
  return !!(env && env.FORGE_DEPRECATION_WARNINGS && descriptor && descriptor.deprecated);
}

/**
 * Emit an opt-in deprecation hint to stderr when both gates pass. Never writes to
 * stdout (would corrupt `--json`). Returns whether a hint was emitted.
 * @param {string} name
 * @param {{env?: Object, stderr?: {write: function}, resolve?: function}} [opts]
 * @returns {boolean}
 */
function maybeWarnDeprecation(name, opts = {}) {
  const env = opts.env || process.env;
  const stderr = opts.stderr || process.stderr;
  const resolve = opts.resolve || resolveAlias;
  const descriptor = resolve(name);
  if (!shouldWarn(descriptor, env)) return false;
  stderr.write(`${renderHint(name, descriptor)}\n`);
  return true;
}

/**
 * Resolve a bare command to its canonical noun handler for dispatch.
 *
 * A command that is still a registered command file (`isRegistered(command)` is
 * true) is NEVER rewritten — dispatch stays byte-identical. Only a bare alias
 * whose name is NOT a registered command resolves to `<noun> <sub>`; this
 * activates when a later phase folds a bare verb into a noun handler. For the P0
 * seed every alias is still registered, so this always returns `redirected:false`.
 *
 * @param {string} command - The bare command name (args[0]).
 * @param {string[]} argv - The full argv (argv[0] is the command token).
 * @param {function(string): boolean} isRegistered - Predicate: is this a live command?
 * @returns {{command: string, args: string[], redirected: boolean}}
 */
function resolveDispatch(command, argv, isRegistered) {
  if (typeof isRegistered === 'function' && isRegistered(command)) {
    return { command, args: argv, redirected: false };
  }
  const descriptor = resolveAlias(command);
  if (!descriptor) {
    return { command, args: argv, redirected: false };
  }
  const parts = String(descriptor.canonical).trim().split(/\s+/);
  const noun = parts[0];
  const rest = Array.isArray(argv) ? argv.slice(1) : [];
  return { command: noun, args: [noun, ...parts.slice(1), ...rest], redirected: true };
}

module.exports = {
  ALIASES,
  resolveAlias,
  isAlias,
  aliasNames,
  passthroughAliasNames,
  visibleAliasNames,
  isHidden,
  isHiddenAlias,
  isVisibleAlias,
  renderHint,
  shouldWarn,
  maybeWarnDeprecation,
  resolveDispatch,
};
