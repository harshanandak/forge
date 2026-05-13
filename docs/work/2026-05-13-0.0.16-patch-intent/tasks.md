# 0.0.16 Patch Intent Baseline Tasks

## Task 1: Patch Intent Core

- Add tests first for anchor discovery, stable IDs, rename resolution, orphan detection, and config interaction.
- Implement `lib/patch-intent.js`.

## Task 2: CLI Record Command

- Add tests first for `forge patch record --from-diff`.
- Implement `lib/commands/patch.js`.

## Task 3: Documentation

- Add `docs/reference/patch-md-format.md` with three worked examples.
- Explain how records feed later upgrade/rollback safety and what remains non-scope.

## Task 4: Validation and Ship

- Run focused tests.
- Run typecheck, lint, tests, and security/check validation.
- Push `codex/0.0.16-patch-intent` and create the requested PR.

