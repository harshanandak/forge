# Beads Dolt Upgrade Decisions

## Decision 1
**Date**: 2026-04-10
**Task**: Task 1 — Lock The Migration Contract With Legacy Fixtures
**Gap**: The design doc requires `runLegacyBeadsMigration()` and `verifyMigrationParity()` but does not specify their exact input or result shapes.
**Score**: 2 / 14
**Route**: PROCEED
**Choice made**: Define both functions around a single options object. `runLegacyBeadsMigration()` will accept explicit paths plus an injectable import callback for testing and return a structured status object. `verifyMigrationParity()` will compare legacy backup JSONL with exported migrated JSONL and report counts plus preserved ids/edges/keys. This keeps the API internal to the repo, testable without the upstream script, and easy to harden in Task 2.
**Status**: RESOLVED
