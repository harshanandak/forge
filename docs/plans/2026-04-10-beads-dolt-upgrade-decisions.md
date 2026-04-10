# Beads Dolt Upgrade Decisions

## Decision 1
**Date**: 2026-04-10
**Task**: Task 1 - Lock The Migration Contract With Legacy Fixtures
**Gap**: The design doc requires `runLegacyBeadsMigration()` and `verifyMigrationParity()` but does not specify their exact input or result shapes.
**Score**: 2 / 14
**Route**: PROCEED
**Choice made**: Define both functions around a single options object. `runLegacyBeadsMigration()` will accept explicit paths plus an injectable import callback for testing and return a structured status object. `verifyMigrationParity()` will compare legacy backup JSONL with exported migrated JSONL and report counts plus preserved ids, edges, and keys. This keeps the API internal to the repo, testable without the upstream script, and easy to harden in Task 2.
**Status**: RESOLVED

## Decision 2
**Date**: 2026-04-10
**Task**: Task 2 - Implement The Safe Legacy-To-Dolt Migration Wrapper
**Gap**: The design doc points to the upstream JSONL-to-Dolt migration path, but the installed `bd` CLI also exposes `bd init` plus `bd backup restore [path]`, which can restore the same JSONL backup snapshot directly into a Dolt-backed workspace.
**Score**: 3 / 14
**Route**: PROCEED
**Choice made**: Use the installed Beads CLI as the default import mechanism inside the wrapper: `bd init --force` in an isolated migrated workspace, `bd backup restore <legacy-backup-dir>`, then `bd backup --force` to emit a fresh export for parity verification. Keep the import step injectable so tests do not depend on a live Dolt server and we can still swap to the upstream shell script later if needed.
**Status**: RESOLVED

## Decision 3
**Date**: 2026-04-10
**Task**: Task 3 - Remove Legacy Setup And Scaffold Assumptions
**Gap**: The design doc says Forge should stop requiring `.beads/issues.jsonl`, but it does not spell out what initialization signal should replace that check or what fallback version the scaffold should use when `bd --version` is unavailable.
**Score**: 3 / 14
**Route**: PROCEED
**Choice made**: Treat Beads as initialized when `.beads/config.yaml` contains both `issue-prefix:` and `backend: dolt`, make `preSeedJsonl()` a no-op compatibility shim, and use `1.0.0` as the repo's current default scaffold fallback while also broadening workflow templating to replace any semver-shaped `BD_VERSION="x.y.z"` placeholder.
**Status**: RESOLVED

## Decision 4
**Date**: 2026-04-10
**Task**: Task 5 - Add A Post-Upgrade Command Smoke Harness
**Gap**: The task list requires a `bd sync` smoke step, but the currently installed local CLI (`bd version 0.62.0 (dev)`) does not expose a top-level `sync` command in `bd help`.
**Score**: 1 / 14
**Route**: PROCEED
**Choice made**: Keep `bd sync` as the harness contract because that is the user-requested verification surface for the upgraded Beads workflow. Do not silently substitute a different command. Instead, the harness records every attempted step and writes an explicit machine-readable failure artifact when `bd sync` is unavailable or fails in a given environment.
**Status**: RESOLVED
