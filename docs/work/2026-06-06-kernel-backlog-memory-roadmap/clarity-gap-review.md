# Clarity Gap Review: Memory, Backlog, CLI, MCP, Context Mode, Graphify

## Decision summary

The storage direction is now clear: **SQLite WAL owns the Forge Kernel authority path**. Dolt/Beads are not part of the core implementation equation except compatibility/projection/history boundaries.

This review asked a second question: after that storage decision, what else must be clarified before implementation accelerates?

## Highest-priority clarity decisions

### 1. Memory / Project Knowledge

**Current clarity:** partial.

Clear decisions:

- Forge should not replace Hermes/Codex/Claude private memory.
- Forge owns shared project truth only through Kernel-authorized events.
- Project Knowledge must be verbatim-first: source artifacts/events first, summaries/facts as derived read models.
- Agent memory federation is evidence/proposal input, not authority.

Missing clarity:

- Current code still routes project memory through Beads commands (`bd remember`, `bd recall`, `bd memories`).
- Older docs mention `.forge/memory/entries.jsonl`; newer docs say Kernel/SQLite authority plus read models.
- Typed memory categories exist, but category semantics are too flat.

**Decision to make now:**

> Kernel events are the authority for project decisions, evidence, issue state, and accepted facts. Project Knowledge is a rebuildable SQLite read model over Kernel events plus verbatim artifacts. Existing Beads memory is transitional compatibility, not the future core memory store.

Implementation implication:

- Add a storage adapter boundary around `lib/project-memory.js`.
- Define which typed memory categories are authority, projection, private evidence, or derived read models.
- Implement `forge orient` / `forge recap <issue>` from Kernel + Knowledge, not from raw Beads memory.

### 2. Backlog / Issues / Sprints

**Current clarity:** partial.

Clear decisions:

- SQLite lets Forge model backlog, issues, tasks, sprints, releases, milestones, claims, dependencies, stage runs, evidence, events, outbox, and conflicts as first-class relational tables.
- Backlog, sprint board, roadmap, and ready-work should be views over the same Kernel issue graph.

Missing clarity:

- Is backlog an entity/table, or a view/query over issues?
- Are tasks just `issues.type = task`, or checklist rows under issues?
- Can one issue belong to multiple sprints, or only one active sprint with historical memberships?
- Should parent/child live in `issues.parent_id`, dependencies, or a generalized relation table?
- Current schema uses `status = open`; docs describe lifecycle statuses like `backlog`, `ready`, `in_progress`, `blocked`, `review`, `done`, `cancelled`.

**Decision to make now:**

> Backlog is initially a view, not a separate authority entity. Tasks are issue records with `type = task`. Sprints/releases/milestones are planning bucket entities. Issues attach to buckets through a membership join table so history and multiple planning contexts are possible.

Recommended SQLite model additions:

- `kernel_issue_relations`
- `kernel_planning_buckets`
- `kernel_issue_bucket_memberships`
- `kernel_board_positions` or board rank read model
- `kernel_readiness` read model
- provider extension tables/JSON for Beads/GitHub/Linear fidelity

### 3. Forge CLI

**Current clarity:** insufficient for the authority transition.

Findings:

- Current CLI has overlapping surfaces: `forge issue`, `forge issues`, top-level Beads aliases.
- Some commands still describe Beads as the primary surface.
- Kernel broker paths exist in code but are not clearly exposed as the default CLI path.
- `forge recap` currently conflicts with the future issue-scoped recap concept.

**Decision to make now:**

> Forge CLI should become the stable human/agent command surface over the SQLite Kernel. Beads commands remain compatibility/projection internals, not the default user mental model.

Implementation implication:

- Make `forge issue ...` or `forge issues ...` canonical; avoid both staying semantically different.
- Add Kernel-backed commands for create/update/comment/claim/close/list/ready.
- Add first-class planning commands: backlog, sprint, release, milestone, board reorder.
- Move existing insights recap if needed so `forge recap <issue>` can mean issue-scoped recovery context.

### 4. Forge MCP

**Current clarity:** not implemented yet.

Findings:

- Repo has external MCP config (`context7`, grep.app), but no first-party Forge MCP server.
- MCP docs describe future config plumbing, not a Kernel-backed API.

**Decision to make now:**

> Forge MCP should be a Kernel-backed project-state server. Start read-only; add writes only through Kernel broker with expected revision and idempotency.

MVP tools:

- `forge_status`
- `forge_orient`
- `forge_recap_issue`
- `forge_issue_show`
- `forge_issue_list`
- `forge_backlog_query`
- later writes: `forge_issue_update`, `forge_claim`, `forge_stage_transition`

### 5. Context Mode

**Current clarity:** useful but not integrated.

Decision:

> Context Mode should be a context/retrieval provider and session artifact source, not Forge authority.

Use it for:

- large-codebase exploration without flooding context
- planning and research stages
- orient/recap retrieval support
- indexing session summaries/evidence into Project Knowledge with provenance

Do not use it for:

- authoritative issue state
- claim ownership
- stage transitions
- decisions without Kernel acceptance

### 6. Graphify

**Current clarity:** artifacts exist, policy missing.

Findings:

- `graphify-out/graph.json` exists with about 2004 nodes / 3259 edges.
- Work-doc Graphify output also exists.
- There is no clear guide for regeneration, querying, staleness, or relationship to Project Knowledge.

Decision:

> Graphify is a derived architecture navigation/read-model tool. It is useful for exploration and hotspot discovery, but not authority.

Implementation implication:

- Add a `GRAPHIFY.md` guide.
- Add scripts/commands to regenerate/query Graphify output.
- Optionally ingest Graphify summaries into Project Knowledge as derived artifacts with source hashes.

## Recommended implementation order

1. Lock memory authority boundary: Kernel events + Knowledge read model; Beads memory transitional.
2. Lock backlog schema: planning buckets, memberships, relations, board positions, readiness model.
3. Clean CLI authority surface: Kernel commands default, Beads compatibility internalized.
4. Define `forge orient` and `forge recap <issue>` JSON contracts.
5. Build Forge MCP read-only MVP over the same contracts.
6. Add Context Mode provider integration for research/orient/recap, with provenance.
7. Document Graphify and optionally add derived Knowledge ingestion.

## Anti-decisions

- Do not make Dolt part of core Kernel implementation.
- Do not let Beads memory remain the hidden future memory architecture.
- Do not model sprints as a single `issue.sprint_id` if sprint history/multiple planning contexts matter.
- Do not expose MCP write tools that bypass Kernel expected revision/idempotency.
- Do not treat Graphify/Context Mode outputs as project truth.
