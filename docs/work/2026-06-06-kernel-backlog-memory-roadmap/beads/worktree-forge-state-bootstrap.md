## Description
New worktrees, especially from older Forge versions, may not have usable Forge state. This blocks issue claiming, validation, hook enforcement, and workflow continuation.

Reference: `docs/work/2026-06-06-kernel-backlog-memory-roadmap/workflow-friction-amendments.md#5-forge-state-can-be-unconfigured-in-new-worktrees`

## Scope
- Add a worktree state doctor for `.forge`, `.beads`/projection state, Kernel DB/bootstrap state, git common-dir mapping, adoption profile, and hooks.
- Key the canonical Kernel DB/bootstrap location by git common-dir and treat `.beads` as projection/import state, not authority.
- Determine whether the issue still exists in the current release branch with fixtures for old-version and current-version worktrees.
- Provide repair commands that initialize missing state without overwriting authority/projection data.
- Include backup/quarantine behavior for partial or old worktree state and embed hook doctor status as a sub-result instead of duplicating checks inconsistently.
- Ensure worktree state uses the intended local authority path and does not depend on Dolt as hot-path authority.
- Route repair writes through protected-state-aware Forge APIs and declared surfaces.

## Acceptance Criteria
- Doctor reports configured/unconfigured/partial state with machine-readable JSON.
- Repeated doctor/repair is idempotent and becomes no-op after first success.
- Fresh current-version worktrees pass without manual stashing or ad hoc setup.
- Old-version worktree fixtures either self-heal or produce exact repair steps.
- Existing authority/projection data is never overwritten; partial state is backed up or quarantined with evidence.
- Regression tests cover Windows/MSYS paths and git common-dir mapping.
