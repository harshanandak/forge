/**
 * Static Command Manifest — GENERATED FILE, DO NOT EDIT.
 *
 * Regenerate with: node scripts/gen-command-manifest.js
 * Drift is enforced by test/structural/command-manifest-drift.test.js.
 *
 * This module `require`s every command by a static relative path so
 * `bun build --compile` can statically bundle the command graph. The registry
 * (lib/commands/_registry.js) consumes `commands` as its fast, bundleable path
 * and falls back to `fs.readdirSync` auto-discovery for dev/extension commands.
 *
 * @module commands/_manifest
 */

'use strict';

/**
 * @typedef {Object} ManifestEntry
 * @property {string} file - Command filename (e.g. `status.js`)
 * @property {import("./_registry").CommandModule} module - The required command module
 */

/** @type {ManifestEntry[]} */
const commands = [
  { file: "adapter.js", module: require("./adapter") },
  { file: "add.js", module: require("./add") },
  { file: "audit.js", module: require("./audit") },
  { file: "blocked.js", module: require("./blocked") },
  { file: "board.js", module: require("./board") },
  { file: "claim.js", module: require("./claim") },
  { file: "claims.js", module: require("./claims") },
  { file: "clean.js", module: require("./clean") },
  { file: "close.js", module: require("./close") },
  { file: "comment.js", module: require("./comment") },
  { file: "create.js", module: require("./create") },
  { file: "dev.js", module: require("./dev") },
  { file: "doc-gate.js", module: require("./doc-gate") },
  { file: "doctor.js", module: require("./doctor") },
  { file: "explain.js", module: require("./explain") },
  { file: "export.js", module: require("./export") },
  { file: "gate.js", module: require("./gate") },
  { file: "hooks.js", module: require("./hooks") },
  { file: "init.js", module: require("./init") },
  { file: "insights.js", module: require("./insights") },
  { file: "issue.js", module: require("./issue") },
  { file: "issues.js", module: require("./issues") },
  { file: "lint.js", module: require("./lint") },
  { file: "list.js", module: require("./list") },
  { file: "merge.js", module: require("./merge") },
  { file: "migrate.js", module: require("./migrate") },
  { file: "new.js", module: require("./new") },
  { file: "options.js", module: require("./options") },
  { file: "orient.js", module: require("./orient") },
  { file: "orphans.js", module: require("./orphans") },
  { file: "patch.js", module: require("./patch") },
  { file: "plan.js", module: require("./plan") },
  { file: "preflight.js", module: require("./preflight") },
  { file: "prime.js", module: require("./prime") },
  { file: "push.js", module: require("./push") },
  { file: "ready.js", module: require("./ready") },
  { file: "recall.js", module: require("./recall") },
  { file: "recap.js", module: require("./recap") },
  { file: "recommend.js", module: require("./recommend") },
  { file: "release.js", module: require("./release") },
  { file: "remember.js", module: require("./remember") },
  { file: "role.js", module: require("./role") },
  { file: "setup.js", module: require("./setup") },
  { file: "shepherd.js", module: require("./shepherd") },
  { file: "ship.js", module: require("./ship") },
  { file: "show.js", module: require("./show") },
  { file: "stage.js", module: require("./stage") },
  { file: "stale.js", module: require("./stale") },
  { file: "status.js", module: require("./status") },
  { file: "sync.js", module: require("./sync") },
  { file: "team.js", module: require("./team") },
  { file: "test.js", module: require("./test") },
  { file: "update.js", module: require("./update") },
  { file: "upgrade.js", module: require("./upgrade") },
  { file: "validate.js", module: require("./validate") },
  { file: "worktree.js", module: require("./worktree") },
];

module.exports = {
  // Absolute path of the canonical commands directory this manifest describes.
  // The registry applies the manifest only when asked to load this exact dir.
  dir: __dirname,
  commands,
};
