## Description
The roadmap needs explicit release lanes and version-level sequencing so the team knows which core self-hosting issues must land before the next feature release and which work can follow later.

Reference: `docs/work/2026-06-06-kernel-backlog-memory-roadmap/workflow-friction-amendments.md#8-release-sequencing-is-not-explicit-enough`

## Scope
- Define near-term release lanes: self-hosting stability, new-project setup correctness, Kernel/TS state foundation, Knowledge/architecture capture, and team authority.
- Assign existing and new issues to probable release lanes without pretending exact dates are guaranteed.
- Mark dependencies so downstream features do not start before setup/state/hooks foundations are ready. This issue defines the ordering and should not be blocked by the broad parent lanes it is sequencing.
- Add release gates for clean push/verify/merge lifecycle, fresh setup correctness, worktree state, and Dolt hot-path reduction.

## Acceptance Criteria
- `issue-map.md` includes a release-lane table with issue IDs and dependency notes.
- Next-release gates explicitly prioritize self-hosting workflow reliability and new-project adoption correctness.
- Implementation order is updated to avoid starting downstream Knowledge/hook UX features before core state/setup blockers.
- The release smoke gate includes clean checkout + linked worktree + generated harness + hooks + Forge state + projection state completing push/review/verify/merge/post-merge cleanup without stash/manual repair.
- Evaluator review confirms release sequencing has no critical missing dependency.
