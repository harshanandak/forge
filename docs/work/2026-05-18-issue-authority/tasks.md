# 0.0.18 Issue Authority Tasks

## Task 1: IssueAdapter SPI

RED: Add tests for required issue adapter methods, status mapping, and authority decisions.

GREEN: Add `lib/issue-adapter.js` with validation helpers and default throwing methods.

REFACTOR: Keep the API parallel to the review adapter foundation without sharing review-specific logic.

## Task 2: Beads Reference Adapter

RED: Add tests proving Beads delegates create/list/read/update/close/comment through the existing operation runner.

GREEN: Add `lib/adapters/beads-issue-adapter.js` and route `lib/forge-issues.js` through the adapter.

REFACTOR: Preserve existing `createBeadsIssueBackend` and `runIssueOperation` compatibility.

## Task 3: Authority and Conflict Contract

RED: Add tests for GitHub-owned, Forge-owned, cache, and unknown field decisions plus status mapping.

GREEN: Expose `decideIssueAuthority` and conflict decision helpers through the SPI.

REFACTOR: Reuse `lib/issue-sync/authority.js` instead of duplicating field tables.

## Task 4: Documentation

RED: Confirm docs mention IssueAdapter, authority model, conflict behavior, sync boundaries, and non-scope.

GREEN: Update `docs/reference/ADAPTERS.md` and `docs/guides/BEADS_GITHUB_SYNC.md`.

REFACTOR: Keep PR #168 review adapter docs intact and add issue-specific sections.

## Task 5: Validation and Ship

Run targeted tests first, then lint and broader validation. Ship as PR `0.0.18 issue authority` with issues covered, validation commands, authority model, conflict behavior, and non-scope.
