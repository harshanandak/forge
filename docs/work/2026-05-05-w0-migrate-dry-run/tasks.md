# Tasks

## Task 1: Add dry-run validation/reporting core

- RED: Add tests expecting a migration dry-run report module.
- GREEN: Implement repo validation for Git, Beads JSONL, v2 workflow matrix, and planned v3 config diff.
- REFACTOR: Keep rendering separate from validation for command and test reuse.

## Task 2: Wire `forge migrate --dry-run`

- RED: Add command tests for dry-run output and non-dry-run refusal.
- GREEN: Add `lib/commands/migrate.js` as an auto-discovered registry command.
- REFACTOR: Keep Wave 0 behavior dry-run-only.

## Task 3: Fixture corpus readiness

- RED: Add tests requiring explicit v2 fixture corpus execution.
- GREEN: Add `--fixture-corpus` support that materializes existing corpus fixtures in temp dirs.
- REFACTOR: Keep corpus failures visible without blocking the default repo PoC.

## Task 4: Validation documentation

- Document exact commands run and observed results in `validation.md`.
