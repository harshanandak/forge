# Decisions Log: Forge Test Suite v2

**Feature**: forge-test-suite-v2
**Beads**: forge-5vf
**Started**: 2026-02-27

---

<!-- Decisions appended below as they arise during /dev -->

## Decision 1
**Date**: 2026-02-27
**Task**: Task 1 — Audit and delete stale lib exports
**Gap**: `lib/commands/research.js` has a live non-test reference in `bin/forge-cmd.js` line 14. The `forge research` CLI command is still registered in VALID_COMMANDS, COMMAND_DESCRIPTIONS, REQUIRED_ARGS, dispatch handler, and help text. Deleting lib only requires also removing the CLI registration — user-visible behavior change not specified in Task 1.
**Score**: 7/14 (SPEC-REVIEWER range) — also matches explicit "SHOULD pause and ask" example in ambiguity policy
**Route**: BLOCKED — PENDING-DEVELOPER-INPUT
**Choice made**: Option A — full deletion. User confirmed lib/commands/research.js is a stub (conductResearch() returns empty arrays, forge research CLI produces useless empty documents).
**Options**:
  A. Full deletion: remove lib/commands/research.js AND all forge research CLI registration from bin/forge-cmd.js (removes forge research as a user command) ← CHOSEN
  B. Partial: keep lib/commands/research.js and the CLI command — skip deletion, only remove OpenSpec functions from lib/commands/plan.js
**Status**: RESOLVED
