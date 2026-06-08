# Kernel Backlog, Storage, and Project Knowledge Roadmap Decisions

## D1 — SQLite WAL is local authority only

**Decision:** Continue with SQLite WAL for solo local mode keyed by git common-dir. Do not present SQLite/git files as safe multi-machine/team authority.

**Rationale:** SQLite WAL is good for one machine with concurrent readers and serialized local writers. It does not provide Dolt-style distributed merge semantics or server-side serialization across machines.

**Implication:** Team mode requires a serialized server authority, currently planned as Cloudflare Durable Object per project.

## D2 — Beads remains migration/projection during Kernel rollout

**Decision:** Keep Beads as import/export/projection compatibility while Kernel matures.

**Rationale:** Beads/Dolt currently provides issue graph behavior and sync properties that Forge has not fully replaced. Removing it early would create avoidable regressions.

**Implication:** Kernel conformance must cover fidelity, dependency graph behavior, idempotency, conflict quarantine, and projection rollback before Beads can be downgraded further.

## D3 — Verbatim-first Project Knowledge Layer

**Decision:** The first Knowledge Layer indexes verbatim artifacts/events and treats summaries/extracted facts as derived read models or reviewable proposals.

**Rationale:** MemPalace's strongest memory lesson is that verbatim storage avoids losing rationale and context. Summaries are useful, but they should not replace source material.

**Implication:** `plan.md`, legacy `design.md`, `tasks.md`, `decisions.md`, `evidence.md`, comments, issue bodies, stage runs, and validation logs are source material.

## D4 — Scoped retrieval, not flat memory

**Decision:** Retrieval must be scoped by project, issue, release, sprint, stage, artifact type, actor/session, and source path/event id.

**Rationale:** MemPalace's wings/rooms/halls pattern shows that predictable metadata filters are a major practical advantage.

**Implication:** `forge orient` and `forge recap` should query bounded scopes before doing deep/global search.

## D5 — Backlog model separates status, hierarchy, planning bucket, and execution stage

**Decision:** Treat backlog/readiness, parent-child hierarchy, sprint/release planning, and workflow stage execution as separate fields/models.

**Rationale:** Combining them makes UI boards and agent execution ambiguous.

**Implication:** A task can be in a sprint, have a parent story, be ready, and currently be in the validate stage; these are not the same axis.

## D6 — Hermes integration is consumer/provider, not memory replacement

**Decision:** Hermes should consume Forge project orientation and write project evidence/decisions back through Forge commands. Forge should not replace Hermes native memory or skills.

**Rationale:** Forge's value is shared project/team control-plane state. Hermes already has personal memory, skills, and delegation.

**Implication:** Hermes harness work should depend on bounded `forge orient`/`recap` outputs and Kernel write APIs.

## D7 — SQLite is the first Kernel authority; Dolt remains first-class projection/history

**Decision:** Use SQLite WAL as the first Forge Kernel local authority. Do not use Dolt as the primary Kernel authority for the initial implementation. Keep Dolt as a first-class projection, Beads migration-fidelity oracle, branchable backlog/history substrate, and optional future backend.

**Rationale:** A storage spike showed SQLite was much faster and simpler for Forge-like issue/event/outbox mutations, while Dolt was excellent for history, branch/merge, and surfacing low-level data conflicts. Dolt's merge conflicts still require Forge domain rules for claims, leases, stages, idempotency, and quarantine.

**Implication:** Continue the SQLite broker path. Keep Beads/Dolt behind compatibility/projection boundaries only. Do not let Dolt shape the initial Kernel data model, transaction contract, write API, or local authority broker. Reopen Dolt-as-authority only after an explicit future decision and server/remotes proof.

## D8 — Project design registry is the current decision retrieval spine

**Decision:** Maintain `docs/PROJECT_DESIGN.md` as the canonical living registry for current Forge design direction and accepted project decisions, with links back to ADRs and `docs/work/**` evidence. Work-folder `decisions.md` files remain scoped evidence unless promoted into the registry or accepted through a future Kernel decision event.

**Rationale:** Future users and agents should not need to remember which PR, work folder, Beads issue, or chat session produced a decision. A stable registry gives every session a common starting point while preserving detailed rationale in local work artifacts.

**Implication:** Significant direction changes must update or supersede registry entries, not just edit local work notes. Future `forge orient`, `forge recap`, and KnowledgeStore indexing should treat the registry as the first human/agent retrieval spine for accepted design direction.

## D9 — Architecture notes are mandatory but scoped

**Decision:** Require architecture-significant observations, constraints, domain rules, subsystem behaviors, open questions, conflicts, and exceptions to be captured as architecture records. `docs/PROJECT_DESIGN.md` remains the top-level current map; detailed records should live under `docs/architecture/**`, ADRs, and work-folder evidence.

**Rationale:** Large products cannot scale by appending every detail into one design file. They need mandatory capture plus scoped organization by project/domain/bounded context/subsystem/component/API. Brownfield products also need value from partial discovery without pretending all existing architecture is already known.

**Implication:** Future PR/session gates should require an architecture-impact answer. If architecture changed or was discovered, the work must add/update an architecture record, open a question/conflict, or explicitly state no architecture impact. Future validators should check record IDs, topics, scopes, statuses, source links, supersession, and discoverability.

## D10 — Architecture capture should be hook-backed, not hook-only

**Decision:** Enforce mandatory architecture capture through layered hooks and checks: agent/session guidance, Lefthook pre-commit fast checks, pre-push validation, CI required checks, and later Kernel/KnowledgeStore authority validation.

**Rationale:** Hooks make missing architecture notes much harder to miss at the moment work happens, but local hooks can be bypassed and agent hook support differs by harness. CI/branch protection and future Kernel authority provide stronger enforcement while hooks provide fast feedback.

**Implication:** Add a configurable architecture-impact manifest, architecture-impact declarations, `scripts/architecture-impact-check.js`, Lefthook wiring, CI integration, and tests. Architecture-sensitive changes without an impact declaration should block. Brownfield unknowns should be allowed only if they create an architecture question/conflict/observed note.
