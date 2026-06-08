## Description
Forge lifecycle commands can leave generated docs/harness/runtime files dirty during push, review, verify, merge, or post-merge cleanup. This forces agents to stash generated files just to close the workflow.

Reference: `docs/work/2026-06-06-kernel-backlog-memory-roadmap/workflow-friction-amendments.md#1-generated-forge-docsharness-files-reappear-during-lifecycle-commands`

## Scope
- Audit `forge status`, `forge validate`, `forge push`, `forge ship`, review helpers, setup/update paths, and post-merge cleanup for generated file writes.
- Identify files that are durable planning artifacts vs generated harness outputs vs runtime/projection state.
- Define a generated-state manifest/contract for each generated surface: owner command/API, protected-state category, source inputs, content hash/version, line-ending policy, timestamp policy, and whether it is generated projection, runtime/projection state, or durable artifact.
- Make no-op regeneration content-addressed/idempotent so unchanged files do not become dirty.
- Route intentional generated writes through owning Forge surfaces with clear evidence/repair hints.
- Add diagnostics that explain whether dirty generated files are expected, stale, or unsafe.
- Add clean-checkout + linked-worktree lifecycle smoke coverage for push, review, verify, merge, and post-merge cleanup.

## Acceptance Criteria
- Reproducing a push/review/verify/merge lifecycle on a clean checkout does not leave generated Forge docs/harness files dirty when no semantic content changed.
- If generated files are stale, Forge prints a single safe command to update them and explains the owning surface.
- Tests cover pre/post `git status --porcelain`, CRLF/line-ending stability, timestamp-free generation, backup snapshot stability, repeated command idempotency, and protected-state interaction.
- Generated-file writers use atomic compare-before-write behavior and do not rewrite identical content.
- Normal repair guidance never says to stash generated files as the expected workflow path.
- Agents no longer need to stash generated files to close a normal workflow.
