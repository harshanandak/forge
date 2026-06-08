## Description
Roadmap alignment issue for the Kernel backlog, storage authority, and Project Knowledge Layer plan after researching MemPalace.

Plan artifact: `docs/work/2026-06-06-kernel-backlog-memory-roadmap/plan.md`
Research artifact: `docs/work/2026-06-06-kernel-backlog-memory-roadmap/research.md`

## Scope
- Confirm storage-mode boundaries: SQLite local authority, server team authority, Beads/GitHub/Linear projections.
- Split backlog, sprint/story/task, and workflow-stage concepts into separate Kernel surfaces.
- Plan a verbatim-first Project Knowledge Layer inspired by MemPalace lessons.
- Create child implementation issues without doing the full rewrite in one PR.

## Acceptance Criteria
- Child issues exist for storage boundaries, backlog taxonomy, knowledge index, orient/recap, concurrency tests, Beads fidelity, Hermes consumer harness, and team authority gate.
- Roadmap docs explain why SQLite is local-only and why team writes need server serialization.
- No runtime storage replacement is performed as part of this planning issue.
