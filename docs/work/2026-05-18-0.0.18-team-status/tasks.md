# Tasks: 0.0.18 Team Status Surface

## Task 1: Shared Runtime Snapshot Categories

RED: Add tests for blocked and stale issue categorization in the Beads snapshot helper.

GREEN: Extend `lib/status/beads-snapshot.js` so the snapshot exposes blocked, stale, and board-ready categories while preserving existing active, ready, and recent completion behavior.

REFACTOR: Keep date and owner helpers small and deterministic.

## Task 2: Personal Status Human And JSON Output

RED: Add tests for `forge status --json`, clean repo context, active work, blocked work, stale work, and empty state.

GREEN: Update `lib/status/presenter.js` and `lib/commands/status.js` so zero-argument status renders the richer categories and returns JSON when requested.

REFACTOR: Keep explicit workflow-state output compatible with the existing authoritative stage-only format.

## Task 3: Team Board Command

RED: Add tests for a `board` command that renders active, ready, blocked, stale, and completed categories in text and JSON modes.

GREEN: Add `lib/commands/board.js` using the same snapshot state as status.

REFACTOR: Share formatting primitives where it keeps the code smaller and clearer.

## Task 4: CLI And Documentation

RED: Add or update CLI/help/docs assertions for the new command and sample output.

GREEN: Register the board command through the existing command registry and document `forge status` and `forge board` behavior, limits, JSON output, sample output, and non-scope.

REFACTOR: Keep docs concise and link them from the docs index if an appropriate reference section exists.
