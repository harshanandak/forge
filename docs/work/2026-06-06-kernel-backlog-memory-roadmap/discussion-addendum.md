# Discussion Addendum: Long-Term Forge Direction

## Why this addendum exists

The previous `decision-options.md` listed options. This addendum turns the discussion into stronger long-term directions based on the user's feedback:

- Do not choose temporary architecture just to unblock v1.
- Build foundations that remain valuable as Forge becomes team-scale.
- Keep Forge both agent-friendly and user-friendly.
- Do not hardcode Scrum if a better agentic work model exists.
- Treat CLI Option B as accepted.
- Re-evaluate Forge MCP, background observation, Context Mode, and Graphify with agent/team usage in mind.
- Compare the related `Product-Suite` workspace and Supabase migrations for lessons.

Related workspace inspected:

```text
C:\Users\harsha_befach\Downloads\Product-Suite
```

Important Product-Suite references included:

- `AGENTS.md`
- `apps/roadmap-web`
- `packages/ui-planning`
- `infra/supabase/migrations/**`
- work item / product task / timeline / workspace / team / phase schemas

---

## 1. Memory / Project Knowledge

### Preferred long-term decision

Forge should build a real **Project Knowledge subsystem**, not a temporary replacement for `bd remember`.

Recommended architecture:

```text
Kernel authority
  = accepted issue state, claims, workflow state, evidence metadata,
    accepted decisions, accepted facts, conflicts, projections

Project Knowledge
  = rebuildable read model over Kernel events + verbatim project artifacts
    + approved external/agent sources

Agent memory federation
  = source/proposal/evidence layer with consent, visibility, redaction,
    provenance, and conflict handling
```

### Physical storage choice

Use the **same local SQLite Kernel DB by default**, but behind a clean `KnowledgeStore` boundary so Knowledge can later move to `knowledge.sqlite` or a server/search backend.

This is not temporary. The durable decision is the **logical separation**:

```text
Kernel tables       = authority
Knowledge tables    = rebuildable read model / source index / proposals
Accepted facts      = Kernel events
Derived summaries   = not authority
```

### Why not start with a sidecar DB immediately?

A separate `knowledge.sqlite` is cleaner conceptually but adds immediate complexity:

- high-watermark checkpoints,
- staleness states,
- no single transaction with Kernel authority,
- more doctor/repair UX,
- more migration/backup handling.

Use sidecar later only when gates justify it:

- FTS/vector index slows Kernel writes,
- Knowledge DB grows large,
- rebuild/compact operations interfere with Kernel use,
- team/server mode needs separate search service,
- privacy/encryption boundaries require physical separation.

### Required authority event types

Forge needs selective Kernel authority events for accepted project truth:

```text
decision.accepted
decision.superseded
fact.accepted
fact.retracted
evidence.attached
knowledge.conflict.raised
knowledge.proposal.accepted
knowledge.proposal.rejected
```

Not every note or summary becomes authority. Only accepted decisions/facts/evidence/conflicts do.

### Recommended v1 tables

```text
knowledge_sources
knowledge_chunks
knowledge_chunks_fts
knowledge_source_links
knowledge_proposals
knowledge_summaries
knowledge_index_state
```

Every retrieved/derived item should label:

- authority vs verbatim vs derived/proposal,
- source path/event/line span,
- visibility,
- redaction status,
- staleness state.

### Anti-decisions

Do not:

- make Beads/Dolt the hidden future memory store,
- make the current flat typed memory API final,
- treat summaries/vectors/Graphify/Context Mode as truth,
- ingest private agent memory by default,
- migrate old Beads memory into accepted truth without review.

---

## 2. Backlog / Issues / Sprints / Methodology

### Preferred long-term decision

Forge should not hardcode Scrum as the primary ontology. It should implement:

> **Work Graph + Planning Collections/Buckets + Agent Execution Ledger**

Agile/Scrum/Kanban should be **presets/views**, not the foundation.

### Why

Agile still has value in agentic development when it means:

- ordered valuable work,
- small slices,
- iterative planning,
- inspection/adaptation,
- definition of done,
- visible dependencies/blockers,
- reviews and retrospectives.

But classic Scrum assumptions weaken with agents:

- agents work asynchronously,
- work can be parallel/bursty,
- claims/leases matter more than static assignees,
- sprint commitment is less reliable when agents discover unknowns,
- time-boxed ceremonies should not define storage.

Forge should support Scrum language for teams that want it, but the core should be method-neutral.

### Best model

```text
issues / work_items        canonical claimable work
issue_relations            work graph edges
planning_buckets           backlog, sprint, release, milestone, roadmap, queue
issue_bucket_memberships   membership, rank, history
claims                     human/agent leases
sessions / runs            agent execution ledger
stage_runs                 workflow execution state
events                     authority log
readiness                  derived ready-work model
board_positions            derived UI ordering model
```

### Multiple backlogs and teams

Backlog should be a view by default, but curated/team/product backlogs should be planning buckets:

```text
planning_buckets.kind = backlog | sprint | iteration | release | milestone | roadmap | queue | initiative
```

This gives:

- product backlog,
- team backlog,
- sprint backlog,
- release scope,
- roadmap milestone,
- agent-ready queue,
- cleanup queue,
- multi-team planning.

### Tasks

Rule:

> Anything claimable, schedulable, dependency-bearing, evidence-bearing, or reviewable is an issue.

Optional checklist rows can exist later only for non-claimable local execution details.

### Status separation

Keep these separate:

```text
issue.status      = backlog | ready | in_progress | blocked | review | done | cancelled
workflow.stage    = plan | dev | validate | ship | review | premerge | verify | custom
claim.state       = active | stale | reclaimable | released
bucket.state      = planned | active | closed | archived
run.status        = queued | running | passed | failed | cancelled
```

Do not collapse issue status and workflow stage.

### Product-Suite lessons

Reuse:

- workspace/team boundaries,
- membership/roles,
- audit/history,
- progressive forms,
- normalized planning-card JSON.

Avoid:

- parallel canonical work tables like `work_items`, `product_tasks`, and `timeline_items`,
- domain-specific phase hardcoding,
- status/phase drift,
- Supabase/RLS complexity in local MVP.

### Preferred phrase

Forge should be:

> **Flow-managed Agile for agentic delivery**: humans set goals and scope; Forge maintains the work graph, readiness, claims, workflow gates, evidence, and projections; agents pull ready work under leases; planning buckets provide cadence/reporting when teams want it.

---

## 3. Forge CLI

The user's instinct is right: **Option B is the best option.**

Accepted direction:

```text
Canonical Kernel-first CLI, incremental cutover.
```

Recommended command surface:

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
forge knowledge ...
forge graph ...
```

CLI should remain the universal local integration contract because it works in every agent environment, even where MCP support is absent or inconsistent.

---

## 4. Forge MCP and background observer

### Preferred model

Do not make CLI and MCP separate implementations. Build one service layer:

```text
Kernel service contracts
  -> CLI client
  -> MCP server
  -> background observer adapters
  -> future team/server APIs
```

### MCP priority

Forge MCP is important, but it should begin read-only.

P1 read-only MCP tools/resources:

```text
forge_status
forge_orient
forge_recap_issue
forge_issue_show
forge_issue_list
forge_backlog_query
forge_knowledge_search
forge_graph_stats
forge_graph_neighbors
```

Write MCP comes later and must require:

- Kernel broker path only,
- `expected_revision`,
- `idempotency_key`,
- actor/session/worktree metadata,
- conflict quarantine,
- human confirmation for sensitive actions.

### Background observer

The background observer idea is valuable, but it should not be an unconstrained autonomous writer.

Preferred path:

1. Add event-intake CLI/session model.
2. Observer records evidence/proposals/session summaries.
3. Guarded Kernel events accept decisions/facts/state changes.
4. Later expose the same writes through MCP.

Possible observer events:

```bash
forge session start
forge session heartbeat
forge session end
forge event append
forge evidence add
forge observe import <transcript/log>
```

Observer should initially record:

- session started/ended,
- files touched,
- commands/tests run,
- evidence/logs produced,
- proposed issue comments/recaps,
- proposed decisions/facts.

It should not silently:

- close issues,
- accept decisions,
- rewrite priorities,
- reassign claims,
- promote derived summaries to truth.

### Priority order

1. CLI JSON contracts.
2. `orient` / `recap` / issue card / backlog query contracts.
3. Read-only Forge MCP.
4. Event-intake CLI/session model.
5. Background observer adapters.
6. Write MCP.
7. Team/server sync.

---

## 5. Context Mode

### Preferred role

Context Mode should be a **retrieval/context provider**, not authority.

Use it when the agent would otherwise flood context with:

- large code searches,
- long validation logs,
- browser snapshots,
- web/doc research,
- Graphify reports,
- orient/recap evidence retrieval.

Do not use it for:

- issue state authority,
- claims,
- stage transitions,
- accepted decisions/facts,
- hidden writes.

### What Forge should add

A provider manifest for every Context Mode result:

```text
provider name/version
indexed source path/URI
indexed_at
source hash
query used
snippet ids returned
redaction status
staleness state
```

Agent instructions should say:

- when to prefer Context Mode,
- when to read raw files,
- how to cite provenance,
- how to fall back if unavailable.

### Practical value

Context Mode is high-value for token savings and focused retrieval, but only when agents are taught to use it through skills/prompts/commands. Otherwise it stays invisible.

---

## 6. Graphify

### Current observation

Graphify artifacts exist, but they are generated/manual and can become stale.

Known Forge graph outputs inspected by the evaluator:

```text
graphify-out/GRAPH_REPORT.md
  425 files
  ~623,134 words
  2004 nodes
  3259 edges
  69 communities
  generated 2026-04-30

docs/work/2026-04-28-skeleton-pivot/graphify-out/GRAPH_REPORT.md
  28 files
  ~50,133 words
  469 nodes
  1684 edges
  18 communities
  generated 2026-04-30
```

### Preferred role

Graphify should be a **derived architecture navigation/read model**, not truth.

Best uses:

- architecture navigation,
- onboarding map for agents,
- hotspot/god-node discovery,
- impact analysis,
- planning and research orientation,
- cross-community bridge concepts.

### Required Forge support

Graphify needs explicit commands and agent prompts; otherwise agents will not know it exists.

Recommended CLI:

```bash
forge graph stats
forge graph stale
forge graph search <term>
forge graph neighbors <node>
forge graph hotspots
forge graph communities
forge graph explain <node>
forge graph build
forge graph refresh
```

Recommended MCP:

```text
forge_graph_stats
forge_graph_neighbors
forge_graph_hotspots
forge_graph_stale
forge://graphify/root
```

### Staleness contract

Graphify output should store/check:

- source root,
- Graphify version,
- generated_at,
- included file list,
- source hashes/mtimes,
- graph schema version,
- `.graphifyignore` hash,
- dirty/stale count.

Only after this should Graphify summaries be ingested into Project Knowledge as derived artifacts.

---

## 7. Updated recommended implementation sequence

1. **Lock canonical service contracts** shared by CLI/MCP/observer.
2. **Implement KnowledgeStore boundary** with same-DB read model by default.
3. **Add selective Kernel authority events** for decisions/facts/evidence/conflicts.
4. **Implement Work Graph + Planning Buckets schema** for team-scale backlog/sprints/releases/queues.
5. **Clean CLI Option B surface** and make JSON outputs stable.
6. **Implement `orient`, `recap`, `knowledge search`, issue card, backlog query.**
7. **Add read-only Forge MCP** over those same contracts.
8. **Add `forge graph` docs/stale/query commands.**
9. **Add Context Mode provider manifest and agent instructions.**
10. **Add event-intake CLI and session observer model.**
11. **Add background observer adapters as evidence/proposal writers.**
12. **Add guarded MCP writes only after revision/idempotency/conflict paths are proven.**
13. **Split Knowledge to sidecar/search service only when gates fire.**

---

## 8. Decisions still requiring explicit user/team approval

1. Should Knowledge start in the same Kernel SQLite DB with a separable `KnowledgeStore` boundary? Recommended: **yes**.
2. Should curated multiple backlogs be `planning_buckets.kind = backlog` while default backlog remains a view? Recommended: **yes**.
3. Should Agile/Scrum/Kanban be presets/views instead of core ontology? Recommended: **yes**.
4. Should tasks be issues when claimable/schedulable? Recommended: **yes**.
5. Should CLI Option B be treated as locked? Recommended: **yes**, and user already agrees.
6. Should Forge MCP be P1 read-only before writes? Recommended: **yes**.
7. Should background observer start as evidence/proposal recorder, not autonomous authority? Recommended: **yes**.
8. Should Context Mode and Graphify require explicit skills/prompts/commands for agent awareness? Recommended: **yes**.
9. Should Graphify ingestion into Knowledge wait until staleness/source-hash checks exist? Recommended: **yes**.
