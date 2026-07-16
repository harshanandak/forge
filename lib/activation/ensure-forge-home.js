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
 * ONLY `.forge/config.yaml` with every gate disabled (the `minimal` adoption
 * profile). It installs NO git hooks, NO lefthook.yml, NO protected-paths
 * manifest, NO `.mcp.json`, and NO scripts tree — those remain the opt-in
 * payload of `forge setup`, never forced. Progressive growth: heavier slices
 * initialize themselves on first use.
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
 * A command module may override membership by exporting `mutating: true|false`;
 * this Set is the default classification for the foundation. Refining the full
 * per-command `mutating` flags is follow-up work.
 */
const MUTATING_VERBS = new Set([
  'claim',
  'close',
  'create',
  'comment',
  'update',
  'add',
  'new',
  'stage',
  'remember',
  'role',
  'gate',
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
 * Render the bare-minimum, gates-disabled config body.
 *
 * Reuses the canonical `minimal` adoption profile so the produced YAML is
 * schema-valid and identical in spirit to `forge init --minimal` (minus the
 * hooks/protected-paths side effects). Overridable via `deps.renderConfig` for
 * tests that don't want to depend on the profile renderer.
 *
 * @param {object} [deps]
 * @returns {string} config.yaml contents
 */
function renderMinimalConfig(deps = {}) {
  const render = deps.renderConfig || (() => renderAdoptionConfigYaml('minimal'));
  return render();
}

/**
 * Idempotently create the bare-minimum `.forge/` skeleton for a mutating verb.
 *
 * No-clobber by construction: if `.forge/` already exists (inited repo, or a
 * partially-created home), this is a NO-OP and never touches the user's files.
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

  // Never clobber: an existing .forge/ (even without config.yaml) is the user's.
  if (fsImpl.existsSync(forgeDir)) {
    const reason = fsImpl.existsSync(configPath) ? 'config-exists' : 'forge-dir-exists';
    return { created: false, reason, configPath };
  }

  fsImpl.mkdirSync(forgeDir, { recursive: true });
  fsImpl.writeFileSync(configPath, renderMinimalConfig(deps), 'utf8');
  return { created: true, configPath };
}

module.exports = {
  ensureForgeHome,
  isMutatingVerb,
  renderMinimalConfig,
  MUTATING_VERBS,
};
