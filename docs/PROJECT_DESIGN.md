# Forge Project Design and Decision Registry

**Status:** Canonical living registry for current Forge design direction  
**Last reviewed:** 2026-06-08  
**Update rule:** Current accepted design decisions live here. Rationale and evidence must link to ADRs and work artifacts.

## How to read this file

1. Start here for current Forge architecture and direction.
2. Follow ADR links for immutable cross-cutting architectural decisions once they exist.
3. Follow `docs/work/**` links for full discussion, spike evidence, evaluator notes, and local decisions.
4. Treat work-folder decisions as evidence unless promoted here or accepted through a Kernel decision event.
5. If this file conflicts with an unsuperseded ADR or accepted Kernel decision event, that is a decision-registry error and should block merge.

## Current design snapshot

Forge is moving toward a native Kernel/control-plane architecture:

- **Authority:** SQLite WAL is the local single-machine Kernel authority; team/multi-machine authority requires a serialized server authority later.
- **Beads/Dolt:** Beads and Dolt remain compatibility/projection/history/migration surfaces, not the core Kernel write path.
- **Project Knowledge:** Project Knowledge is verbatim-first and rebuildable. Summaries, extracted facts, Context Mode output, Graphify output, and agent memories are derived/proposal material unless accepted by Kernel event.
- **Knowledge storage:** Knowledge starts in the same local SQLite Kernel DB by default, but only behind a clean `KnowledgeStore` boundary so it can later move to `knowledge.sqlite`, server-side search, or another backend.
- **Work model:** Forge uses a Work Graph plus Planning Buckets and an Agent Execution Ledger. Agile/Scrum/Kanban are views/presets, not the database ontology.
- **CLI:** `forge` CLI becomes the canonical Kernel-first local command surface through incremental cutover.
- **MCP:** Forge MCP starts read-only over the same service contracts as CLI; write tools come later with revision/idempotency/conflict guards.
- **Observer:** Background observers record evidence/proposals/session events first; they do not silently mutate project truth.
- **Architecture notes:** Architecture-significant observations, domain rules, subsystem behaviors, constraints, and open questions must be captured as scoped architecture records. `PROJECT_DESIGN.md` remains the top-level map; detailed records live under `docs/architecture/**` and work/ADR evidence.
- **Hook policy:** Agent-native hooks are the preferred architecture-capture UX; Forge CLI checks own the policy; Lefthook is a Git adapter/fallback; CI is the non-bypassable gate. Agents must not use `--no-verify` or equivalent hook-disabling bypasses without explicit audited authorization.

## Decision registry

### PD-20260606-sqlite-local-authority

```yaml
id: PD-20260606-sqlite-local-authority
topic: authority.local.storage
status: accepted
decision_date: 2026-06-06
last_reviewed: 2026-06-08
adr: pending
evidence:
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/decisions.md#d1--sqlite-wal-is-local-authority-only
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/decisions.md#d7--sqlite-is-the-first-kernel-authority-dolt-remains-first-class-projectionhistory
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/storage-decision.md
supersedes: []
conflicts_with: []
```

**Current decision:** Use SQLite WAL as the first Forge Kernel local authority. Do not present SQLite/git files as safe multi-machine/team authority.

**Implications:**

- Local broker writes go through Kernel transaction/CAS/idempotency rules.
- Team writes require future serialized server authority.
- Dolt is not part of the initial Kernel transaction contract.

### PD-20260606-beads-dolt-projection

```yaml
id: PD-20260606-beads-dolt-projection
topic: projection.beads-dolt
status: accepted
decision_date: 2026-06-06
last_reviewed: 2026-06-08
adr: pending
evidence:
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/decisions.md#d2--beads-remains-migrationprojection-during-kernel-rollout
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/decisions.md#d7--sqlite-is-the-first-kernel-authority-dolt-remains-first-class-projectionhistory
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/discussion-addendum.md
supersedes: []
conflicts_with: []
```

**Current decision:** Keep Beads/Dolt as import/export/projection/history compatibility while Kernel matures. Do not let Beads/Dolt shape the core Kernel write path.

**Implications:**

- Beads memory/comments/issues can be imported as source material or projections.
- Beads content is not automatically accepted Forge truth.
- New authority work should route through Forge Kernel contracts.

### PD-20260606-verbatim-first-knowledge

```yaml
id: PD-20260606-verbatim-first-knowledge
topic: knowledge.truth-model
status: accepted
decision_date: 2026-06-06
last_reviewed: 2026-06-08
adr: pending
evidence:
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/decisions.md#d3--verbatim-first-project-knowledge-layer
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/agent-memory-federation.md
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/discussion-addendum.md
supersedes: []
conflicts_with: []
```

**Current decision:** Project Knowledge indexes verbatim artifacts/events first. Summaries, extracted facts, agent memories, Context Mode output, and Graphify output are derived/proposal material unless accepted by Kernel event.

**Implications:**

- Source links and provenance are mandatory for accepted/project-relevant knowledge.
- `forge orient`, `forge recap`, and `forge knowledge search` should return authority/source/proposal labels.
- Conflicting memory becomes a conflict/proposal, not silent truth.

### PD-20260608-knowledge-store-boundary

```yaml
id: PD-20260608-knowledge-store-boundary
topic: knowledge.storage.boundary
status: accepted
decision_date: 2026-06-08
last_reviewed: 2026-06-08
adr: pending
evidence:
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/discussion-addendum.md#1-memory--project-knowledge
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/decision-registry-mechanism.md
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/decision-options.md
supersedes: []
conflicts_with: []
```

**Current decision:** Start Knowledge in the same local SQLite Kernel DB by default, but behind a clean `KnowledgeStore` boundary so it can later move to `knowledge.sqlite`, a server/search backend, or another read-model store.

**Boundary rule:**

```text
Kernel tables      = authority
Knowledge tables   = rebuildable read model / source index / proposals
Accepted facts     = Kernel events
Derived summaries  = not authority
```

**Sidecar/server gates:** Move Knowledge out of the Kernel DB only when FTS/vector load, rebuild/compact behavior, team/server search, privacy, or operational isolation justifies the complexity.

### PD-20260606-work-graph-planning-buckets

```yaml
id: PD-20260606-work-graph-planning-buckets
topic: backlog.model
status: accepted
decision_date: 2026-06-06
last_reviewed: 2026-06-08
adr: pending
evidence:
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/backlog-frontend-model.md
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/discussion-addendum.md#2-backlog--issues--sprints--methodology
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/decision-options.md
supersedes: []
conflicts_with: []
```

**Current decision:** Forge should use Work Graph + Planning Buckets + Agent Execution Ledger. Agile/Scrum/Kanban are presets/views, not the primary ontology.

**Core model:**

```text
issues / work_items
issue_relations
planning_buckets
issue_bucket_memberships
claims
sessions / runs
stage_runs
events
readiness
board_positions
```

**Implications:**

- Multiple product/team backlogs are planning buckets or views.
- Sprints/releases/milestones/queues share the planning bucket mechanism.
- Claimable/schedulable work is an issue/work item.
- Status, workflow stage, claim state, bucket state, and run status stay separate.

### PD-20260606-cli-kernel-first

```yaml
id: PD-20260606-cli-kernel-first
topic: cli.contract
status: accepted
decision_date: 2026-06-06
last_reviewed: 2026-06-08
adr: pending
evidence:
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/discussion-addendum.md#3-forge-cli
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/decision-options.md#3-forge-cli
supersedes: []
conflicts_with: []
```

**Current decision:** Use canonical Kernel-first CLI with incremental cutover. CLI remains the universal local integration contract; MCP and observers use the same service contracts.

### PD-20260606-readonly-mcp-first

```yaml
id: PD-20260606-readonly-mcp-first
topic: mcp.contract
status: accepted
decision_date: 2026-06-06
last_reviewed: 2026-06-08
adr: pending
evidence:
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/discussion-addendum.md#4-forge-mcp-and-background-observer
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/decision-options.md#4-forge-mcp
supersedes: []
conflicts_with: []
```

**Current decision:** Build Forge MCP read-only first over Kernel-backed status/orient/recap/issue/backlog/knowledge/graph queries. Write MCP comes later and must require expected revision, idempotency key, actor/session/worktree metadata, and conflict handling.

### PD-20260606-observer-evidence-proposals

```yaml
id: PD-20260606-observer-evidence-proposals
topic: observer.authority
status: accepted
decision_date: 2026-06-06
last_reviewed: 2026-06-08
adr: pending
evidence:
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/discussion-addendum.md#4-forge-mcp-and-background-observer
supersedes: []
conflicts_with: []
```

**Current decision:** Background observer adapters should initially record evidence, proposals, session events, files touched, commands/tests run, and recap candidates. They must not silently close issues, accept decisions, reassign claims, or mutate project truth.

### PD-20260608-mandatory-architecture-note-capture

```yaml
id: PD-20260608-mandatory-architecture-note-capture
topic: architecture.capture.mandate
status: accepted
decision_date: 2026-06-08
last_reviewed: 2026-06-08
adr: pending
evidence:
  - docs/architecture/index.md
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/architecture-note-governance.md
supersedes: []
conflicts_with: []
```

**Current decision:** Architecture-significant information must be captured when changed or discovered, but it does not all live inline in this file. `docs/PROJECT_DESIGN.md` is the top-level current map, while detailed scoped records live under `docs/architecture/**`, ADRs, and work-folder evidence.

**Record types:**

```text
architecture_note      observed architectural fact, rule, constraint, or behavior
architecture_decision  accepted direction after tradeoffs
architecture_question  unresolved ambiguity or decision needed
architecture_conflict  contradictory records or code/docs disagreement
architecture_exception deliberate deviation with owner, reason, and review/expiry
```

**Mandatory rule:** If future users or agents would need the information to avoid breaking the system, capture it with source evidence.

**Scale rule:** Large projects should organize architecture records by project/domain/bounded-context/subsystem/component/API instead of growing this file into a 10,000-line monolith.

### PD-20260608-hook-backed-architecture-capture

```yaml
id: PD-20260608-hook-backed-architecture-capture
topic: architecture.capture.hooks
status: accepted
decision_date: 2026-06-08
last_reviewed: 2026-06-08
adr: pending
evidence:
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/architecture-capture-hooks.md
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/architecture-note-governance.md
supersedes: []
conflicts_with: []
```

**Current decision:** Use hooks as a layered enforcement surface for mandatory architecture capture, but do not make Lefthook the center. Agent-native hooks are the preferred interactive experience; Forge CLI checks own the policy; Lefthook is a repo-local Git adapter/fallback; CI required checks and later Kernel authority validation plus KnowledgeStore indexing/proposal validation are the durable enforcement boundaries.

**Boundary:** Hooks make missing architecture capture hard to miss, but they are not the source of truth. Lefthook depends on install/worktree state and can be bypassed; CI and future Kernel authority are the durable enforcement boundaries.

**Rule:** Architecture-sensitive changes require an explicit architecture-impact declaration. If architecture changed or was discovered, the work must add/update an architecture record, open a question/conflict, or update/supersede accepted design direction. Agents must not use `git commit --no-verify`, `git push --no-verify`, `HUSKY=0`, `LEFTHOOK=0`, `git -c core.hooksPath=...`, script-mediated hook bypasses, or hook removal to bypass Forge checks unless explicitly authorized through an audited Forge bypass event.

## Registry update rules

### When to update this file

Update this file when a decision:

- affects multiple components,
- changes authority/storage boundaries,
- changes public CLI/MCP/API behavior,
- changes backlog/workflow ontology,
- changes agent/session/observer behavior,
- supersedes a previous accepted project direction,
- future agents or team members will need before starting work.

### When to keep decision only in a work folder

Keep it local to `docs/work/<date>-<slug>/decisions.md` when it is:

- scoped to one implementation task,
- temporary spike/evaluator output,
- a low-risk local ambiguity resolution,
- evidence for a larger decision but not itself global direction.

### When to create an ADR

Create an ADR under `docs/adr/` when a decision is cross-cutting, hard to reverse, or expected to govern future code/reviews. ADRs should be immutable after acceptance; supersede with a new ADR instead of rewriting history.

## Conflict and supersession rules

- New material decision: create a new `PD-*` entry.
- Replacing old direction: mark old entry `superseded` and point to the new entry.
- Conflict discovered: create a conflict/proposal record in Kernel/KnowledgeStore later; until then, record the conflict in the relevant work folder and link it here if accepted.
- Two active accepted decisions with the same `topic` should fail future decision-registry validation.

## Future Forge commands

This registry should eventually be indexed by KnowledgeStore and surfaced by:

```bash
forge architecture check
forge architecture impact
forge design show
forge design decisions
forge design check
forge knowledge search <query>
forge orient --json
forge recap <issue> --json
```

Agents should be taught:

1. read `docs/PROJECT_DESIGN.md` first for current architecture;
2. follow ADR/work-folder links for rationale;
3. update or supersede decisions when changing architecture;
4. never treat derived summaries as accepted truth without a registry/Kernel decision event.
