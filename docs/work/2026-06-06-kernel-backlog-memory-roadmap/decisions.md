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

**Decision:** Use SQLite WAL as the first Forge Kernel local authority. Do not use Dolt as a Kernel authority backend for the initial implementation. Keep Dolt as a first-class projection, Beads migration-fidelity oracle, and branchable backlog/history substrate outside the Kernel authority path.

**Rationale:** A storage spike showed SQLite was much faster and simpler for Forge-like issue/event/outbox mutations, while Dolt was excellent for history, branch/merge, and surfacing low-level data conflicts. Dolt's merge conflicts still require Forge domain rules for claims, leases, stages, idempotency, and quarantine.

**Implication:** Continue the SQLite broker path. Keep Beads/Dolt behind compatibility/projection/history boundaries only. Do not let Dolt shape the Kernel data model, transaction contract, write API, or local authority broker. Reopen Dolt authority strategy only after an explicit future accepted Project Design or ADR.

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

## D11 — Forge lifecycle commands must not create surprise dirty generated state

**Decision:** Treat repeated generated-doc/harness/runtime churn during push, review, verify, merge, and post-merge cleanup as a release-blocking self-hosting bug, not as normal agent cleanup.

**Rationale:** If Forge requires agents to repeatedly stash generated files to close the workflow, Forge cannot be a reliable workflow control plane. Generated outputs must be idempotent, content-addressed where possible, and routed through owning Forge/Beads surfaces when writes are intentional.

**Implication:** Add lifecycle idempotency tests and diagnostics. `forge status`, `forge validate`, `forge push`, `forge ship`, review helpers, and cleanup paths should distinguish durable planning artifacts from generated harness outputs and projection/runtime state.

**Impact score:** user_value=5, risk_reduction=5, implementation_confidence=4, reversibility=4, dependency_unlock=5, agent_friendliness=5, team_scale=4.

## D12 — Fresh Forge setup must teach the work-folder artifact contract

**Decision:** New projects should be guided to create per-work-item artifacts under `docs/work/<date>-<slug>/` using `plan.md`, `tasks.md`, `decisions.md`, and evidence/validation files. `design.md` remains for durable architecture/product design or backward-compatible reads, not the default work-item planning document.

**Rationale:** Project Knowledge and future `forge orient`/`forge recap` depend on predictable source artifacts. If fresh installs or skills teach inconsistent folders and filenames, later indexing and agent handoff will lose context.

**Implication:** Update setup templates, skills, command prompts, generated agent instructions, fixtures, and drift tests so new projects follow the same artifact contract by default.

**Impact score:** user_value=4, risk_reduction=4, implementation_confidence=5, reversibility=5, dependency_unlock=4, agent_friendliness=5, team_scale=4.

## D13 — Pre-merge is a task-type gate, not a universal top-level stage

**Decision:** Do not introduce `premerge` as a universal mandatory workflow stage. Model it as a gate/checkpoint embedded in existing stages and enabled according to task type, risk, and release policy.

**Rationale:** Forge's workflow model should stay adaptable. A universal extra stage creates stage drift and unnecessary ceremony for docs-only or low-risk work while still not being specific enough for high-risk changes.

**Implication:** Update workflow taxonomy, prompts, command contracts, and tests to distinguish stages from gates/checkpoints. Branch protection and CI remain merge requirements, but workflow state should not require a separate pre-merge stage everywhere.

**Impact score:** user_value=4, risk_reduction=4, implementation_confidence=4, reversibility=4, dependency_unlock=4, agent_friendliness=4, team_scale=5.

## D14 — Dolt must leave the Forge hot path before the next reliable self-hosting release

**Decision:** Prioritize a TypeScript API-friendly Kernel authority path for normal Forge operations and keep Dolt/Beads as projection/import-export compatibility during migration.

**Rationale:** Dolt continues to create practical setup, worktree, sync, push, and state-management friction. Forge needs a simpler local authority surface for agents and users before adding more workflow layers.

**Implication:** Inventory hot-path Dolt usage, define the local Kernel TS API, preserve Beads/Dolt projection fidelity, and add release gates that prevent claiming Dolt retirement until parity and rollback paths exist.

**Impact score:** user_value=5, risk_reduction=5, implementation_confidence=3, reversibility=3, dependency_unlock=5, agent_friendliness=5, team_scale=4.

## D15 — Release lanes must prioritize self-hosting stability before downstream UX layers

**Decision:** The next release plan should explicitly stage work into release lanes: self-hosting workflow stability, fresh-project setup correctness, Kernel/TS state foundation, Knowledge/architecture capture, and team authority.

**Rationale:** The roadmap has many valuable issues, but implementation needs dependency-aware version sequencing so agents do not start downstream features before state/setup/hooks foundations are reliable.

**Implication:** Add release-lane issue mapping and use evaluator review to check that release-blocking workflow friction is not deferred behind more visible but less foundational features.

**Impact score:** user_value=4, risk_reduction=5, implementation_confidence=4, reversibility=5, dependency_unlock=5, agent_friendliness=5, team_scale=5.

---

## 2026-06-11 review round — accepted amendments and new decisions

Source: `plan-evaluation.md` (full-folder re-evaluation, all decisions confirmed; amendments below accepted by user).

**Amendments to existing decisions:**

- **D2/D14 amendment:** Beads/Dolt retirement gains an explicit prerequisite — the Kernel JSONL portability projection (D16) must ship before retirement can be claimed, alongside the existing parity/rollback gates.
- **D5 amendment:** `ready`/`blocked` are derived read-model facts, never stored statuses. Resolves the contradiction between `multi-evaluator-review.md` (derived) and the first-pass `backlog-frontend-model.md` (stored).
- **D7 amendment:** Dolt's "first-class projection/history" status is scoped to **the migration period only**. Once D16 ships and Beads parity gates pass, Dolt demotes to an optional export adapter; its residual history/branch-experiment value does not justify a permanent test surface.
- **D9/D10 amendment:** architecture capture blocks in CI on manifest paths only; humans get warn-at-commit, never block-at-commit; agents auto-draft the architecture note.
- **D12 amendment:** `design.md` → `plan.md` is a one-shot scripted migration of legacy work folders, after which dual-handling language is deleted from skills/templates/fixtures.

## D16 — Kernel JSONL portability projection

**Decision:** The Kernel owns a git-tracked, deterministic-order JSONL export of issues, dependencies, and comments — auto-exported on mutation (or at push time), imported on clone/bootstrap.

**Rationale:** Today `.beads/issues.jsonl` in git is what makes the backlog clone with the repo, diff in PRs, sync across machines via ordinary git, and survive disk loss. `kernel.sqlite` is a local binary that does none of that. Without a kernel-owned replacement, retiring Beads silently deletes the portability/backup/sync story.

**Implication:** This is a prerequisite gate for D14 retirement claims. Acceptance: fresh machine, `git clone`, no Beads/Dolt installed → `forge status` shows the full backlog. The projection is the Kernel's own surface, not a "Beads compatibility" feature.

**Impact score:** user_value=5, risk_reduction=5, implementation_confidence=4, reversibility=4, dependency_unlock=5, agent_friendliness=4, team_scale=5.

## D17 — SQLite driver: builtin, no native compile

**Decision:** Use builtin `node:sqlite` and/or `bun:sqlite`, selected by runtime feature detection. No native-compile dependency (`better-sqlite3`/node-gyp) in the default install.

**Node version / stability caveat:** `node:sqlite` is **unflagged from Node.js ≥ 22.13.0** (before that it required `--experimental-sqlite`) but remains **Release Candidate / experimental** as of mid-2026, with an API that can still change. So the broker does not assume availability by major version: it probes at runtime (`try { require('node:sqlite') } catch`) and falls back to `bun:sqlite`, with a clear error if neither is present. The effective requirement for the node path is Node ≥ 22.13.0; `bun:sqlite` covers the Bun runtime.

**Rationale:** Removing Dolt to cut install friction and then adding a node-gyp build step would defeat the purpose, especially on Windows. The broker (`lib/kernel/broker.js`) currently has an injected-driver contract with no real driver wired; this choice blocks all Phase B safety work. Runtime feature detection (rather than a hardcoded version gate) absorbs both the bun/node split and `node:sqlite`'s experimental status.

**Implication:** Driver conformance tests (WAL, busy timeout, atomic event+CAS+outbox transaction, backup/checkpoint, FTS5) run against the chosen builtin drivers on Windows/macOS/Linux, and the detection path is itself tested (node:sqlite present, absent→bun fallback, neither→error).

**Impact score:** user_value=4, risk_reduction=4, implementation_confidence=4, reversibility=4, dependency_unlock=5, agent_friendliness=3, team_scale=3.

## D18 — Taxonomy collapse: 4 types, 5 statuses, single rank

**Decision:** Issue types are `epic`, `task`, `bug`, `decision`; `feature`/`story`/`chore`/`spike` become labels. Stored statuses are `open`, `in_progress`, `review`, `done`, `cancelled`; `ready`/`blocked` are derived. Single numeric rank is authoritative for ordering; P0–P4 is a display projection.

**Rationale:** Feature/story/task boundaries are ambiguous even for humans and cause agent misfiling; Beads already rejected `story`/`spike`. Stored blocked status double-books the readiness read model. Two priority systems make boards and agent pick-next disagree. A type must change Kernel behavior to earn existence.

**Implication:** Must land before the 0.0.20 Kernel schema freezes the wide version. `backlog-taxonomy.md`, `backlog-frontend-model.md`, `plan.md`, and `tasks.md` Task 2 amended accordingly.

**Impact score:** user_value=4, risk_reduction=4, implementation_confidence=5, reversibility=3, dependency_unlock=4, agent_friendliness=5, team_scale=4.

## D19 — Filesystem doctor is a default-on gate

**Decision:** Before placing `kernel.sqlite`, Forge detects network shares, cloud-sync folders (OneDrive/Dropbox/Google Drive), and WSL-crossing paths, and refuses or warns with a clear remediation message.

**Rationale:** SQLite WAL corrupts on cloud-sync/network filesystems. The primary development machine for this repo (Windows, repo under `Downloads`) is itself a plausible OneDrive-sync case — this is not a theoretical hazard.

**Implication:** Doctor check ships with the broker driver work, not after it. `forge doctor` reports filesystem class; kernel default-on is gated on the check existing.

**Impact score:** user_value=4, risk_reduction=5, implementation_confidence=4, reversibility=5, dependency_unlock=3, agent_friendliness=3, team_scale=3.

## D20 — Tracked `bd` call-site kill list

**Decision:** Maintain the inventory of `bd` call sites (~125 across 40+ files) as a checked-off migration artifact with a defined hot-path order: `lib/commands/sync.js` (dolt pull/push) → `lib/commands/worktree.js` (dolt server lifecycle) → `lib/commands/setup.js` → preflight/smart-status scripts → forge-team scripts → instruction surfaces (CLAUDE.md/AGENTS.md/skills/hooks).

**Rationale:** Authority migration is ~30% of the Beads exit; the ecosystem touchpoints and agent-instruction retraining are the rest. Without a tracked list, retirement claims cannot be verified.

**Implication:** `.9.1.1` (audit storage surfaces) produces this list as its artifact; D14 retirement gates reference it.

**Impact score:** user_value=3, risk_reduction=5, implementation_confidence=5, reversibility=5, dependency_unlock=5, agent_friendliness=4, team_scale=4.

## D21 — `forge orient`/`recap` v1 is bounded file assembly; FTS5 is v2

**Decision:** Ship `forge orient` and `forge recap <issue>` first as deterministic file assembly — `docs/PROJECT_DESIGN.md` + current work-folder `plan.md`/`tasks.md`/`decisions.md` + ready queue + claim state — under an explicit token budget with deterministic truncation order (decisions never truncate first). The FTS5 verbatim knowledge index upgrades the same command contract later.

**Rationale:** The MVP of orientation is reading the right files, not retrieval. This delivers most of the agent value in the self-hosting/Kernel lane with zero new infrastructure, and de-risks the knowledge layer by validating the output contract before building the index. (`knowledge-index.md` sequenced index-first but never evaluated this option.)

**Implication:** The orient/recap JSON contract (including `--budget` and `next_commands[]`) is designed once and kept stable across v1 (assembly) and v2 (indexed retrieval).

**Relationship to the existing `forge recap` command:** `forge recap` already exists (`lib/commands/recap.js` → `buildRecap()` in `lib/insights.js`) as a **project-wide activity recap** over `.beads/issues.jsonl` + `.beads/interactions.jsonl` with `--limit/--min-count/--since/--json`. D21 does not silently replace it: the no-argument form keeps its current activity-recap contract; the new **issue-scoped** form `forge recap <issue>` is additive. `forge orient` is a new command. Because the existing recap reads Beads JSONL directly, it is itself a D20 kill-list item — its data source moves to the Kernel/D16 projection during migration while preserving the output contract.

**Impact score:** user_value=5, risk_reduction=3, implementation_confidence=5, reversibility=5, dependency_unlock=4, agent_friendliness=5, team_scale=3.

## D22 — Forge agent interface parity layer (the "Beads plugin" equivalent)

**Decision:** Forge ships a first-class agent interface layer for its own Kernel, modeled on what the Beads plugin provides today: a session-priming hook, a kernel-facing skill/command set, JSON-first output contracts, and packaging that syncs across all supported harnesses.

**Rationale:** Beads is easy for agents because of its surface, not its database: `bd prime` context injection at session start, ~17 ready-made skills (`ready`, `show`, `search`, `stats`, `blocked`, `epic`, …), `bd remember` memory, JSON output, and CLAUDE.md workflow contracts. If the Kernel replaces Beads without matching this surface, agent usability regresses even though the storage improves. See `agent-interface-layer.md` for the full design.

**Implication:** Agent-interface parity is a named gate in the Beads retirement criteria (D14/D20): an agent in a fresh session must discover ready work, claim, comment, close, and recap entirely through `forge` commands with no `bd`. Lane: Kernel/TS state foundation.

**Impact score:** user_value=5, risk_reduction=4, implementation_confidence=4, reversibility=4, dependency_unlock=5, agent_friendliness=5, team_scale=4.
