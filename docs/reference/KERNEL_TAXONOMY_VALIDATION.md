# Kernel Taxonomy, Readiness, and Validation

Reference for the Forge Kernel issue taxonomy collapse and its read-model/validation
layer, implemented per **D18** (see
[`docs/work/2026-06-06-kernel-backlog-memory-roadmap/decisions.md`](../work/2026-06-06-kernel-backlog-memory-roadmap/decisions.md))
and roadmap items `forge-2agy.9.2.1`, `.9.2.2`, `.9.2.6`, `.9.2.7`, `.9.2.8`, `.9.2.9`.

The four planning axes are kept **separate** (D5): stored **status**, parent/child
**hierarchy**, sprint/release planning **bucket**, and workflow **stage** execution. A
task can be in a sprint, have a parent epic, be derived-ready, and currently sit in the
`validate` stage — these are not the same field.

---

## 1. Issue types (4) — `lib/kernel/taxonomy-validator.js`

A type only earns existence if it changes Kernel behavior (routing, gates, board
grouping, rollup). `feature`, `story`, `chore`, and `spike` are **labels**, not types.

| Type | `canParent` | `claimable` | `blocksOthers` | `rollup` | Board group |
| --- | --- | --- | --- | --- | --- |
| `epic` | ✅ (only container) | ❌ | ❌ | ✅ | `roadmap` |
| `task` | ❌ | ✅ | ❌ | ❌ | `backlog` |
| `bug` | ❌ | ✅ | ❌ | ❌ | `backlog` |
| `decision` | ❌ | ❌ | ✅ (gates dependents) | ❌ | `decisions` |

`TYPE_BEHAVIORS` is the single source of truth for these mappings. Enums are enforced at
the **validation layer**, not as DB constraints, so label-based extensibility and derived
readiness stay outside the stored column set.

## 2. Status lifecycle (5 stored)

Stored statuses: `open`, `in_progress`, `review`, `done`, `cancelled`.

```text
open ──► in_progress ──► review ──► done
 ▲           │             │
 └───────────┘             │   (rework: review ──► in_progress, in_progress ──► open)
open / in_progress / review ──► cancelled        (done, cancelled are terminal)
```

`STATUS_TRANSITIONS` encodes the legal moves. `validateStatusTransition(from, to)` throws
a `TaxonomyValidationError` for illegal moves and unknown statuses; a same-status
transition is treated as an idempotent no-op. `done` and `cancelled` are terminal — no
transition leaves them.

## 3. Derived readiness — `lib/kernel/readiness-model.js`

`ready` and `blocked` are **derived read-model facts, never stored statuses** (D18). A
blocker that clears makes the issue ready again in whatever stored status it held — there
is no "preserve previous status" hack. "Backlog" is simply `open` with readiness
conditions unmet.

`deriveReadiness(issue, context)` returns:

```json
{
  "id": "forge-1",
  "status": "open",
  "ready": true,
  "blocked": false,
  "blocked_by": [],
  "reasons": [],
  "state": "ready"
}
```

Readiness policy considers: blocking dependencies (upstream not in a terminal status —
`done` and `cancelled` both clear, so a cancelled blocker never wedges a dependent),
unresolved decision dependencies, projection **quarantine**/conflicts, required workflow
**gates**, **defer** windows, **policy-disabled** work, and an **active conflicting
claim** by another actor. Reason codes (`READINESS_REASONS`): `dependency` (carries a
`decision: true` flag when the blocker is a decision issue), `quarantine`, `conflict`,
`gate`, `claimed`, `deferred`, `policy_disabled`.

**Acceptance-criteria and due-date readiness** are modeled through the generic `gates`
input (an acceptance/definition-of-ready gate, or a due-window gate the caller supplies),
not as separate hardcoded field checks — so the policy stays open to caller-defined gates
without the read model owning every "definition of ready" rule.

Summary `state` (precedence high→low): `closed` → `blocked` → `gated` → `deferred` →
`claimed` → `disabled` → `ready` → `backlog`. `blocked` (dependencies/quarantine/conflict)
always outranks softer not-ready reasons. Because the single `state` collapses multiple
conditions, consumers picking next work should read the full `reasons[]` — e.g. a claim
hidden behind a defer window is in `reasons[]` even when `state` reports `deferred`.
Terminal issues are `closed` — neither ready nor blocked.

`buildReadinessIndex({ issues, dependencies, claims, conflicts, gates, now, actor,
policyDisabledIds })` computes readiness for a whole board, resolving each dependency's
status from the issue set and returning a `readyQueue` ordered by authoritative numeric
rank then id, plus the `blocked` id list. The ready-work queue excludes terminal,
deferred, gated, policy-disabled, and claimed-by-other issues.

## 4. Validation layer — `lib/kernel/taxonomy-validator.js`

| Function | Enforces |
| --- | --- |
| `validateIssueTaxonomy(issue)` | type/status enum membership; rejects self-parent |
| `validateStatusTransition(from, to)` | status lifecycle rules (throws) |
| `findDependencyCycles(deps)` / `assertAcyclicDependencies(deps)` | dependency graph acyclicity (only `blocks` edges) |
| `validateParentChild(issue, parent)` | parent exists, parent type `canParent`, no self-parent |
| `findParentCycle(issuesById, startId)` | parent-chain cycle detection |
| `validateClaim(claim, { now, issueType })` | actor present, valid claim state, claimable type, lease not expired |
| `validateActiveClaimUniqueness(claims)` | at most one active claim per issue |

These complement (do not replace) the broker/DB claim-lease invariants enforced
elsewhere; the validation layer is the pure, storage-agnostic checker.

## 5. Priority rank vs P0–P4 projection

A single numeric rank is authoritative for ordering; **P0–P4 is a display projection
only** (D18). `rankForPriorityLabel(label)` ingests a label/number to the authoritative
rank; `priorityLabelForRank(rank)` projects a rank to a display label clamped to `P0..P4`;
`normalizeRank(value)` coerces to a non-negative integer.

## 6. Planning bucket entities — `lib/kernel/planning-buckets-schema.js`

Sprint, release, and milestone are first-class Kernel entities (`forge-2agy.9.2.7`), not
string fields on issues. Each table (`kernel_sprint`, `kernel_release`,
`kernel_milestone`) carries `id`, `name`, `state`, `rank`, owner/goal, dates,
`entity_revision`, and **read-model rollup counters** (`total_count`, `completed_count`).
The schema reuses the shared `lib/kernel/schema.js` builders and passes
`validateKernelSchema`; `getPlanningBucketsSchema()` is migration-renderable through the
existing `buildSchemaMigration` renderer.

State vocabularies:

- Sprint: `planned`, `active`, `completed`, `cancelled`
- Release: `planned`, `in_progress`, `released`, `cancelled`
- Milestone: `planned`, `reached`, `missed`, `cancelled`

The extended `kernel_issues` columns wire issues to these buckets and to hierarchy and
stage: `parent_id` (self-referencing), `sprint_id`, `release_id`, `stage_state`,
`labels`, `acceptance_criteria`, `estimate`.

## 7. Board rank and mutation event model

Frontend drag/drop and assignment operations must produce Kernel events carrying
`expected_revision` and `idempotency_key` (`forge-2agy.9.2.6`). `BOARD_MUTATION_EVENT_TYPES`:

- `issue.reordered` — board rank change. Per D18 there is a **single** authoritative
  numeric ordering rank (`priority_rank`); P0–P4 is its display projection. There is no
  separate board-only rank column.
- `issue.status_changed`
- `issue.sprint_assigned`
- `issue.release_assigned`
- `issue.blocked` / `issue.unblocked` — recorded transitions of the derived readiness
  edge, emitted for audit; readiness itself remains computed, not stored
- `issue.type_changed`

Each event is validated optimistically against the entity's current revision and is
idempotent on replay, consistent with the Kernel event/outbox contract.

## Board views (frontend implications)

- **Backlog board** — group by `type`, `priority`, `parent_id`, `release_id`.
- **Sprint board** — group by `sprint_id` and status.
- **Ready-work queue** — `buildReadinessIndex(...).readyQueue` (derived).
- **Agent work view** — filter by claim actor, lease, worktree/session, and `stage_state`.
- **Roadmap view** — group epics by release/milestone with child rollups.
