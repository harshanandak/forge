# Task List

Task 1: Lock The Migration Contract With Legacy Fixtures
File(s): `test/beads-migrate-to-dolt.test.js`, `test/fixtures/beads-migrate/legacy-backup/issues.jsonl`, `test/fixtures/beads-migrate/legacy-backup/labels.jsonl`, `test/fixtures/beads-migrate/legacy-backup/dependencies.jsonl`, `test/fixtures/beads-migrate/legacy-backup/comments.jsonl`, `test/fixtures/beads-migrate/legacy-backup/events.jsonl`, `test/fixtures/beads-migrate/legacy-backup/config.jsonl`
OWNS: `test/beads-migrate-to-dolt.test.js`, `test/fixtures/beads-migrate/legacy-backup/*`
What to implement: Add red tests and realistic fixtures that define the migration contract for `runLegacyBeadsMigration()` and `verifyMigrationParity()`: preserve issue IDs, preserve dependency edges, preserve comments/config, and restore the original snapshot when verification fails.
TDD steps:
  1. Write test: `test/beads-migrate-to-dolt.test.js` covering successful import, parity mismatch, and rerun safety against fixture data.
  2. Run test: confirm it fails with missing-module or missing-function errors for `runLegacyBeadsMigration()` / `verifyMigrationParity()`.
  3. Implement: no production code in this task; fixtures and assertions only.
  4. Run test: confirm the new tests still fail for the expected missing implementation, not for malformed fixtures.
  5. Commit: `test: add beads dolt migration contract coverage`
Expected output: a stable failing test suite that documents the exact migration behavior required before any script is written.

Task 2: Implement The Safe Legacy-To-Dolt Migration Wrapper
File(s): `scripts/beads-migrate-to-dolt.sh`, `scripts/lib/beads-migrate-to-dolt.mjs`
OWNS: `scripts/beads-migrate-to-dolt.sh`, `scripts/lib/beads-migrate-to-dolt.mjs`
What to implement: Create `runLegacyBeadsMigration()`, `verifyMigrationParity()`, and `rollbackLegacyBeadsMigration()` to snapshot `.beads/`, normalize migration inputs, invoke the official JSONL-to-Dolt import flow, verify parity, and restore on failure. The wrapper must preserve all existing issues and write a rollback manifest.
TDD steps:
  1. Write test: use `test/beads-migrate-to-dolt.test.js` to require rollback-safe migration behavior from the new module and shell entrypoint.
  2. Run test: confirm it fails because the migration wrapper does not yet exist.
  3. Implement: add the Node helper plus shell wrapper with explicit snapshot, import, verify, and rollback phases.
  4. Run test: confirm the migration contract tests pass.
  5. Commit: `feat: add rollback-safe beads dolt migration script`
Expected output: a migration command that exits non-zero on parity failure, exits zero on verified success, and leaves a timestamped rollback snapshot either way.

Task 3: Remove Legacy Setup And Scaffold Assumptions
File(s): `lib/beads-setup.js`, `lib/beads-sync-scaffold.js`, `test/beads-setup.test.js`, `test/beads-init-wrapper.test.js`, `test/beads-sync-detect.test.js`, `test/beads-sync-scaffold.test.js`, `test/helpers/setup-command-harness.js`, `test/setup-lefthook-repair.test.js`, `test/setup-runtime-flags.test.js`
OWNS: `lib/beads-setup.js`, `lib/beads-sync-scaffold.js`, `test/beads-setup.test.js`, `test/beads-init-wrapper.test.js`, `test/beads-sync-detect.test.js`, `test/beads-sync-scaffold.test.js`, `test/helpers/setup-command-harness.js`, `test/setup-lefthook-repair.test.js`, `test/setup-runtime-flags.test.js`
What to implement: Update `isBeadsInitialized()`, `safeBeadsInit()`, `detectBeadsVersion()`, and workflow templating so Forge no longer requires `.beads/issues.jsonl`, no longer pre-seeds legacy JSONL state, and no longer falls back to `0.49.1` as the default Beads version.
TDD steps:
  1. Write test: revise the existing setup/scaffold tests to assert Dolt-first initialization and latest-version templating instead of JSONL/`0.49.1` behavior.
  2. Run test: confirm the updated tests fail against the current legacy assumptions.
  3. Implement: change setup/scaffold logic to use the new Dolt-backed invariants and version detection behavior.
  4. Run test: confirm all updated setup/scaffold tests pass.
  5. Commit: `refactor: align forge setup with dolt-backed beads`
Expected output: Forge setup helpers initialize and scaffold Beads latest without requiring legacy JSONL state files.

Task 4: Update GitHub Sync Workflows For Dolt-Backed State
File(s): `.github/workflows/github-to-beads.yml`, `.github/workflows/beads-to-github.yml`, `scripts/github-beads-sync/reverse-sync.mjs`, `scripts/github-beads-sync/reverse-sync-cli.mjs`, `test/scripts/github-beads-sync/workflow-validation.test.js`
OWNS: `.github/workflows/github-to-beads.yml`, `.github/workflows/beads-to-github.yml`, `scripts/github-beads-sync/reverse-sync.mjs`, `scripts/github-beads-sync/reverse-sync-cli.mjs`, `test/scripts/github-beads-sync/workflow-validation.test.js`
What to implement: Replace direct `.beads/issues.jsonl` diff assumptions with an export/snapshot-based workflow that works with Dolt-backed Beads latest. Update workflow install steps away from the `v0.49.1` pin and ensure reverse sync can consume exported before/after snapshots.
TDD steps:
  1. Write test: extend workflow validation coverage so the workflows fail if they pin `0.49.1` or read `.beads/issues.jsonl` directly.
  2. Run test: confirm the workflow validation test fails against the current YAML and reverse-sync contract.
  3. Implement: update workflow YAML plus reverse-sync entrypoints to use export-based snapshots and latest install guidance.
  4. Run test: confirm workflow validation passes.
  5. Commit: `feat: migrate github beads sync workflows to dolt exports`
Expected output: CI workflows that install Beads latest and perform sync/reverse-sync without relying on committed JSONL state files.

Task 5: Add A Post-Upgrade Command Smoke Harness
File(s): `scripts/beads-upgrade-smoke.sh`, `test/scripts/beads-upgrade-smoke.test.js`
OWNS: `scripts/beads-upgrade-smoke.sh`, `test/scripts/beads-upgrade-smoke.test.js`
What to implement: Add a smoke harness that exercises `bd create`, `bd list`, `bd show`, `bd dep add`, `bd close`, and `bd sync` safely against the upgraded repo state, leaving behind either a clean rollback or an explicit failure artifact.
TDD steps:
  1. Write test: `test/scripts/beads-upgrade-smoke.test.js` asserting the harness issues the required command sequence and fails closed on any command error.
  2. Run test: confirm it fails because the smoke harness does not exist.
  3. Implement: add the harness with explicit cleanup and machine-readable summaries for each command.
  4. Run test: confirm the harness contract test passes.
  5. Commit: `test: add beads upgrade smoke harness`
Expected output: a repeatable smoke command that proves the upgraded Beads workflow works end-to-end in this repo.

Task 6: Update Toolchain Documentation For Beads Latest
File(s): `docs/TOOLCHAIN.md`
OWNS: `docs/TOOLCHAIN.md`
What to implement: Rewrite the Beads installation/setup section to reflect Beads latest, Dolt-backed storage, the new migration script, rollback steps, and the post-upgrade smoke command for this repo.
TDD steps:
  1. Write test: add or update a documentation guard test if needed so legacy `v0.49.x` / dual-database claims are rejected.
  2. Run test: confirm it fails against the current outdated toolchain text.
  3. Implement: update `docs/TOOLCHAIN.md` with the current install, migration, rollback, and verification instructions.
  4. Run test: confirm the guard passes or, if no automated guard exists, run the targeted doc validation command used elsewhere in the repo.
  5. Commit: `docs: update toolchain for dolt-backed beads`
Expected output: one canonical Beads setup document for Forge that matches the implementation and CI workflows.

## YAGNI Filter

- Task 1 maps to success criteria 1 and 2.
- Task 2 maps to success criteria 1 and 2.
- Task 3 maps to success criteria 3 and 4.
- Task 4 maps to success criteria 3 and 6.
- Task 5 maps to success criteria 6.
- Task 6 maps to success criteria 5.

No task is unanchored to the design doc or user scope.
