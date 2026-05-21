# Tasks: 0.0.19 Protected State Surfaces

## Task 1: Core protected surface classifier and enforcement

TDD:
- RED: Add tests proving protected paths are classified, direct writes are blocked with repair hints, and allowed Forge API writes pass when the required surface is declared.
- GREEN: Implement `lib/protected-state-surfaces.js`.
- REFACTOR: Keep category rules data-driven and exported for hook reuse.

## Task 2: Bypass detection script and hook wiring

TDD:
- RED: Add tests proving staged protected edits fail, non-protected edits pass, and bypass output includes repair hints.
- GREEN: Implement `scripts/protected-state-check.js` and wire it into `lefthook.yml`.
- REFACTOR: Keep script output deterministic and Windows-safe.

## Task 3: Audit event completeness

TDD:
- RED: Add tests proving audit payloads include actor, path, decision, required surface, reason, and repair hint.
- GREEN: Add protected-state audit event builder and optional Beads audit recorder.
- REFACTOR: Reuse existing redaction from `lib/audit-evidence.js` where possible.

## Task 4: Documentation

TDD:
- RED: Add docs consistency test for the protected-state reference page and index link.
- GREEN: Add `docs/reference/protected-state-surfaces.md` and update `docs/INDEX.md`.
- REFACTOR: Keep docs aligned to the actual manifest categories.
