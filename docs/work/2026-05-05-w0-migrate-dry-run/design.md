# Wave 0 Migration Dry-Run PoC

**Issue**: `forge-0uo0`
**Date**: 2026-05-05
**Classification**: Critical, because this proves the v2 to v3 migration path without mutating live workflow state.
**Branch/worktree**: `codex/w0-migrate-dry-run` at `.worktrees/codex/w0-migrate-dry-run`

## Purpose

Implement the Wave 0 NO-GO gate from D10: `forge migrate --dry-run` must validate this repo's current v2 state and show the v3 migration projection before any mutating migration exists.

## Success Criteria

- `forge migrate --dry-run` runs against this repo and exits green.
- The report validates Git, Beads issue JSONL state, the Wave 0 issue marker, the v2 `WORKFLOW_STAGE_MATRIX`, Beads adapter projection, and planned v3 config files.
- The report includes a clear planned diff for `.forge/config.yaml`, `.forge/patch.md`, and `forge.lock`.
- The default dry-run writes no repo files.
- The command can run the existing v2 fixture corpus with `--fixture-corpus`; the intentionally broken fixture is reported as a failure without blocking the repo PoC.
- Tests cover the dry-run path, malformed Beads reporting, command dispatch, and fixture-corpus execution.

## Out Of Scope

- Real migration writes.
- Harness parity work.
- Skill auto-invoke behavior.
- Final v3 schema stabilization beyond the dry-run projection needed for the PoC.

## Approach Selected

Add a registry command module at `lib/commands/migrate.js` and keep the validation/reporting implementation in `lib/migrate-dry-run.js` so it can be tested directly. The command refuses non-dry-run migration for Wave 0 and only renders a report by default.

## Constraints

- Dry-run mode must not modify the target repository.
- Fixture-corpus execution may materialize repositories only under test helper temp directories.
- If the source-tree fixture corpus is unavailable in a packaged install, the report must include a TODO/blocker note instead of failing the normal repo dry-run.

## Edge Cases

- Malformed `.beads/issues.jsonl` reports a `[FAIL] Beads issue state` entry with the failing line.
- Repos with `.forge/v2/workflow-stage-matrix.json` use that fixture matrix; this repo uses the canonical `lib/workflow/stages.js` matrix.
- The current repo's Beads CLI lookup for `forge-0uo0` was not supported in this worktree, so the dry-run validates the tracked `.beads/issues.jsonl` source directly.
