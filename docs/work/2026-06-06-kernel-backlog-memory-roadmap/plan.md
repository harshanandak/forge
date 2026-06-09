# Kernel Backlog, Storage, and Project Knowledge Roadmap Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task after the roadmap issues are accepted.

**Goal:** Turn the current Forge Kernel reset into a safer roadmap for issue/backlog authority, storage choices, multi-workspace coordination, and project knowledge retrieval without prematurely replacing proven Beads/Dolt behavior.

**Architecture:** Forge Kernel remains the authority for issues, claims, workflow state, runs, decisions, and projections. Local mode uses SQLite WAL keyed by git common-dir for one-user/many-worktree coordination; team mode must use a serialized server authority before multiple users or machines write. The knowledge layer follows the MemPalace lesson: store/source-index verbatim project artifacts first, add summaries/extracted facts only as reviewable projections.

**Tech Stack:** Bun/Node.js Forge CLI, local SQLite WAL broker, Beads compatibility adapter, docs/work artifacts, future FTS5/vector read models, optional Cloudflare Worker + Durable Object team authority.

---

## Why This Plan Exists

The current direction is correct but risky if we collapse three separate concerns into one datastore:

1. **Issue authority** — what work exists, status, owner/claim, dependencies, priority, sprint/release grouping.
2. **Project knowledge** — plans, decisions, evidence, prior discussion, architecture direction, and rationale retrieval.
3. **Agent memory** — private or agent-native working memory such as Hermes memories/skills or Claude/Codex/Cursor context.

Forge should own the first two at the project/team level. It should not compete with Hermes or other agents for private reasoning memory. Agents consume Forge state; Forge records objective state, provenance, conflicts, and projections.

## MemPalace Research Takeaways Applied to Forge

Research source: `https://github.com/mempalace/mempalace`, local clone inspected at `/tmp/mempalace`.

### 1. Store verbatim first; do not summarize away the source

MemPalace's core benchmark claim is that raw/verbatim session storage plus semantic search is a very strong baseline. Their docs explicitly warn that LLM-extracted memories lose context: why a decision was made, alternatives considered, and the original wording.

**Forge implication:**

- Index `plan.md`, legacy `design.md`, `tasks.md`, `decisions.md`, `evidence.md`, issue bodies, comments, stage runs, and validation logs as verbatim source chunks.
- Keep summaries, memory proposals, accepted facts, and knowledge graph triples as derived/read-model records with provenance back to exact source files/events.
- Do not let an extracted memory/fact become authority unless it is accepted through a Kernel event.

### 2. Layer memory by startup budget

MemPalace uses L0/L1/L2/L3:

- L0 identity: tiny, always loaded.
- L1 essential story: bounded wake-up summary.
- L2 scoped recall: wing/room-filtered retrieval.
- L3 deep search: full semantic query.

**Forge implication:**

- `forge orient` should produce a bounded project/work-item orientation, not dump the entire repo history.
- `forge recap <issue>` should retrieve scoped work-item history.
- `forge search` or `forge knowledge query` can be the deeper retrieval path.
- Harnesses like Hermes should receive bounded orientation plus links/commands for deeper recall, not huge prompt injections.

### 3. Scoping beats a flat corpus

MemPalace's wings/rooms/halls are mostly operational metadata filters. The value is predictable scoping, not magic retrieval.

**Forge implication:**

Use Forge-native scope fields:

- project/repo
- worktree
- issue id
- parent epic
- release/milestone
- sprint/iteration
- artifact type: plan/tasks/decisions/evidence/comment/run/log
- stage/substage
- actor/session
- source path/event id

This maps naturally to SQL indexes and future vector metadata filters.

### 4. Graph facts need temporal validity and provenance

MemPalace's knowledge graph stores entity triples with `valid_from`, `valid_to`, confidence, and source references.

**Forge implication:**

If Forge adds a project knowledge graph, it should be temporal and source-backed:

- `issue X assigned_to agent Y` valid during claim lease.
- `workflow stage validate required` valid under config revision.
- `plan chose SQLite WAL for local mode` valid from decision event until superseded.
- legacy work-item `design.md` files may be indexed/read during migration; new work-item planning uses `plan.md`; `design.md` is reserved for durable architecture/product design.

Contradiction checks then become possible: new plan conflicts with locked decision, stale sprint date, wrong assignee, or projection trying to override Kernel authority.

### 5. Storage backends need a narrow contract and conformance tests

MemPalace introduced backend abstractions with typed result objects, explicit capabilities, backend health, and conformance tests. Their roadmap keeps ChromaDB default while allowing pgvector, Qdrant, LanceDB, and SQLite exact backends.

**Forge implication:**

Forge should not debate “SQLite vs Dolt vs Cloud” as one choice. It needs a storage-class contract:

- **Authority local:** SQLite WAL broker.
- **Authority team:** server-side serialized authority, likely Cloudflare Durable Object per project.
- **Projection / compatibility / history:** Beads/Dolt export/import state.
- **Read model:** SQLite FTS5/vector indexes, rebuildable.
- **Archive:** local files/R2 evidence bundles.
- **Agent memory:** adapter output only, not authority.

Each store gets conformance tests for isolation, revision checks, idempotency, projection failure, and rebuild behavior.

### 6. Concurrent writers must be explicit

MemPalace hardens Chroma writes with per-palace locks, non-blocking lock failure, re-entrant same-thread guards, PID diagnostics, WAL, and integrity checks. Their lock comments show real bugs from concurrent hooks/agents corrupting indexes.

**Forge implication:**

For local Forge:

- SQLite WAL is acceptable for one machine with many worktrees.
- All mutations must go through Kernel APIs using transactions, `expected_revision`, idempotency keys, and busy-timeout/retry policy.
- Claims are leases, not labels.
- Test multi-process contention, not just unit-level driver behavior.

For team Forge:

- SQLite in git is not enough.
- Multiple users/machines need a serialized authority. Use a Durable Object or equivalent before claiming “team-safe writes.”
- Git/Beads/GitHub/Linear remain projections or sync surfaces, never conflict-resolution authorities.

## Storage Decision

### Keep the planned SQLite local broker, with stricter safety gates

SQLite WAL is the right local-first authority choice only inside a narrower safety envelope:

- one physical developer machine;
- supported local filesystem, not network share or cloud-sync folder where detectable;
- many worktrees sharing one canonicalized git common-dir and Kernel DB path;
- many local agents/sessions only if all writes use one Kernel broker transaction path;
- atomic event append, entity revision compare-and-swap, materialized entity update, and projection outbox enqueue;
- real SQLite driver conformance for WAL, busy handling, backup/checkpoint, and FTS5 where needed;
- idempotency collision checks and DB-enforced claim lease invariants;
- real multi-process contention tests before claiming local multi-agent safety.

It is not enough for:

- multiple machines writing independently;
- offline divergent issue graphs that later merge automatically;
- branch-isolated issue history equivalent to Dolt;
- semantic three-way merges of issue state.

### What Dolt/Beads gives that SQLite does not

Beads with Dolt offers stronger git-like database sync, branch-ish behavior, and a battle-tested issue graph. If Forge replaces it, we must consciously replace or drop these properties:

- cross-machine merge behavior;
- Dolt history/branch operations;
- existing Beads commands and ecosystem;
- graph ready-work semantics;
- import/export fidelity.

Therefore: **do not remove Beads until Kernel import/export and projection conformance are strong.** Beads should remain a migration/projection adapter during the Kernel transition.

After deeper review, Dolt should be treated as a projection/history/branching substrate only unless a future accepted Project Design or ADR explicitly reopens authority strategy. Evaluate Dolt embedded/server/remotes for branchable backlog history, offline projection experiments, provenance/history, and Beads migration fidelity without making it part of the Kernel authority path. Dolt still does not replace Forge domain guards by itself: claim leases, idempotency, workflow gates, permissions, and projection quarantine remain Kernel/server responsibilities.

### Recommended authority split

| Mode | Authority | Why |
|---|---|---|
| Solo local | SQLite WAL broker in git common-dir | Simple, fast, one-machine concurrency |
| Team/multi-machine | Cloud/server serialized authority | Prevents divergent writers and lost updates |
| Beads/Dolt | Import/export projection/history substrate | Preserves existing data and evaluates Dolt history/branch/merge/remotes outside the Kernel authority path |
| GitHub/Linear | Projection | Useful external views, not canonical |
| Knowledge search | Rebuildable read model | Can be regenerated from artifacts/events |

## Issue / Backlog Model

Forge should model work in a way that is both agent-friendly and UI-friendly.

Minimum issue fields:

- `id`
- `title`
- `body`
- `type`: epic, feature, story, task, bug, chore, decision, spike
- `status`: backlog, ready, in_progress, blocked, review, done, cancelled
- `priority`: P0-P4 plus numeric rank
- `parent_id`
- `release_id` or `milestone`
- `sprint_id` or iteration bucket
- `stage_state`: current workflow stage/substage
- `claim_state`: active/stale/reclaimable/released
- `assignee` as projection/user-facing field; claim lease remains authority
- `labels`
- `acceptance_criteria`
- `estimate`
- `source_refs`
- `entity_revision`

Important distinction:

- **Backlog** is a status/queue of not-yet-ready work.
- **Sprint/iteration** is a planning bucket.
- **Task** is a child work item, not the same as a checklist line.
- **Stage run** is execution state for a work item.

## PR Update Scope

This planning PR should not implement the full system. It should make the roadmap safer and executable:

1. Add this plan and decisions record.
2. Add Beads backlog issues for the next implementation slices.
3. Update the roadmap language to encode the storage split.
4. Avoid large schema/code changes until 0.0.20 conflict quarantine and migration UX are finished.

## Roadmap Sequence

### Phase A — Current PR: decision and backlog alignment

- Record MemPalace research lessons.
- Confirm SQLite local broker is for local authority only.
- Confirm Cloud/team authority is required before multi-machine writes.
- Add issue/backlog taxonomy issues.
- Add Knowledge Layer MVP issues.

### Phase B — 0.0.20 finish: Kernel local authority foundation

- Finish schema/migration classifier.
- Finish local SQLite WAL broker command contract.
- Finish conflict quarantine and idempotency fixtures.
- Finish Beads migration UX docs.

### Phase C — 0.0.21: Local worktree coordination

- Implement claim leases.
- Add stale/reclaimable logic.
- Add multi-process local contention tests.
- Add worktree-aware status/orient output.

### Phase D — 0.0.22: Workflow and backlog planning UI surfaces

- Add customizable workflow stages over Kernel.
- Add backlog/sprint/milestone read models.
- Add UI/API shapes for planning boards.

### Phase E — 0.0.23: Project Knowledge Layer MVP

- Verbatim artifact index over docs/work and Kernel events.
- FTS5 first; vector search optional later.
- `forge orient`, `forge recap`, and `forge knowledge search`.
- Derived summaries/facts as reviewable proposals, not authority.

### Phase F — 0.0.24+: Provider/harness integration

- Hermes harness consumes Forge orientation and emits stage evidence.
- Provider registry records available agent skills/tools.
- Agent-native memories remain private/project-adapter inputs.

### Phase G — 0.0.25+: Team authority

- Cloudflare Worker API and Durable Object per project.
- Server sequence numbers and projected read models.
- GitHub/Linear/Beads projections via outbox/queues.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| SQLite mistaken as multi-machine authority | Lost updates/divergent truth | Explicit docs, command guardrails, team mode requires server authority |
| Overbuilding memory extraction | Loss of rationale and user trust | Verbatim-first index, summaries as projections, source backlinks |
| Replacing Beads too early | Feature regressions in issue graph/sync | Keep Beads import/export adapter until conformance passes |
| Flat knowledge corpus becomes noisy | Poor recall and bad agent context | Scope by issue/stage/artifact/release/worktree |
| Multi-agent local races | Claims overwrite or DB busy failures | WAL, transactions, expected_revision, idempotency, contention tests |
| Workflow templates become rigid | Forge competes with agents instead of supporting teams | Treat stages as editable templates over Kernel state |
| Hermes integration competes with Hermes memory | Confusing duplicate memory systems | Forge provides project control-plane state; Hermes keeps native memory/skills |

## Acceptance Criteria For This Planning PR

- A plan exists under `docs/work/2026-06-06-kernel-backlog-memory-roadmap/plan.md`.
- A tasks file exists for implementable slices.
- A decisions file records the storage and knowledge-layer decisions.
- Beads contains child backlog issues for the next slices.
- No runtime authority code is changed in this PR unless separately planned.
- `bun run check` passes after docs/issue updates or any failure is documented.

### Stage Exit Context

- **Summary:** This planning PR establishes the Kernel authority, Project Knowledge, workflow-friction, and release-lane roadmap without changing runtime authority code.
- **Decisions:** SQLite WAL is the local Kernel authority; team writes require serialized server authority; Beads/Dolt stay projection/history; Project Knowledge is verbatim-first and rebuildable; per-work planning uses `plan.md`.
- **Artifacts:** `plan.md`, `tasks.md`, `decisions.md`, `issue-map.md`, `*-beads-proposed.tsv`, evaluator reviews, storage spike notes, and workflow-friction amendments.
- **Next:** Synchronize proposed backlog items through the authoritative Beads/Kernel state surface, then implement the self-hosting stability lane before downstream Knowledge/team UX layers.

## Beads Mapping

Created roadmap/backlog issues:

- `forge-2agy.9` — Roadmap: Kernel backlog, storage, and project knowledge alignment
- `forge-2agy.9.1` — Define Kernel storage authority boundaries and guards
- `forge-2agy.9.2` — Define issue backlog taxonomy for stories, sprints, and tasks
- `forge-2agy.9.3` — Design Project Knowledge Layer verbatim index MVP
- `forge-2agy.9.4` — Specify forge orient and recap bounded context commands
- `forge-2agy.9.5` — Add local SQLite multi-agent concurrency tests
- `forge-2agy.9.6` — Guard Beads projection fidelity during Kernel migration
- `forge-2agy.9.7` — Plan Hermes harness as Forge project-state consumer
- `forge-2agy.9.8` — Gate multi-machine team writes on serialized authority

The deeper backlog now contains 53 proposed child issues: 34 first-pass decomposition issues plus 19 evaluator amendment issues. See `issue-map.md`, `deep-beads-proposed.tsv`, and `evaluator-beads-proposed.tsv` for the full hierarchy and proposed IDs. These are planning proposals until synchronized through an authoritative Beads/Kernel state export.

## Added Detail Files

- `pr-update.md` — PR intent and storage/backlog update summary.
- `issue-map.md` — full Beads backlog hierarchy and recommended implementation order.
- `storage-and-concurrency-risks.md` — SQLite/Dolt/server/read-model decision matrix and risk register.
- `backlog-frontend-model.md` — issue taxonomy, status lifecycle, board views, and agent-friendly JSON shape.
- `multi-evaluator-review.md` — consolidated findings from storage/concurrency, frontend/product, and knowledge/Hermes evaluator agents.
- `revised-safety-gates.md` — stricter go/no-go gates and implementation sequence after evaluator feedback.
- `validation-notes.md` — round-2 evaluator results and final controller validation output.
- `agent-memory-federation.md` — design for Forge as a shared project memory federation over old plans plus consented agent exports from Hermes/Codex/Claude/etc.
- `dolt-re-evaluation.md` — deeper Dolt capability review for projection/history, Beads fidelity, and branch/offline backlog experiments outside the Kernel authority path.
