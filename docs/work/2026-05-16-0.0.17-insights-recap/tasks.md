# 0.0.17 Insights And Recap Tasks

## Task 1 - Pattern Extraction

RED: Add tests for extracting interaction patterns, issue-theme patterns, audit patterns, and empty/low-signal history.

GREEN: Implement a focused insights module that reads existing Beads and Forge evidence files without adding a datastore.

REFACTOR: Keep parsing pure and deterministic so command tests can use temporary fixture projects.

## Task 2 - Skill Suggestion Decisions

RED: Add tests for candidate ranking/filtering and accept/reject behavior.

GREEN: Persist accept/reject decisions through `lib/memory/typed-api.js` with provenance and issue references.

REFACTOR: Keep accepted suggestions as decision records, not trusted executable installs.

## Task 3 - CLI Commands

RED: Add command tests for `forge insights`, `forge insights --review-feedback`, `forge insights accept/reject`, and `forge recap`.

GREEN: Add `lib/commands/insights.js` and `lib/commands/recap.js` following the command registry interface.

REFACTOR: Support text and JSON output with stable, testable formatting.

## Task 4 - Documentation

RED: Add doc coverage expectations for what insights can and cannot infer.

GREEN: Add a reference doc and PoC report with example output, limitations, and non-scope.

REFACTOR: Link the new reference from the docs index without changing unrelated release docs.
