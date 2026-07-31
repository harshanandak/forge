'use strict';

/**
 * Lazy `.forge/` home creation (activation foundation).
 *
 * Discovery ≠ initialization. The global Forge plugin (SessionStart hook +
 * `activation` skill) must create NOTHING in a user's repo. The FIRST verb that
 * performs a real MUTATION (e.g. `forge claim`, `forge create`, `forge
 * remember`) is what lazily materializes the bare-minimum `.forge/` skeleton.
 * Read-only verbs (`ready`, `show`, `status`, `recap`, …) never call this, so a
 * bare repo stays untouched until the user actually changes state.
 *
 * "Bare-minimum" here is strictly LESS than `forge init --minimal`: this writes
 * ONLY `.forge/config.yaml` with Forge's canonical default enforcement posture.
 * It installs NO git hooks, NO lefthook.yml, NO protected-paths manifest, NO
 * `.mcp.json`, and NO scripts tree — those remain the opt-in payload of
 * `forge setup`, never forced. Progressive growth: heavier slices initialize
 * themselves on first use.
 *
 * @module activation/ensure-forge-home
 */

const fs = require('node:fs');
const path = require('node:path');

const { renderAdoptionConfigYaml } = require('../adoption-profiles');

/**
 * Core verbs that MUTATE project state and therefore need `.forge/` to exist.
 *
 * Deliberately excludes `init`/`setup` — they own `.forge/` creation with their
 * own (richer) logic, and pre-creating a minimal config would trip their
 * no-clobber guard. Also excludes every read-only verb, so those write nothing.
 *
 * Deliberately EXCLUDES `gate` and `stage`: each has read-only subcommands
 * (`gate status`/`gate check`, `stage --list`/`--current`) that must not create
 * `.forge/` — a verb-level trigger would violate the foundation's own
 * "read-only writes nothing" invariant. Their genuinely-mutating forms
 * self-manage without ensureForgeHome: `gate enable|disable` and `role` write
 * via the config writer (which creates `.forge/config.yaml` if absent), while
 * `gate approve|reject` and `stage --start|--complete` write kernel events/runs
 * through the broker (which lazily creates its own store). Subcommand-level
 * granularity is deferred; excluding the whole verb is the correct, safe default
 * because the read-only forms are the common case. `role` is retained: it has NO
 * read-only form (every valid invocation writes config), so it violates nothing.
 *
 * A command module may override membership by exporting `mutating: true|false`;
 * this Set is the default classification for the foundation.
 */
const MUTATING_VERBS = new Set([
  'claim',
  'close',
  'create',
  'comment',
  'update',
  'add',
  'new',
  'remember',
  'role',
  'patch',
]);

/**
 * Decide whether a verb should lazily ensure the `.forge/` home.
 *
 * A command module's explicit `mutating` boolean wins; otherwise fall back to
 * the default {@link MUTATING_VERBS} classification.
 *
 * @param {string} name - Command/verb name being dispatched.
 * @param {object} [command] - The resolved command module (may declare `mutating`).
 * @returns {boolean}
 */
function isMutatingVerb(name, command) {
  if (command && typeof command === 'object' && typeof command.mutating === 'boolean') {
    return command.mutating;
  }
  return MUTATING_VERBS.has(name);
}

/**
 * Render the bare-minimum config body with Forge's default enforcement posture.
 *
 * Reuses the canonical `standard` adoption profile so the produced YAML is
 * schema-valid and keeps default gates enabled. Overridable via
 * `deps.renderConfig` for tests that don't want to depend on the profile
 * renderer.
 *
 * @param {object} [deps]
 * @returns {string} config.yaml contents
 */
function renderDefaultConfig(deps = {}) {
  const render = deps.renderConfig || (() => renderAdoptionConfigYaml('standard'));
  return render();
}

/**
 * Backward-compatible export name for callers of the previously exported
 * helper. New code should use `renderDefaultConfig`; lazy initialization no
 * longer creates a minimal/disabled configuration.
 */
const renderMinimalConfig = renderDefaultConfig;

/**
 * Idempotently create the bare-minimum `.forge/` skeleton for a mutating verb.
 *
 * No-clobber by construction: an existing config is a NO-OP. A partial home
 * whose `.forge/` directory exists without `config.yaml` is completed safely.
 * The kernel/issue store (`.forge/kernel/…`) is created lazily by the broker on
 * the mutating verb itself — this function only guarantees the config skeleton.
 *
 * @param {string} [projectRoot=process.cwd()] - Repo root to initialize.
 * @param {object} [deps] - Injectable seams: `fs`, `renderConfig`.
 * @returns {{ created: boolean, reason?: string, configPath: string }}
 */
function ensureForgeHome(projectRoot = process.cwd(), deps = {}) {
  const fsImpl = deps.fs || fs;
  const forgeDir = path.join(projectRoot, '.forge');
  const configPath = path.join(forgeDir, 'config.yaml');

  // Idempotent + self-healing. The presence of `config.yaml` — NOT the `.forge/`
  // directory alone — is what marks the home as initialized. Keying the
  // no-clobber check on the config FILE means a half-init (dir created but config
  // never written: disk full, permission error, or the process killed between
  // mkdir and write) is COMPLETED on the next call instead of being permanently
  // stuck behind a dir-exists early-return. We only ever ADD a missing
  // config.yaml and never overwrite an existing one, so a real inited repo is
  // still never clobbered. `mkdirSync({recursive})` is a no-op if the dir exists.
  if (fsImpl.existsSync(configPath)) {
    return { created: false, reason: 'config-exists', configPath };
  }

  fsImpl.mkdirSync(forgeDir, { recursive: true });
  fsImpl.writeFileSync(configPath, renderDefaultConfig(deps), 'utf8');
  return { created: true, configPath };
}

module.exports = {
  ensureForgeHome,
  isMutatingVerb,
  renderDefaultConfig,
  renderMinimalConfig,
  MUTATING_VERBS,
};
