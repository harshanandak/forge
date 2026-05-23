# Beads And GitHub Sync

Forge uses Beads as the local/reference issue adapter and GitHub Issues as the shared remote issue surface when sync is configured.

## Authority Model

GitHub owns shared team-visible fields:

- issue number, node id, URL
- title and body
- open/closed state
- assignees, labels, milestone
- remote update timestamps

Forge/Beads owns local workflow context:

- Forge/Beads issue id
- dependencies and parent/child links
- workflow stages
- acceptance criteria
- progress notes and decisions
- stage transitions
- recovery and drift metadata

Do not hand-edit Beads state to force GitHub fields unless a recovery runbook explicitly says to.

## Setup

```bash
bunx forge setup --sync --agents claude,cursor
```

This scaffolds GitHub sync files and workflow support. It does not mean every repository already has branch protection, tokens, and required checks configured.

## Routine Sync

```bash
forge sync
```

`forge sync` runs Beads/Dolt sync behavior. It is distinct from `forge setup --sync`.

## Snapshot-Based Flow

Current sync should rely on exported backup/snapshot data and GitHub workflow artifacts, not stale examples that modify live `.beads/issues.jsonl` directly in CI.

Expected high-level flow:

1. GitHub issue event triggers workflow.
2. Workflow validates actor, labels, mapping, and loop-prevention guards.
3. Workflow uses `bd`/Forge-supported sync logic.
4. Beads backup or snapshot files are exported for repository-visible state.
5. A commit records the sync result when allowed by branch protection.

## Loop Prevention

Use guards such as:

- skip bot-authored sync events
- skip sync commits with known sync prefixes
- honor opt-out labels such as `skip-beads-sync`
- keep a mapping between GitHub issue numbers and Beads ids

## Recovery

When GitHub sync fails:

```bash
gh auth status
gh run list --branch master --limit 10
bd doctor
bd dolt status
forge sync
```

If the failure is branch protection (`GH006`), route the Beads metadata change through a follow-up PR or the configured sync workflow.

If the failure is Dolt runtime state, repair Beads/Dolt before closing or mutating issues. See [Support](SUPPORT.md).

## Known Limits

- Fork sync is not guaranteed.
- GitHub Projects automation is not Forge issue sync.
- Full comment/discussion import is outside the current adapter contract.
- Credentials and PAT configuration are repository-specific.

