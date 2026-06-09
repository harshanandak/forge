# Unified Project Design and Decision Registry Mechanism

## Question

How do we remember decisions such as:

> Start Knowledge in the same SQLite DB, but behind a `KnowledgeStore` boundary so it can later move to `knowledge.sqlite` or a server/search backend.

without depending on one agent session, one work folder, or the user's memory of where the discussion happened?

## Recommendation

Create and maintain a canonical living project design registry:

```text
docs/PROJECT_DESIGN.md
```

This file should not replace work-folder `decisions.md` files or ADRs. It should be the current-state retrieval spine that points to them.

```text
docs/PROJECT_DESIGN.md
  = current accepted design direction and decision registry

docs/adr/NNNN-*.md
  = immutable cross-cutting architectural decision records

docs/work/YYYY-MM-DD-<slug>/{plan.md,tasks.md,decisions.md,evidence...}
  = local work evidence, detailed discussions, spikes, alternatives, evaluator notes

Kernel decision events
  = future authoritative accepted decisions/facts/conflicts in SQLite/server authority

KnowledgeStore
  = indexes all of the above for orient/recap/search/conflict detection
```

This gives Forge a human-readable and agent-retrievable decision map.

## External systems researched

These mechanisms already exist in pieces:

### ADRs / decision logs

- ADRs are a mature pattern for recording significant decisions, context, alternatives, status, and consequences.
- ADR collections are called decision logs.
- Common statuses include proposed, accepted, rejected, deprecated, and superseded.
- Accepted ADRs are usually immutable; changed direction creates a new superseding ADR.

References:

- ADR GitHub organization: https://adr.github.io/
- Martin Fowler on ADRs: https://martinfowler.com/bliki/ArchitectureDecisionRecord.html
- AWS ADR process: https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html
- MADR template: https://adr.github.io/madr/

### arc42

arc42 is an architecture documentation template. Section 9 covers architecture decisions and recommends ADRs for important decisions. It is useful for human architecture docs, but it is not agent-callable by itself.

References:

- arc42 decisions: https://docs.arc42.org/section-9/
- arc42 overview: https://arc42.org/overview

### Docs-as-code and developer portals

Backstage TechDocs, Backstage ADR plugins, Log4brains, GitBook, Confluence templates, and similar systems make docs/ADRs searchable and publishable.

References:

- Backstage TechDocs: https://backstage.io/docs/features/techdocs/
- Backstage ADR docs: https://backstage.io/docs/architecture-decisions/
- Log4brains: https://github.com/thomvaill/log4brains

### Guardrails and enforcement

Decision Guardian, architecture fitness functions, ArchUnit-style tests, and AI-agent governance tools such as Mneme move toward enforcing decisions during PRs or agent work.

Useful idea:

- decisions should surface when related code changes;
- architectural constraints can be checked automatically;
- agent instructions should be generated from accepted decisions, not treated as the source of truth.

## What Forge can do better

Most existing systems are either static docs, searchable sites, or PR-time checks. Forge can combine them into an agent-native decision system:

1. **Agent-callable decision graph**
   - Agents can ask: “What accepted decisions constrain this file, issue, API, or plan?”

2. **Source-provenanced decisions**
   - Every decision links to original work folder, ADR, evidence, session, issue, PR, or Kernel event.

3. **Conflict detection**
   - New decisions or code changes can be checked against active accepted decisions.

4. **Session/PR integration**
   - Planning, implementation, review, and merge can all consult the same registry.

5. **Supersession chain**
   - Users can see why a decision changed, what it replaced, and which rationale was accepted.

6. **Beads replacement path**
   - Beads comments/memory can be imported as source/proposal material while accepted project truth moves to Kernel/KnowledgeStore.

## File roles

### `docs/PROJECT_DESIGN.md`

Living current registry. It should be short enough to read at session start but structured enough for machine parsing.

Contains:

- current design snapshot,
- stable `PD-*` decision IDs,
- topic names,
- status,
- short current decision,
- implications,
- evidence links,
- supersession/conflict links.

### `docs/adr/*.md`

Immutable cross-cutting decision records. Use for decisions that are hard to reverse or govern future work.

### `docs/work/**/decisions.md`

Local decision trail for a work item. It can contain low-level decisions, options, evaluator findings, and detailed rationale. Important accepted decisions are promoted to `docs/PROJECT_DESIGN.md`.

### Kernel decision events

Future authoritative machine-readable acceptance layer.

Recommended event types:

```text
decision.accepted
decision.superseded
decision.retracted
fact.accepted
fact.retracted
evidence.attached
knowledge.proposal.accepted
knowledge.proposal.rejected
knowledge.conflict.raised
knowledge.conflict.resolved
```

### KnowledgeStore

Indexes project design, ADRs, work artifacts, Kernel events, Beads imports, Graphify summaries, Context Mode snippets, and agent exports as source-linked records.

## Registry entry shape

Example:

```yaml
id: PD-20260608-knowledge-store-boundary
topic: knowledge.storage.boundary
status: accepted
decision_date: 2026-06-08
last_reviewed: 2026-06-08
adr: pending
evidence:
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/discussion-addendum.md#1-memory--project-knowledge
  - docs/work/2026-06-06-kernel-backlog-memory-roadmap/decision-options.md
supersedes: []
conflicts_with: []
```

Then a human-readable statement:

```text
Knowledge starts in the same local SQLite Kernel DB by default, but behind a clean KnowledgeStore boundary so it can later move to knowledge.sqlite, server-side search, or another backend.
```

## Update workflow

### During planning

1. Search/read `docs/PROJECT_DESIGN.md` for current decisions.
2. If a proposed plan conflicts with an accepted decision, surface the conflict to the user.
3. If a new significant decision is needed, add it to the work folder first.

### During implementation

1. Keep local implementation decisions in `docs/work/<slug>/decisions.md`.
2. If an implementation decision changes project direction, update `docs/PROJECT_DESIGN.md` and add/supersede an ADR.

### During PR/review

Add a decision-impact checklist:

```markdown
## Decision impact

- [ ] No current design decision changed.
- [ ] Updated `docs/PROJECT_DESIGN.md`: <PD-ID>
- [ ] Added/superseded ADR: <ADR path>
- [ ] Linked work evidence: <docs/work/...>
```

### Later with Kernel/KnowledgeStore

`forge design check` should validate:

- unique decision IDs,
- one accepted decision per topic unless explicitly allowed,
- valid evidence paths,
- ADR backlinks,
- supersession integrity,
- no unsuperseded conflicts,
- `docs/INDEX.md` links the registry.

## Conflict detection model

A future conflict checker should compare proposed changes against active registry topics.

Examples:

- A PR tries to make Dolt the Kernel authority → conflicts with `PD-20260606-beads-dolt-projection`.
- A PR treats generated summaries as authority → conflicts with `PD-20260606-verbatim-first-knowledge`.
- A PR adds a separate canonical task table for claimable work → conflicts with `PD-20260606-work-graph-planning-buckets` unless it supersedes the decision.
- A PR writes Knowledge directly to a sidecar without the boundary/gates → conflicts with `PD-20260608-knowledge-store-boundary`.

## Beads replacement implication

This mechanism helps remove Beads safely because Forge will preserve Beads' flexibility as source/proposal material while moving authority internally:

1. Import Beads issues/comments/memories as source material.
2. Link imported content to issues/decisions/evidence through KnowledgeStore source links.
3. Accept only reviewed project truth through Kernel decision/fact/evidence events.
4. Replace `bd recall` style behavior with `forge orient`, `forge recap`, and `forge knowledge search`.
5. Keep Beads export as projection until parity tests pass.

## Recommended implementation backlog

1. Add and seed `docs/PROJECT_DESIGN.md`.
2. Link it from `docs/INDEX.md`.
3. Update `DECISION_DRIFT_GUARDS.md` to treat `docs/PROJECT_DESIGN.md` as the current canonical design registry.
4. Add initial ADRs for:
   - project design registry,
   - Kernel authority/storage boundaries,
   - KnowledgeStore boundary.
5. Add `scripts/check-decision-registry.js`.
6. Add KnowledgeStore tables for design registry/source links/proposals.
7. Add Kernel decision/fact/conflict event types.
8. Add orient/recap decision sections.
9. Add Beads memory/comment import as source/proposal material.
