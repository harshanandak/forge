# Define local-only and team close/verify authority semantics

## Problem

Post-merge verification currently closes Beads issues and refreshes tracked `.beads` metadata. In a protected-default-branch repository, that metadata cannot be pushed directly to `master`, and opening a follow-up PR just to persist tracker close state would make every successful merge depend on another merge.

This proves that routine close/verify state must not be stored by committing tracker metadata to the project repository.

## Scope

- Define local-only close/verify persistence through the local Kernel SQLite authority.
- Define team/cross-machine close/verify persistence through serialized server authority.
- Define projection behavior for GitHub, Linear, Beads, and explicit Kernel export artifacts after authority acceptance.
- Define offline/team-mode refusal behavior when the server cannot accept a shared write.
- Update `/verify` reporting so it distinguishes local-only, server-required, server-accepted, and projection-pending close state.

## Acceptance Criteria

- `forge close` and `/verify` do not require committing `.beads` or Kernel projection metadata to the protected default branch as the ordinary durability path.
- Local mode records close/verify state in the local Kernel SQLite authority and reports it as local-only.
- Team mode blocks close/start/stage-transition writes unless server authority accepts them.
- Projection failures are visible but do not roll back accepted local/server authority writes.
- Tests prevent reintroducing "metadata-only PR" or "direct protected-branch tracker push" as the normal close/verify workflow.

## Out of Scope

- Implementing the full team authority server.
- Removing Beads import/export compatibility.
- Replacing all existing `bd` call sites in one PR.
