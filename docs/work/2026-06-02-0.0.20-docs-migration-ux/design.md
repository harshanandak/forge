# Feature: 0.0.20 Docs And Migration UX

Date: 2026-06-02
Status: prepared for PR E development
Issue: forge-2agy.2.5
Branch: codex/0.0.20-docs-migration-ux

## Purpose

Document the user-facing migration path from Beads-backed issue state to Forge Kernel authority without changing Kernel implementation files. This slice ties the schema, local broker, and Beads import/export adapter docs into one migration UX reference that remains compatible with PR D conflict quarantine work landing later.

## Success Criteria

- Explain that Beads is current compatibility input/output while Forge Kernel is the target issue authority.
- Document import, export dry-run, export write, rollback, and projection-failure boundaries.
- Make clear that rollback restores Beads projection files or discards imported Kernel records; it does not roll back authoritative Kernel state after a committed Kernel mutation.
- Reserve conflict quarantine wording for PR D and state which sections will be finalized after `forge-2agy.2.4`.
- Link the migration UX reference from the documentation index.
- Keep `.beads/issues.jsonl` projection cleanup limited to already-merged PR A/B issues if local records still show them open.

## Inputs Verified

- `docs/work/2026-06-01-0.0.20-kernel-schema/design.md` documents PR A schema and migration boundaries.
- `docs/work/2026-06-01-0.0.20-local-broker/design.md` documents PR B local broker authority and command API contract.
- `docs/work/2026-06-01-0.0.20-beads-import-export/design.md` documents PR C import/export, fidelity, dry-run, and rollback behavior.
- `.beads/issues.jsonl` parses as JSONL and currently has 286 issue records.
- GitHub PR #195 and PR #196 are merged.

## Out Of Scope

- No edits under `lib/kernel/**`.
- No edits to adapter implementation or tests.
- No conflict quarantine implementation or final conflict-resolution UX; PR D owns `forge-2agy.2.4`.
- No closure of `forge-2agy.2.4` or `forge-2agy.2.5`.

## Compatibility With PR D

The migration UX guide describes the conflict quarantine boundary without naming final CLI output, resolver policy, evaluator fixture names, or data-shape details that PR D has not landed yet. After PR D merges, the guide should be updated with the exact quarantine commands, report fields, and evaluator evidence.
