# Backlog, Sprint, and Frontend Planning Model

## Terms

- **Epic:** large outcome with many features/stories.
- **Feature:** user-visible capability or system capability.
- **Story:** user/agent-oriented slice; Beads may store this as `feature` plus label until Kernel supports native story type.
- **Task:** implementation unit.
- **Decision:** architecture/product decision that can block tasks.
- **Bug/chore:** maintenance work.
- **Sprint/iteration:** time-boxed planning bucket, not hierarchy.
- **Release/milestone:** delivery bucket, not hierarchy.
- **Stage state:** workflow execution progress inside a work item, not issue status.

## Canonical fields to plan for

```text
issue.id
issue.type
issue.title
issue.description
issue.status
issue.priority
issue.parent_id
issue.depends_on[]
issue.blocks[]
issue.owner_claim
issue.sprint_id
issue.release_id
issue.stage_state
issue.provider_extensions
issue.created_at
issue.updated_at
issue.entity_revision
```

## Status lifecycle

```text
backlog -> ready -> in_progress -> review -> done
backlog -> cancelled
ready/in_progress/review -> blocked
blocked -> ready/in_progress/review
```

The exact previous status should be preserved when blocking so unblocking can return to the right lane.

## Frontend board views

### Backlog board

Groups issues by `type`, `priority`, `parent_id`, and `release_id`. This is the planning view.

### Sprint board

Groups issues by `sprint_id` and status. This is the execution planning view.

### Ready-work queue

Filters issues where dependencies are satisfied, status is `ready`, and no active conflicting claim exists.

### Agent work view

Filters by `owner_claim.actor`, current lease, worktree/session metadata, and stage state.

### Roadmap view

Groups epics/features by release/milestone and completion rollups from children.

## Agent-friendly JSON shape

```json
{
  "issue": { "id": "forge-...", "type": "task", "status": "ready", "entity_revision": 12 },
  "planning": { "parent_id": "forge-...", "sprint_id": "sprint-2026-06-a", "release_id": "0.0.20" },
  "readiness": { "ready": true, "blocked_by": [], "depends_on": [] },
  "claim": { "owner": null, "lease_expires_at": null },
  "context": { "recap_command": "forge recap forge-... --json", "sources": [] }
}
```

## Migration note

Beads currently rejected custom issue types `story` and `spike` in this backlog creation pass. Until Kernel owns a richer taxonomy, represent these as supported Beads types plus labels, and keep the richer type in Kernel/provider-extension metadata.

## Evaluator-required additions

### First-class planning buckets

Sprint, release, and milestone should be entities, not just string fields on issues. Each needs id, name, state, dates, owner/goal, capacity or scope, ordering, and revision.

### Board rank and mutation events

Frontend drag/drop operations must produce Kernel events with `expected_revision` and `idempotency_key`, including:

- `issue.reordered`
- `issue.status_changed`
- `issue.sprint_assigned`
- `issue.release_assigned`
- `issue.blocked`
- `issue.unblocked`
- `issue.type_changed`

### Readiness policy

Ready work must consider dependencies, explicit blockers, deferred/due windows, acceptance criteria, required workflow gates, active claims, projection quarantine, conflicts, and policy-disabled work.

### Response envelope

Frontend/agent query responses should include read-model revision, server/local sequence, pagination cursor, facets, stale indicator, and projection health.
