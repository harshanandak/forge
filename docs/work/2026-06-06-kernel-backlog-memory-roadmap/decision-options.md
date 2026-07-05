# Decision Options: Memory, Backlog, CLI, MCP, Context Mode, Graphify

> Follow-up discussion: see `discussion-addendum.md` for the long-term preferred direction after comparing Product-Suite/Supabase patterns and re-evaluating memory, team-scale backlog, Forge MCP, Context Mode, and Graphify.

## Purpose

This document gives decision options, tradeoffs, and recommendation criteria for the remaining Forge architecture choices after the storage decision.

Locked premise:

> SQLite WAL owns the Forge Kernel authority path. Dolt/Beads are outside the core implementation equation except compatibility/projection/history boundaries.

Research inputs:

- Current Forge code/docs and Kernel schema.
- Prior clarity review in `clarity-gap-review.md`.
- MCP specification: tools/resources/prompts over JSON-RPC, tool schemas, human-in-loop guidance for sensitive operations.
- SQLite FTS5: local full-text search via virtual tables, ranking, snippets/highlights, rebuildable index behavior.
- Agile/Scrum backlog practice: product backlog is long-term ordered work; sprint backlog is selected committed work for a time-box and should preserve planning/reporting history.

---

## 1. Memory / Project Knowledge

### Option A — Kernel events + SQLite Knowledge read model

Project truth is Kernel events. Project Knowledge is a rebuildable SQLite read model over Kernel events plus verbatim artifacts.

Sources:

- Kernel issue/decision/evidence/stage events.
- `docs/work/**/plan.md`, `tasks.md`, `decisions.md`, legacy `plan.md`.
- Issue bodies/comments, validation logs, evidence, PR reviews.
- Derived summaries/facts only with citations.

**Upsides**

- Aligns with SQLite-first authority.
- Verbatim-first and provenance-friendly.
- Enables `forge orient`, `forge recap <issue>`, `forge knowledge search`.
- SQLite FTS5 gives local search without extra infra.
- Rebuildable read model avoids corrupting authority.

**Issues**

- Requires clear source vs derived vs authority classification.
- Needs migration path from Beads memory and older `.forge/memory` docs.
- Can sprawl if indexing scope is too broad.

**Complexity:** Medium.

**Best when:** We want a practical MVP for project memory, orient, recap, and search.

### Option B — Separate `knowledge.sqlite` sidecar

Kernel SQLite stays focused on issue/workflow authority. A second SQLite DB indexes project knowledge.

**Upsides**

- Clean separation of authority and retrieval.
- Knowledge schema can evolve/rebuild independently.
- Better if retrieval becomes large or vector search is added later.

**Issues**

- Two DBs means staleness/checkpoint management.
- More moving parts.
- No single transaction across Kernel and Knowledge.

**Complexity:** Medium-high.

**Best when:** Knowledge becomes a large product surface and must evolve independently.

### Option C — Accepted facts/decisions as first-class Kernel events

Add explicit event types such as:

- `decision.accepted`
- `decision.superseded`
- `fact.accepted`
- `fact.retracted`
- `evidence.attached`
- `knowledge.conflict.raised`

**Upsides**

- Strongest auditability.
- Clear distinction between proposal and project truth.
- Good for architecture decisions and requirements.

**Issues**

- More schemas, UI/CLI flows, and tests.
- Too heavy for every note or summary.

**Complexity:** High.

**Best when:** Governance and “why did we decide this?” are critical.

### Option D — Agent memory federation as evidence/proposal layer

Forge ingests Hermes/Codex/Claude/Cursor exports or read-only connector outputs as provenance-backed evidence, not truth.

**Upsides**

- Enables cross-agent continuity.
- Preserves private memory boundaries.
- Useful for orient/recap.

**Issues**

- Requires allowlists, redaction, visibility, conflict handling.
- Cannot be the authority layer.

**Complexity:** Medium-high.

**Best when:** Cross-agent continuity is the main pain.

### Option E — Minimal SQLite adapter for current typed memory API

Keep the current typed API shape and replace Beads-backed storage with SQLite.

**Upsides**

- Fastest path away from `bd remember/recall/memories`.
- Low disruption to existing tests/callers.

**Issues**

- Preserves flat category model.
- Does not solve full Project Knowledge by itself.
- Could become accidental final architecture.

**Complexity:** Low-medium.

**Best when:** We need an implementation stepping stone.

### Memory recommendation

Use a staged combination:

1. **Target architecture:** Option A.
2. **First implementation slice:** Option E, but clearly transitional.
3. **Authority events:** Option C for accepted decisions/facts/evidence only.
4. **Later federation:** Option D after base Knowledge works.
5. Consider Option B only if Knowledge becomes too large for the Kernel DB.

---

## 2. Backlog / Issues / Sprints

### Option A — Backlog as a view over issues

Backlog is not a table. It is a query/read model over issues, relations, memberships, readiness, and rank.

**Upsides**

- Avoids duplicated state.
- Matches product/sprint backlog practice.
- Keeps Kernel authority clean.
- Backlog, sprint board, roadmap, and ready queue can be different views over one issue graph.

**Issues**

- Needs rank/readiness read models for stable UI.
- If Forge later supports multiple product/team backlogs, more modeling may be needed.

**Complexity:** Medium.

**Best when:** MVP needs clean issue authority without over-modeling.

### Option B — Backlog as a first-class planning bucket

Backlog is a `planning_bucket` row with issue memberships.

**Upsides**

- Supports multiple backlogs/team scopes.
- Can attach owner, goal, capacity, visibility.
- Same mechanism as sprints/releases/milestones.

**Issues**

- Over-models current need.
- Product backlog membership can become confusing because almost all active issues belong there.

**Complexity:** Medium-high.

**Best when:** Multi-product/team backlog support is a near-term requirement.

### Option C — Dedicated backlog item table

A `kernel_backlog_items` table tracks backlog membership/order.

**Upsides**

- Simple for one backlog UI.

**Issues**

- Duplicates issue state and creates drift risk.
- Poor fit for Kernel event authority.

**Complexity:** Low initially, high later.

**Recommendation:** Do not choose.

### Task modeling options

#### Option T1 — Tasks are issues

Every claimable/schedulable/dependency-bearing work item is `kernel_issues.type = task`.

**Upsides:** uniform claims, dependencies, comments, evidence, stages, revision control.  
**Issues:** many small issues; needs UI filtering.

#### Option T2 — Tasks are checklist rows

Tasks live inside a larger issue.

**Upsides:** less issue clutter.  
**Issues:** if checklist items need claims/dependencies/evidence, they become issue-like anyway.

#### Option T3 — Hybrid

Claimable/schedulable work is an issue. Optional checklist rows are local execution details only.

**Recommendation:** T3, but implement issues-as-tasks first and defer checklist rows.

### Sprint/release/milestone options

#### Option S1 — `issues.sprint_id`

Simple direct field.

**Upsides:** easy query.  
**Issues:** loses history, carry-over, multiple planning contexts; not future-safe.

#### Option S2 — Planning buckets + memberships

Tables:

- `kernel_planning_buckets`
- `kernel_issue_bucket_memberships`

Buckets cover sprint, release, milestone, maybe later backlog.

**Upsides**

- Preserves history.
- Supports carry-over, future planning, closed sprint reports.
- Generalizes sprint/release/milestone.

**Issues**

- More complex queries.
- Needs invariants for active sprint membership.

**Recommendation:** S2 as authority. Expose `current_sprint_id` only as a derived response field.

### Relation modeling options

#### Option R1 — `issues.parent_id` + dependencies table

**Upsides:** simple hierarchy.  
**Issues:** not flexible enough for richer relations.

#### Option R2 — generalized `kernel_issue_relations`

Examples:

```text
task-1 child_of story-1
story-1 depends_on decision-1
bug-2 duplicates bug-1
```

**Upsides:** extensible graph, good for agents and read models.  
**Issues:** needs constraints and cycle checks.

#### Option R3 — relations as authority, parent/depends fields as read model

**Recommendation:** R3.

### Backlog recommendation

Use this combined model:

- Backlog = view/read model.
- Tasks = issues when claimable/schedulable.
- Sprints/releases/milestones = planning buckets.
- Issue-to-bucket = membership join table with history.
- Relations = generalized `kernel_issue_relations`.
- `parent_id`, `depends_on[]`, `blocks[]`, `current_sprint_id` = derived response fields.
- Add `kernel_board_positions` and `kernel_readiness` as read models.

---

## 3. Forge CLI

### Option A — Big-bang Kernel CLI cutover

All issue/backlog/status/stage commands route to SQLite Kernel now.

**Upsides**

- Cleanest mental model.
- Stops Beads-shaped drift immediately.

**Issues**

- High migration risk.
- Current status/sync/context scripts still rely on Beads.
- Requires Kernel parity first.

**Complexity:** High.

### Option B — Canonical Kernel-first CLI, incremental cutover

Pick one canonical issue surface and migrate command-by-command.

Candidate surface:

```bash
forge issue create
forge issue show
forge issue list
forge issue ready
forge issue update
forge issue claim
forge issue comment
forge issue close
forge backlog ...
forge sprint ...
forge release ...
forge milestone ...
forge board ...
forge orient
forge recap <issue>
```

Beads remains compatibility/projection behind adapters.

**Upsides**

- Best migration path.
- Avoids breaking existing workflows.
- Lets each command switch only when Kernel semantics are tested.

**Issues**

- Temporary duality must be messaged clearly.
- Need deprecation plan for duplicate `issue`/`issues`/top-level aliases.

**Complexity:** Medium.

### Option C — Keep Beads default; Kernel hidden

**Upsides:** least disruption.  
**Issues:** contradicts SQLite-first implementation rule and keeps mental model unclear.

**Recommendation:** Option B.

---

## 4. Forge MCP

### Option A — Read-only Kernel-backed MCP MVP

Expose Forge state to agents via MCP tools/resources/prompts.

Tools:

- `forge_status`
- `forge_orient`
- `forge_recap_issue`
- `forge_issue_show`
- `forge_issue_list`
- `forge_backlog_query`

Resources:

- `forge://status`
- `forge://issues/<id>`
- `forge://backlog`
- `forge://knowledge/<id>`
- `forge://graphify/root`

Prompts:

- `forge_orient_prompt`
- `forge_recap_prompt`
- `forge_plan_prompt`
- `forge_handoff_prompt`

**Upsides**

- Safe first step.
- Aligns with MCP model: resources for context, tools for operations, prompts for workflows.
- Lets agents consume Forge state without shell parsing.

**Issues**

- Requires stable JSON contracts.
- Needs provenance/staleness labeling.

**Complexity:** Medium.

### Option B — Read/write MCP over Kernel

Add write tools:

- `forge_issue_update`
- `forge_claim`
- `forge_stage_transition`
- `forge_comment_add`
- `forge_close`
- `forge_board_reorder`

All writes require:

- Kernel broker only.
- `expected_revision`.
- `idempotency_key`.
- actor/session/worktree metadata.
- human-in-loop confirmation for sensitive operations.

**Upsides:** rich automation.  
**Issues:** high safety burden.

**Complexity:** High.

### Option C — No Forge MCP yet

Keep external MCPs only.

**Upsides:** no new server.  
**Issues:** misses cross-agent control-plane value.

**Recommendation:** Option A first, Option B later.

---

## 5. Context Mode

### Option A — Retrieval/context provider

Use Context Mode for:

- large-codebase exploration
- research/planning
- orient/recap retrieval support
- evidence/session artifact discovery

Do not use it for authority writes.

**Upsides**

- Reduces context pressure.
- Fits current context-mode value.
- Safe if outputs are labeled evidence/proposal.

**Issues**

- Needs provider manifest, provenance, and redaction policy.

**Complexity:** Medium.

### Option B — Optional execution sandbox for substages

Use it for isolated impact analysis, code search, recap assembly.

**Upsides:** powerful for heavy analysis.  
**Issues:** cannot be universal enforcement; support differs by harness.

**Complexity:** Medium-high.

### Option C — Stage authority

Context Mode owns/enforces stages.

**Recommendation:** Do not choose. Authority must stay Kernel.

**Recommendation:** Option A, with Option B later for selected substages.

---

## 6. Graphify

### Option A — Document/manual derived artifact

Add a guide for how to regenerate, inspect, and interpret Graphify outputs.

**Upsides:** low-risk clarity.  
**Issues:** still manual.

**Complexity:** Low.

### Option B — Derived query/read surface

Add commands/MCP resources:

```bash
forge graph stats
forge graph search <term>
forge graph neighbors <node>
forge graph hotspots
forge graph stale
```

**Upsides**

- Makes existing graph artifacts useful to agents.
- Helps architecture navigation and orient/recap.
- Keeps output derived/non-authoritative.

**Issues**

- Needs graph schema wrapper and stale detection.

**Complexity:** Medium.

### Option C — Ingest Graphify summaries into Project Knowledge

Store Graphify-derived summaries/hotspots as derived artifacts with source hashes.

**Upsides:** useful retrieval value.  
**Issues:** stale-derived data risk; requires Knowledge schema.

**Complexity:** Medium-high.

### Option D — Treat Graphify as truth

**Recommendation:** Do not choose.

**Recommendation:** Option A first, Option B next, Option C only after Knowledge model exists.

---

## Overall recommended path

1. Memory: Option A target, Option E first slice, Option C selectively, Option D later.
2. Backlog: view + tasks-as-issues + planning buckets/memberships + generalized relations.
3. CLI: incremental canonical Kernel-first CLI.
4. MCP: read-only Kernel MCP first; write tools later with strict guards.
5. Context Mode: retrieval provider first; optional sandbox later; never authority.
6. Graphify: document first; expose derived query surface next; optional Knowledge ingestion later.

## Decision gates before implementation

Before locking implementation, answer these:

1. Is Knowledge in the same Kernel DB or separate `knowledge.sqlite` sidecar?
2. Which memory categories become Kernel authority events?
3. Are checklist rows needed now, or are tasks-as-issues enough for v1?
4. Is one active sprint membership per issue per planning context enforced?
5. Which CLI namespace is canonical: `forge issue` or `forge issues`?
6. What are the JSON contracts for `orient`, `recap`, issue cards, and backlog queries?
7. Which MCP tools are read-only MVP, and which writes require human confirmation?
8. What exact Context Mode provider contract and redaction policy will Forge support?
9. How is Graphify regenerated, checked for staleness, and exposed as non-authoritative derived data?
