# forge-2agy.9.8.5 - Build Kernel-authority GitHub Issues projection

## Problem

The removed Beads/GitHub workflow sync path should not be rebuilt on top of Beads runtime files. Once Forge has its own local SQLite Kernel authority and serialized server authority for team/cross-machine work, GitHub Issues can become an external projection from that authority.

## Scope

- Design the Kernel/server-owned GitHub Issues projection contract.
- Map Kernel work items, status, labels, assignees, comments, and closure events to GitHub Issues.
- Define idempotency keys, retry behavior, dead-letter handling, and conflict reporting.
- Keep `.beads/` out of the write path and out of committed repository metadata.
- Preserve branch protection: no metadata-only commits or direct protected-branch pushes for issue sync.

## Dependencies

- Local SQLite Kernel authority exists and owns issue/work-item writes.
- Team/cross-machine serialized server authority exists for shared writes.
- Projection outbox/retry/dead-letter behavior is defined.

## Acceptance

- GitHub Issues updates are emitted from accepted Kernel/server events, not from Beads runtime files.
- Local-only mode clearly reports that GitHub projection is unavailable without server authority.
- Team mode serializes the Kernel mutation first, then projects to GitHub.
- Failed GitHub projection does not roll back accepted Kernel authority state; it records retry/dead-letter evidence.
- No `.beads/` files, Beads backup snapshots, or metadata-only commits are required.
