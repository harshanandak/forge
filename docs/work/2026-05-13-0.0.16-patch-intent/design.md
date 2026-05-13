# 0.0.16 Patch Intent Baseline

## Issue

- `forge-besw.10`: 0.0.16 patch intent records and patch.md anchors

## Intent

Establish the baseline contract for user patch intent without implementing upgrade self-heal, rollback snapshots, marketplace, or adapter flows. This slice makes patch intent records first-class enough that later upgrade and rollback work can reason about local edits by stable anchors instead of only file paths.

## Current Code

- CLI commands are auto-discovered from `lib/commands/*.js` by `lib/commands/_registry.js`.
- Runtime config is loaded from `.forge/config.yaml` by `lib/core/runtime-graph.js`.
- Prior spike evidence exists for `patch.md` anchor rename/orphan behavior in `scripts/spikes/patch-anchor-stability-bench.js`.

## Approach

1. Add `lib/patch-intent.js` as the focused patch intent surface:
   - parse stable anchor comments from managed files
   - parse unified git diffs into per-anchor patch intent records
   - serialize records into `.forge/patch.md`
   - resolve records back to current anchor locations, including rename detection
   - report orphaned records when their anchor is undeclared
2. Add `lib/commands/patch.js` with `forge patch record --from-diff`.
3. Load `patchIntent` config from `.forge/config.yaml`:
   - `enabled`
   - `path`
   - `anchorAliases`
4. Add focused tests for:
   - stable record IDs and `patch.md` replacement
   - rename behavior through anchor scan
   - orphan detection
   - config path / disabled interaction
   - CLI record path
5. Document the record format and how it feeds later upgrade/rollback safety.

## Non-Scope

- `forge upgrade`
- rollback snapshots
- self-healing patch application
- marketplace/adapters

