# Plan Evaluation — User / Developer / Agent Perspectives

**Status:** Proposed review feedback (not accepted). Evaluates `plan.md`, `decisions.md` (D1–D15), `backlog-frontend-model.md`, `revised-safety-gates.md`, `tasks.md` as merged in the kernel-backlog-memory-roadmap PR.

---

## What is genuinely strong (keep these)

1. **Authority vs projection vs read model vs agent memory separation** (plan.md §Why This Plan Exists, D1/D2/D3). This is the correct architecture and the plan's core insight. Don't dilute it.
2. **Verbatim-first knowledge** (D3). Right call; summaries as reviewable projections with provenance is the correct trust model.
3. **Self-hosting stability before UX layers** (D11, D14, D15). Correct prioritization — Forge must be pleasant to use *on Forge* before adding boards and knowledge layers.
4. **"No safety claim without a named test"** (revised-safety-gates.md §Implementation rule). The single best line in the plan. Promote it to a repo-wide rule, not just this roadmap.
5. **Claim lease ≠ assignee** (D5, issue model). Right for multi-agent.

---

## The #1 risk: complexity is outpacing the product

The plan specifies an enterprise-grade distributed system — event sourcing, revision CAS, idempotency keys, projection outbox, dead-letter queues, conflict quarantine, response envelopes with facets and projection health, Durable Object team authority — for a product whose current real user base is one developer and their agents. 53 proposed child issues from one planning PR, across 30+ planning documents in a single work folder, is the signal: **planning artifact volume is growing faster than shipped behavior.**

This doesn't mean the architecture is wrong. It means each phase needs a ruthless "minimum slice" cut, and the plan currently doesn't distinguish *load-bearing now* from *correct eventually*.

---

## User perspective (the developer using Forge)

### U1 — No user-visible outcome per release lane
Every phase (A–G) is described in infrastructure terms. Nowhere does the plan say what a developer *experiences* differently at 0.0.20 vs 0.0.23. Add one sentence per lane, e.g.:
- 0.0.20: "Forge works without Dolt setup pain; `forge doctor` explains every failure."
- 0.0.21: "Two agents in two worktrees never step on each other."
- 0.0.23: "`forge orient` gives a new session a correct 30-second briefing."

If a lane can't be described this way, it's a refactor hiding as a release.

### U2 — Onboarding burden is the real product problem and the plan adds to it
Current install already requires Bun + Beads + Dolt + Lefthook + Git Bash (Windows) + gh + optional MCP servers. The plan adds architecture-impact manifests and declarations (D9/D10). The Dolt-retirement lane (D14) is the single highest user-value item in the whole plan — consider pulling it even earlier and giving it a **hard end-of-life version for Dolt in the default install**, not an open-ended "parity gates" condition. Open-ended parity gates historically never close.

### U3 — Mandatory architecture capture (D9/D10) will be the most-hated feature as specified
A *blocking* pre-commit/pre-push "architecture impact declaration" trains humans to type "no architecture impact" reflexively — worse than nothing, because it launders unexamined changes as examined. Recommend:
- Agents: auto-draft the architecture note (cheap for them), human reviews in PR.
- Humans: warn at commit, block only in CI and only for paths listed in the manifest.
- Measure boilerplate rate ("no impact" on changes touching manifest paths) as a health metric.

### U4 — Vocabulary leaks event-sourcing jargon into user space
"Kernel", "broker", "projection", "outbox", "quarantine", "read model" are fine internally but must not appear in CLI output, error messages, or setup docs. A user should read "Forge keeps your work state in a local database and syncs views to GitHub/Beads," never "projection quarantine". Add a naming rule: internal vocabulary stays in `lib/` and `docs/architecture/`; user docs and CLI strings use plain words.

---

## Developer perspective (contributing to Forge)

### Dev1 — Document authority inside the work folder is ambiguous
`revised-safety-gates.md` "supersedes the first-pass implementation order"; `multi-evaluator-review.md`, `validation-notes.md`, `workflow-friction-amendments.md` all amend the plan. A contributor cannot tell what's accepted vs proposed vs superseded without reading everything. Fixes:
- Every doc in `docs/work/**` gets a one-line status header: `Status: accepted | proposed | superseded-by <file>`.
- Fold supersessions back into `plan.md` once accepted; amendment files become history, not parallel truth.
- This is the same dual-authority bug the plan warns about for storage — applied to its own documents.

### Dev2 — The TSV proposal files are the wrong format
`*-beads-proposed.tsv` is fragile (tabs/newlines in titles, no nesting, unreviewable diffs) and duplicates Beads' native JSONL. Use JSONL matching the Beads import schema so proposals can be `bd import --dry-run`-validated, diffed, and synchronized mechanically. The plan itself flags "proposals until synchronized through authoritative state" — TSV makes that sync manual and lossy.

### Dev3 — 53 proposed issues that aren't in Beads is a dual-authority gap
Until the proposed issues are imported (or deleted), agents and humans have two backlogs: the authoritative `bd ready` queue and the proposal TSVs. The plan's own architecture says this is a hazard. Either sync them now (dry-run → import) or cut the proposal list down to the next two lanes and discard the rest — a 53-issue pre-planned hierarchy will be stale before phase C anyway.

### Dev4 — Three storage systems alive at once
Beads/Dolt (legacy + "fidelity oracle"), SQLite Kernel (new authority), Cloudflare DO (future). Every feature now pays a 3× design tax. Recommendations:
- **Dolt:** one-way migration target with a deadline (see U2). Drop "first-class projection/history substrate" status from `dolt-re-evaluation.md` — that's scope creep; an export adapter is enough. If branchable backlog history matters later, reopen via ADR as D7 already allows.
- **Cloudflare DO (Phase G):** keep as a one-page ADR stub only. Do not let server sequence numbers, D1 lag, or offline-refusal UX shape the local schema now. The local design needs exactly one team-readiness affordance: events are append-only with stable IDs. Everything else can be added when team mode is real.

---

## Agent perspective

### A1 — `forge orient`/`recap` MVP does not need a knowledge index
Phase E builds FTS5 chunk schema, redaction policy, rebuild fixtures, fact-proposal lifecycle — before the first version of `orient`. But the MVP of orientation is **deterministic file assembly**, not retrieval:
- `forge orient` (new command — does not exist today) = `docs/PROJECT_DESIGN.md` (D8 spine) + current work folder's `plan.md`/`tasks.md` + `bd ready` + claim state, concatenated under a token budget.
- `forge recap <issue>` (new issue-scoped mode) = that issue's work-folder artifacts + comments + last stage run.

Note: a `forge recap` command already exists (`lib/commands/recap.js` → `buildRecap()` in `lib/insights.js`, tested in `test/commands/insights.test.js`) — it is a **project-wide activity recap** over `.beads/issues.jsonl` + `.beads/interactions.jsonl` with `--limit/--min-count/--since/--json`, not an issue-scoped one. The proposal here is additive: keep the no-arg activity-recap contract, add the `<issue>` argument for work-item scope, and migrate the data source from Beads JSONL to the Kernel/D16 projection (the existing implementation is a D20 kill-list item). "Zero new infrastructure" refers to not needing the FTS5 knowledge index — not to zero code changes.

This needs zero new infrastructure and delivers 80% of the agent value. Ship it in the 0.0.21 lane; let FTS5/vector be the 0.0.23 upgrade *behind the same command interface*. This is the single biggest simplification available in the plan.

### A2 — Define token budgets as part of the contract
"Bounded" appears throughout but is never quantified. The orient/recap contract should specify budgets (e.g., orient ≤ 2K tokens default, `--budget` flag) and a deterministic truncation order (drop oldest evidence first, never drop decisions). Agents can't rely on "bounded" without numbers.

### A3 — Idempotency keys and `expected_revision` must be invisible at the CLI
Correct at the broker layer; hostile if agents must hand-generate them. The `forge` CLI should derive idempotency keys (command + payload hash + session) and auto-fetch/retry revisions with a `--expect-revision` escape hatch. The JSON contract for agents should be: data + revision + `next_commands[]`. Facets, stale indicators, and projection health (backlog-frontend-model §Response envelope) are v2.

### A4 — Issue taxonomy: 8 types is too many for agents (and humans)
`epic, feature, story, task, bug, chore, decision, spike` — feature vs story vs task is famously ambiguous for humans; for agents it's pure noise that causes misfiled issues, and Beads already rejected `story`/`spike`. Recommend **4 types**: `epic`, `task`, `bug`, `decision` — with `feature`/`story`/`chore`/`spike` as labels if needed. Every type that exists must change some behavior (routing, gates, board grouping); if it doesn't, it's a label.

### A5 — Status model double-books "blocked"
The lifecycle has `blocked` as a status that must remember the previous status — a known modeling wart — while readiness policy *also* computes blocked-ness from dependencies, claims, gates, and quarantine. Two sources of truth that will drift. Simplify: **blocked/ready are computed, not stored.** Stored status: `open → in_progress → review → done | cancelled` (backlog = open without ready conditions met). This removes the preserve-previous-status hack and four lifecycle transitions, and makes `bd ready` semantics the single readiness truth.

### A6 — Two priority systems
`P0-P4 plus numeric rank` — pick one as authoritative for ordering (rank), keep P-levels as a coarse display label if at all. Two ordering systems means board drag-drop and agent pick-next disagree.

---

## Naming / artifact-contract notes (the "text tags")

- **`plan.md` vs `plan.md` (D12):** the rename is fine, but the legacy support tail ("index legacy design.md", dual wording in skills/fixtures/drift tests) appears in 6+ places in the plan. Make migration one-shot: a script that renames work-folder `design.md → plan.md` in old folders (or adds a frontmatter alias), then *remove* all dual-handling language. Eternal dual support costs more than the migration.
- **Stage-exit context blocks** inside planning docs are agent ceremony embedded in human documents. If the Kernel will own stage runs (it should), stage-exit data belongs in Kernel events/`evidence` files, not appended to plan prose.
- **Scope fields list** (plan.md §3) is good but long (10 dimensions). Mark the indexed-from-day-one subset (project, issue, artifact type, source path) vs later (sprint, actor/session) so the first schema doesn't carry dead columns.

---

## Recommended top 6 actions (ordered)

1. **Sync or shrink the 53-issue proposal pile** (Dev3) — convert TSV→JSONL, import the next two lanes, discard the rest.
2. **Re-spec `orient`/`recap` MVP as file assembly** (A1) and move it into the early stability lane; defer all FTS5/vector/fact-lifecycle work behind the same command contract.
3. **Collapse the taxonomy**: 4 issue types, computed blocked/ready, single rank (A4/A5/A6) — do this *before* Kernel schema work in 0.0.20 freezes the wide version.
4. **Give Dolt a hard end-of-life version** in the default install; demote it from "first-class projection" to one-way migration export (U2/Dev4).
5. **Soften D9/D10**: agent auto-drafted architecture notes + CI-only blocking on manifest paths; never block humans at commit time (U3).
6. **Add a user-visible outcome sentence to every release lane** and a status header to every work-folder doc (U1/Dev1).

Deferred-not-rejected: Cloudflare team authority (ADR stub only), response-envelope facets/health, vector search, sprint/release as first-class entities (string fields are fine until a board exists).

---

## Deep-dive: Is replacing Beads/Dolt with our own SQLite WAL kernel safe?

**Verdict: the decision is architecturally sound for solo/local-first Forge. The risk is not the database choice — it is three operational gaps.** Evidence: the storage spike (`storage-decision.md`) measured SQLite ~17× faster than Dolt for Forge-shaped mutations with zero errors under 4-process contention, and Dolt's server lifecycle (PID kills, lock files in `lib/commands/worktree.js:37-60`) is today's worst self-hosting friction.

### Gap 1 — State portability is currently a git feature, and the kernel loses it by default
`.beads/issues.jsonl` is **git-tracked** today: the backlog clones with the repo, diffs in PRs, syncs desktop↔laptop via ordinary git, and survives disk loss. `kernel.sqlite` keyed by git common-dir is a local binary that does none of that (SQLite files cannot live sanely in git). The JSONL export must be reframed from "Beads compatibility adapter" to **the kernel's first-class explicit portability projection**: intentionally published for clone/bootstrap or review snapshots, imported on clone/bootstrap when present, and never required for routine close/verify durability. Acceptance test: clone the repo on a fresh machine with no Beads/Dolt installed plus an intentionally published Kernel projection → `forge status` shows the full backlog after import/bootstrap.

### Gap 2 — The riskiest layer is unbuilt: no real SQLite driver is wired
`lib/kernel/broker.js` is a contract with an injected `driver.exec(...)` — no `bun:sqlite`/`node:sqlite`/`better-sqlite3` import exists yet. Every safety property the plan claims (WAL, busy retry, atomic event+CAS+outbox transaction, contention behavior) is unproven against a real driver. Driver choice is also an install-footprint decision: avoid `better-sqlite3` (native compile = Windows node-gyp pain, which defeats the point of removing Dolt); prefer `node:sqlite` (builtin ≥ Node 22) and/or `bun:sqlite`, runtime-detected. Pick this now — it blocks all of Phase B.

### Gap 3 — The migration surface is 125 `bd` call sites, not a schema swap
`bd` is invoked across 40+ files: session hooks (`bd prime`), `lib/commands/sync.js` (dolt pull/push), `worktree.js` (dolt server lifecycle), `setup.js`, preflight, smart-status, dep-guard, forge-team scripts (claims/workload/GitHub sync), and `lib/project-memory.js` (**`bd memories`** — agent memory currently rides on Beads and has no declared landing spot in the kernel plan; decide explicitly or it silently dies). Authority migration is ~30% of the work; ecosystem touchpoints + agent instruction retraining (CLAUDE.md/AGENTS.md/skills all teach `bd`) is the rest. Maintain a tracked kill list; hot-path order: `sync.js` → `worktree.js` dolt handling → `setup.js` → status/preflight → forge-team scripts.

### Consciously accepted losses (fine for solo, say so out loud)
Dolt branch/merge/history of issue state; Beads upstream maintenance (you own the tracker forever); `bd` ready-work semantics (reimplement + parity fixtures, already planned); cross-machine merge (correctly gated behind future server authority).

### Not actually risks
Local performance/concurrency (spike proves it; WAL + single broker + leases is a standard pattern), losing Dolt conflict tables (kernel evaluators/quarantine is the right domain-level replacement), multi-machine writes (explicitly out of scope until team authority).

### One environment-specific hazard
This repo lives under `Downloads` on Windows — a folder commonly OneDrive-synced. SQLite WAL on cloud-sync folders corrupts. The planned filesystem doctor check is **a prerequisite for default-on**, not polish; this very machine is the test case.

---

## Full-folder re-evaluation: decision-by-decision confirmation

**Method:** All ~30 files in this work folder were read (plan, decisions, research, multi-evaluator-review, validation-notes, clarity-gap-review, discussion-addendum, decision-options, decision-registry-mechanism, dolt-re-evaluation, storage-and-concurrency-risks, agent-memory-federation, workflow-friction docs, issue-map, architecture-capture docs, and all 17 `beads/*.md` proposals). Findings below distinguish what the research already covers from what is genuinely open.

### Corrections to earlier critique — the research already covers these

| Earlier concern | Already addressed by |
|---|---|
| `bd memories` has no landing spot | `agent-memory-federation.md` — 4-class memory model; agent exports become provenance-backed proposals (`source_kind: agent_export, authority: proposal`); adapter boundary around `lib/project-memory.js` (multi-evaluator-review §2, clarity-gap-review §1) |
| Blocked/ready double bookkeeping | multi-evaluator-review §3 + clarity-gap-review §2 already conclude readiness is a **derived read model** — but `backlog-frontend-model.md` still stores `blocked` as a status with preserved-previous-status. **Internal contradiction: align the frontend model to the evaluator finding (derived wins).** |
| Dolt retirement has no crisp criterion | `dolt-hot-path-retirement.md` has a hard gate: normal Forge commands must NOT shell out to `bd`, read `.beads/issues.jsonl`, or require Dolt outside import/export adapters; release notes may not claim retirement until parity/rollback/projection gates pass |
| 53 issues lack dependency encoding | `issue-map.md` has a full dependency table, verified acyclic (workflow-friction-evaluator-review, 96/100) — though still only in markdown/TSV proposals, not authoritative Beads |
| D9/D10 blocks humans at commit | `architecture-capture-hooks.md` is layered: agent-native hooks primary, Forge policy engine shared, Lefthook fallback, CI gate — closer to the recommended shape than decisions.md wording implies. Remaining ask: human pre-commit should warn, not block |

### Confirmed open gaps (verified absent across all files)

1. **Git-tracked JSONL portability projection** — no file defines how kernel state travels with the repo after Beads exits (clone → full backlog, cross-machine solo sync, PR-reviewable backlog diffs, disaster recovery). All three independent reads confirm this is missing. **Highest-priority addition.**
2. **SQLite driver decision** — issue `.9.5.7` says "select and validate" but no candidate analysis exists; Windows native-compile footprint (better-sqlite3/node-gyp) is unexamined. Recommend: builtin `node:sqlite` / `bun:sqlite`, runtime-detected, no native compile.
3. **`bd` call-site kill list** — `.9.1.1` (audit storage surfaces) gestures at it; no inventory exists. Measured: ~125 call sites across 40+ files (hooks, sync.js, worktree.js, setup.js, preflight, smart-status, dep-guard, forge-team scripts, project-memory.js).
4. **Cloud-sync/OneDrive filesystem doctor** — multi-evaluator-review names "network/cloud-sync/WSL path hazards" abstractly; no concrete detection check exists anywhere.
5. **Taxonomy size** — `backlog-taxonomy.md` commits to 8 types with no evaluator pushback recorded. **User decision (this review): collapse to 4** — `epic, task, bug, decision`; `feature/story/chore/spike` become labels. Must land before 0.0.20 schema freeze.
6. **Beads→Kernel field migration spec** — storage-and-concurrency-risks notes field separation but no concrete mapping document.

### Decision register: confirm / amend

| Decision | Verdict | Notes |
|---|---|---|
| D1 SQLite WAL local authority | **Confirm** | Spike-evidenced (17×, 0 contention errors) |
| D2 Beads stays projection during rollout | **Confirm + amend** | Add end-state: Beads exits after parity; kernel JSONL projection (new D16) inherits the portability role |
| D3 Verbatim-first knowledge | **Confirm** | |
| D4 Scoped retrieval | **Confirm** | Mark day-one scope subset (project, issue, artifact type, source path) vs later |
| D5 Separate status/hierarchy/bucket/stage axes | **Confirm + amend** | Blocked/ready become derived, never stored (resolves internal contradiction) |
| D6 Hermes consumer, not memory replacement | **Confirm** | agent-memory-federation.md is the supporting design |
| D7 SQLite first; Dolt projection | **Confirm + amend** | Replace "first-class projection/history **indefinitely**" with "during migration; demote to optional export once D16 ships" — after kernel JSONL projection exists, Dolt's residual value (history/branch experiments) no longer justifies permanent test surface |
| D8 PROJECT_DESIGN registry spine | **Confirm** | |
| D9/D10 Architecture capture, hook-backed | **Confirm + amend** | Layered design stands; humans warn-at-commit, block-in-CI only; agents auto-draft notes |
| D11 No surprise dirty generated state | **Confirm** | Strongest user-value decision in the set |
| D12 Work-folder artifact contract | **Confirm + amend** | Make design.md→plan.md a one-shot scripted migration, then delete dual-handling language |
| D13 Premerge as task-type gate | **Confirm** | |
| D14 Dolt off hot path | **Confirm + amend** | Add D16 (portability projection) as an explicit prerequisite gate alongside parity fixtures |
| D15 Release lanes, self-hosting first | **Confirm** | Lane order validated: self-hosting → setup → kernel/TS → knowledge → team |

### Proposed new decisions (need user acceptance)

- **D16 — Kernel JSONL portability projection:** deterministic-order JSONL export/import artifacts for intentionally published clone/bootstrap and review snapshots, not routine mutation/push durability. Acceptance: fresh machine, `git clone`, no Beads/Dolt installed, plus an intentionally published Kernel projection → `forge status` shows full backlog after import/bootstrap. Prerequisite for D14's retirement claim.
- **D17 — SQLite driver:** builtin `node:sqlite` (Node ≥22) / `bun:sqlite`, runtime-detected; no native-compile dependency. Blocks Phase B.
- **D18 — Taxonomy collapse:** 4 issue types (`epic, task, bug, decision`) + labels; stored statuses `open/in_progress/review/done/cancelled` with ready/blocked derived; single numeric rank authoritative for ordering, P-levels as display labels. Before 0.0.20 schema freeze.
- **D19 — Filesystem doctor as default-on gate:** detect network shares, OneDrive/Dropbox/cloud-sync paths, and WSL-crossing paths; refuse or warn before placing `kernel.sqlite` there.
- **D20 — Tracked `bd` kill list:** the 125-call-site inventory becomes a checked-off migration artifact; hot-path order: `sync.js` → `worktree.js` dolt lifecycle → `setup.js` → preflight/smart-status → forge-team scripts → instruction files (CLAUDE.md/AGENTS.md/skills).
- **D21 (proposed, contradicts current research — user to decide):** `forge orient` (new) and issue-scoped `forge recap <issue>` (additive mode on the existing command) v1 as bounded deterministic file assembly (PROJECT_DESIGN.md + work folder + ready queue + claims, explicit token budget) behind the final command contract; FTS5 knowledge index becomes the v2 upgrade. The existing `forge recap` (project-wide activity recap via `buildRecap()` over Beads JSONL) keeps its no-arg contract and migrates its data source to the Kernel projection per D20. `knowledge-index.md`/`orient-recap.md` currently sequence index-first; they never evaluated the file-assembly option for these commands, so it is an unconsidered alternative, not a refuted one.
