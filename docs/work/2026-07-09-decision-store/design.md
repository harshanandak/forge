# Decision Store — Consolidated Design

**Date**: 2026-07-09
**Status**: design (decided; this document writes up decisions, it does not reopen them)
**Kernel epic (decision store)**: `53cd20d7` (+ `7bb4196b`, `c3507eb7`); knowledge-arch epic `b6bdf122`
**Kernel epic (team server + sync)**: `926d772a`
**Evidence base**: `docs/work/2026-07-04-info-architecture-eval/evaluation.md`

## Purpose

Forge already has three tiers of decision capture on disk — per-work
`decisions.md`, the `PROJECT_DESIGN.md` PD-registry, and the `docs/adr/` and
`docs/architecture/subsystems/` scaffolding — but the component layer has **0
content files, 0 ADRs, and no promotion mechanism** bridging the ~60 granular
`decisions.md` files into it (evaluation §b, "Architecture decision capture",
18%). `PROJECT_DESIGN.md` is a flat manual registry that has grown to 685 lines
for ~24 entries, contradicting its own line 27: "`PROJECT_DESIGN.md` remains the
top-level map; detailed records live under `docs/architecture/**`."

This document specifies the consolidated decision store (Section A), the shared
token-efficient retrieval pattern it uses (Section B), the Phase-2 team server /
multi-surface sync it is forward-compatible with (Section C), the one BETA
carryover that de-risks Phase-2 now (Section D), the verify-before-lock checklist
for ADR-0002 (Section E), and the kernel issue tracking map (Section F).

Companion ADRs: [`0002-team-server-backend.md`](../../adr/0002-team-server-backend.md),
[`0003-github-identity-for-teams.md`](../../adr/0003-github-identity-for-teams.md),
[`0004-external-issue-sync.md`](../../adr/0004-external-issue-sync.md).

---

## A. Consolidated decision store (BETA target)

### A.1 Single-render model — one home per decision

Each promoted decision's full **body** lives in exactly **one** file:
`docs/architecture/subsystems/<component>.md`. Nothing else holds a second copy
of the prose.

- **`PROJECT_DESIGN.md` becomes a THIN top-level MAP.** It carries a hand-kept
  "current design snapshot" prose region plus two **generated** blocks:
  1. a **component-directory table** —
     `| Component | 1-line direction | #active | #superseded | #open-Qs | doc |`
  2. a **generated ADR log** (number, title, status, date, link).
  It holds **no decision bodies**. This fixes the 685-lines-for-~24-entries
  growth and honors line 27 above.
- **`docs/architecture/subsystems/<component>.md`** holds the decision bodies,
  rendered from the kernel using the existing template in
  `subsystems/README.md` (Current summary / Active records / Data model /
  Operational behavior / Open questions and conflicts / Source evidence).
- **`docs/adr/NNNN-*.md`** is **hand-authored, immutable**, and covers **only
  the irreversible subset** — the four triggers already stated in
  `adr/README.md` (cross-cutting interaction, one-way door, locks Forge into a
  tool/format/schema/pattern, "why did we do this?"). ADRs are not generated.
- **Local tier** = per-work `docs/work/<DATE>-<slug>/decisions.md`, unchanged as
  the authoring surface, plus a **promotion-tag footer** on each entry:
  `[local-only]` or `[promoted -> PD-YYYYMMDD-slug]`. The footer is the visible
  bridge between a work-folder decision and its promoted PD record.

### A.2 Kernel is the spine + the only query surface

A `decision` record (the taxonomy already reserves the `decision` issue type —
`PROJECT_DESIGN.md` line 30) carries:

| Field | Meaning |
|---|---|
| `public_id` | Stable `PD-YYYYMMDD-slug` — the key everything references (map, subsystem anchor, ADR back-link, evidence). Never changes. |
| `topic_key` | Coarse subject key (e.g. `authority.local.storage`) used for exact-match conflict detection. |
| `component` | Which `subsystems/<component>.md` the body renders into. |
| `status` | `local` \| `promoted` \| `superseded`. |
| `supersedes[]` / `superseded_by` | Supersession chain by `public_id`. |
| `conflicts_with[]` | Unresolved live conflicts by `public_id`. |
| `adr` | ADR number if frozen (`pending` / `0002` / …). |
| `evidence[]` | Back-links into `docs/work/<DATE>-<slug>/…`. |
| `body_prose` | The rendered decision body (current decision + implications). |

An **FTS5** index over `topic_key + body_prose` gives token-efficient keyword
retrieval (BM25 top-N). **Markdown is a regenerated read projection, never the
query surface** — agents never grep the tree. Everything keys off the stable
`public_id`, so re-rendering, moving a body between files, or reorganizing never
breaks a reference.

### A.3 Conflict → approval → supersession loop (the core value)

On **promote** (and inside `/ship`), the kernel:

1. Finds existing **promoted** decisions that share the incoming record's
   `topic_key`/`component`, via **exact-key match first, then FTS5 MATCH** on
   `topic_key + body_prose`.
2. The **agent judges** whether a candidate is a *real* conflict (same topic,
   contradictory direction) versus an adjacent-but-compatible record.
3. On a real conflict the kernel **STOPS and asks the human**:
   **supersede / keep / cancel** — it never silently overwrites.
4. On **supersede**, it stamps the old record's `superseded_by`, sets the new
   record `promoted`, re-renders the map + affected subsystem file(s). On
   **keep**, both stay live but the pair is recorded in `conflicts_with[]` and
   surfaces in the map's `#open-Qs` count. On **cancel**, nothing promotes.

Nothing old is silently forgotten: supersession is explicit, human-approved, and
leaves a chain (`supersedes[]`/`superseded_by`) that the map and subsystem
"Active records" render truthfully.

### A.4 Regrouping = RE-TAG, not `git mv`

Because the map and subsystem files are **generated**, reorganizing the store
means changing `component`/`topic_key` on kernel records and re-rendering — never
moving markdown by hand.

- **Triggers:** a subsystem file exceeds a **legibility budget (~40 active
  decisions)**; a topic splits into two; or a decision sits under the wrong
  `component`.
- **"Cleaner" is MECHANICAL, so it is machine-scorable:** exactly one home per
  decision; no file over budget; no orphan or duplicate `topic_key`; no two
  live (non-superseded) decisions sharing one `topic_key`. An agent proposes a
  re-tag; CI scores it against these invariants.
- **MANDATORY human-approval gate.** The agent files a `regroup` proposal
  (old→new tag, affected `public_id`s, before/after metrics: files, per-file
  active counts, budget breaches, orphan/dup counts). The human chooses
  **approve / keep / cancel** before any record changes. `public_id`s,
  filenames, and links never break — only `component`/`topic_key` fields move.
- **Deferred past beta:** folder-splitting into `subsystems/<component>/`
  sub-trees. Beta keeps one file per component.

### A.5 Dual access — one substrate, two front doors

- **AGENT:** `forge decision check --topic <key> --text "..."` → kernel does
  exact-key match + FTS5 → returns ~5 lines (candidate `public_id`s + one-line
  directions + status). **STOP** if it finds a real conflict. The agent never
  greps markdown.
- **HUMAN:** INDEX → `PROJECT_DESIGN.md` (whole system on one screen) →
  component directory row → `subsystems/<component>.md` body → follow the
  `adr:` / `evidence:` links. Target: **≤ 3 clicks** from map to primary
  evidence.

### A.6 Worked example — PD-20260606-sqlite-local-authority

Today this decision lives inline in `PROJECT_DESIGN.md` (§ Decision registry) as
YAML front-matter + prose. Under the consolidated model it flows:

1. **Local:** authored in
   `docs/work/2026-06-06-kernel-backlog-memory-roadmap/decisions.md`
   (`d1--sqlite-wal-is-local-authority-only`, `d7--sqlite-is-the-first-kernel-authority…`)
   and `storage-decision.md`. Footer becomes `[promoted -> PD-20260606-sqlite-local-authority]`.
2. **Kernel record:** `public_id=PD-20260606-sqlite-local-authority`,
   `topic_key=authority.local.storage`, `component=kernel`, `status=promoted`,
   `adr=0001`, `evidence=[…decisions.md#d1…, …decisions.md#d7…, …storage-decision.md]`,
   `body_prose="Use SQLite WAL as the first Forge Kernel local authority; do not
   present SQLite/git files as safe multi-machine/team authority."`
3. **Rendered body:** `docs/architecture/subsystems/kernel.md#pd-20260606-sqlite-local-authority`
   (Active records + Data model implications).
4. **Frozen:** `docs/adr/0001-sqlite-local-authority.md` (irreversible: locks the
   local authority engine).
5. **Map row:** `PROJECT_DESIGN.md` component directory shows
   `| kernel | SQLite WAL local authority; server authority for teams | … | … | … | subsystems/kernel.md |`
   and the ADR log lists `0001`.

Note: `PD-20260606-sqlite-local-authority` is the decision that ADR-0002 (team
server backend) directly extends — SQLite-local is the reason a same-engine
(libSQL) server backend gives near-zero migration.

### A.7 BETA slice vs deferred

**BETA (build now):**

- Kernel schema fields on the `decision` record: `component`, `body_prose`,
  `adr`, `superseded_by` (plus `topic_key`, `conflicts_with[]`, `supersedes[]`).
- `forge decision check` — the conflict → approval → supersede gate (§A.3).
- `forge decision sync` — render `PROJECT_DESIGN.md` directory table + ADR log and
  the `subsystems/*.md` bodies from the kernel, each generated block wrapped in a
  **do-not-edit banner** with a **preserved hand-prose region** for the snapshot;
  plus a **CI render-drift gate** (fail if committed markdown ≠ freshly rendered).
- Hand-seed `docs/architecture/subsystems/kernel.md` and `knowledge.md` from
  existing PD entries grouped by `topic:`.
- Hand-author `docs/adr/0001-sqlite-local-authority.md`.
- One `AGENTS.md` decision-store nav block (agent front door + `forge decision
  check` pointer).

**DEFER (past beta):**

- `forge decision promote` full automation (beta promotes semi-manually through
  `design check`).
- Folder-splitting (`subsystems/<component>/`).
- JSONL manifest export of the decision store.
- OKF publish bundle (evaluation P3 — publish is the capstone, only worth running
  once the architecture layer has real content).
- Migrating all ~24 legacy PD entries: **seed 2 now** (kernel, knowledge),
  migrate the rest incrementally as each is next touched.

---

## B. Token-efficient retrieval pattern (decisions AND issues)

The decision store and the issue store share one retrieval discipline so both
stay cheap to read and both port unchanged from laptop to server.

**Tiered router — cheapest tier that answers wins:**

1. **Known id** → `show <id>` (single-row lookup).
2. **Exact attributes** → structured `WHERE` over B-tree indexes
   (`status`, `component`, `topic_key`, `priority_rank`, …).
3. **Keywords** → **FTS5 `MATCH`** → top-N by BM25.
4. **Cross-file / semantic** → escalate to grep / Explore / ctx. Only this tier
   touches the filesystem.

**Discipline:**

- Default read = **compact projection** (`id` + title/direction + status, one
  line each); fetch a body only on demand.
- **Never dump the whole list.** Return **top-N + a total count**.
- Prefer **read-models over scans**.
- **NO vectors / embeddings** — decided in `retrieval-router` (`b14aebc5`). FTS5
  BM25 is the semantic tier; escalation covers the rest.

**One file, both indexes:** a single SQLite(+FTS5) file holds the B-tree indexes
and the FTS5 index for decisions and issues alike. Because that file *is* the
kernel authority the broker already parses, the same retrieval code ports
unchanged from the local file to a libSQL server (Section C).

---

## C. Phase-2: team server + multi-surface sync (deferred; documented for forward-compat)

Phase-2 is **not** built in beta. It is documented here so the beta schema and
retrieval choices stay forward-compatible and so the ADRs have a written home.

### C.1 Server backend — libSQL family (ADR-0002)

**Target = self-hosted libSQL (`sqld`); managed Turso = the on-ramp; Cloudflare
rejected.** VERIFIED 2026-07-09: libSQL is literally SQLite — the same engine as
the local kernel file the broker already parses — so error strings are
byte-identical and migration is near-zero; it is MIT-licensed, actively
maintained (last commit 2026-07-01; ~185 commits/52wk and rising), and
**self-hosting is officially endorsed by Turso** even as they build a separate
Rust engine (still beta).

**IMPORTANT CORRECTION (carried into ADR-0002):** Cloudflare is rejected on
**runtime-paradigm / engine** grounds, **not** error-text divergence. Cloudflare
D1 *does* surface raw SQLite constraint text, and the broker matches
**substrings** (`/UNIQUE constraint failed/i` + `/kernel_claims\.issue_id/i`, see
Section D), so the earlier "CF breaks the conflict invariant" reason was
overstated. The real objection is the foreign Workers/Durable-Objects runtime and
the heaviest lock-in. See ADR-0002.

### C.2 Deployment for durable + fast at multi-org scale

- **Isolation:** libSQL **namespaces** (`--enable-namespaces`) — one namespace
  per project (serialized single-writer primary). An org → many projects → many
  namespaces on a single `sqld` process.
- **FAST:** each client runs an **embedded replica** (local, offline-capable
  reads; writes route to the namespace primary and serialize there) with
  **regional placement** near the team.
- **DURABLE:** **bottomless replication to S3** (continuous backup) with tested
  restores.
- **The one real cliff:** **no automatic write failover** (single-writer per
  namespace). Mitigation = a scripted **promote-from-bottomless** runbook + a
  fast-restart platform, **or** managed Turso for zero-touch HA.
- **Isolation / auth:** **per-namespace JWT** minted by the GitHub-App identity
  layer (Section C.3). Default = shared instance + namespaces; **dedicated
  per-org `sqld`** for enterprise hard isolation.
- **Control plane (the "Forge server"):** a thin service that authenticates
  (GitHub), maps `org → project → namespace → shard`, provisions namespaces on
  first use, mints scoped JWTs, routes clients, and orchestrates
  health/failover.
- **Phasing:**
  - **2a** — single `sqld` + namespaces + bottomless + embedded replicas.
  - **2b** — shard across `sqld` instances + control-plane router as org count
    grows.
  - **2c** — dedicated per-org instances (enterprise).
- **Hosting:** Fly.io Machines (regional + volumes + fast restart) / k8s
  StatefulSet + PVC / VPS + volume.

### C.3 Identity = GitHub (ADR-0003)

Actor = **GitHub identity + agent session-id**; the existing `sessions` table
already carries `actor` + `session_id`. Repo/org membership *is* the team
authorization boundary. OAuth **device flow** identifies the human from the CLI;
a **GitHub App** grants server repo-scoped access (not a personal PAT). This
fixes the actor-identity provenance gap (`d71a824b`). See ADR-0003.

### C.4 External issue-sync adapters (ADR-0004)

Pluggable per-provider adapters over the canonical kernel model; kernel is
authoritative by default, configurable per provider (external-authoritative
import / bidirectional). GitHub first; Jira / Linear as modules. Per-adapter
status/type mapping tables + `metadata.providers.<name>.*` passthrough.
Bidirectional drift reuses the existing `entity_revision` CAS + a `conflicts`
quarantine. The `decision` type and `claims` leases are **never** pushed. See
ADR-0004.

### C.5 Issue-surface findings (adaptability)

The kernel issue model is a **deliberate superset** and is ~90% ready for
external sync.

- **The one MUST core change:** ADD an **`external_refs` table** at issue +
  comment grain: `entity_type, entity_id, provider, external_id, external_key,
  external_url, external_revision, last_pulled_at, last_pushed_at`. Deferrable
  past beta — additive migration, no backfill. (Kernel `431c2c1e`.)
- **SIMPLIFY-later (adapter-driven, not now):** relax epic-only parenting; gate
  status-transitions on `origin=sync` (the `events.origin` field already
  exists); generalize field-authority into a per-provider map (the
  `KERNEL_FIELD_AUTHORITIES` axis already exists:
  `forge`/`provider`/`configured_provider`/`projection_only`). (Kernel
  `484e3384`.)
- **KEEP the superset — do NOT add:** a status-category column (the 5 stored
  statuses ARE the category spine); an extensions bag (the `metadata` TEXT blob
  already exists); a relation-type column (relation types already store in
  `dependency_type`).
- **FTS over issues:** the same FTS5 index pattern (Section B) applies to issues.
  (Kernel `44643ac0`.)

### C.6 Other team surfaces to sync later (ride the same server)

Config, plans, the decision module itself, team skill-sharing, and online memory
(cross-machine / cross-person) all ride the same libSQL server later. Each links
an **existing** kernel issue rather than duplicating scope:

| Surface | Existing kernel issue |
|---|---|
| Config sync | `forge-be` |
| Plans sync | `9f6ffb42` |
| Skill-sharing | `55dfeccf` / `a0776e61` |
| Online memory | `bb8c6508` |

---

## D. The one BETA carryover from Phase-2 planning

Pin the broker's conflict classification with a **CI integration test that
asserts the exact conflict substring** against whatever backend is deployed
(bun/node `sqlite` now; libSQL / Turso / CF later).

The broker classifies conflicts by substring match today
(`lib/kernel/broker.js`):

- idempotency conflict → message matches `/UNIQUE constraint failed/i` **and**
  `/idempotency_key/i`.
- claim-lease conflict → message matches `/UNIQUE constraint failed/i` **and**
  `/kernel_claims\.issue_id/i` (the active-lease partial-UNIQUE index, distinct
  from a duplicate-`id` PK violation).

A test that forces both collisions and asserts these exact substrings ("UNIQUE
constraint failed: kernel_claims.issue_id" / "…idempotency_key") is **~12 lines
of broker + one test** and becomes a **CI-enforced, backend-agnostic contract**
that catches error-dialect divergence at build time — the moment a future
backend stops surfacing the `<table>.<column>` token, CI fails instead of a
silent misclassification in production. This is the single durable de-risk for
the whole Phase-2 backend decision and absorbs the earlier "typed conflict
signal" idea. Kernel issue `d4ce47bb`.

---

## E. Verify-before-lock (for ADR-0002)

Before ADR-0002 moves from `proposed` to `accepted`, verify:

1. **libSQL error-text parity (the linchpin):** run the broker's conflict cases
   through `@libsql/client` against a **remote `sqld`** and confirm the
   substrings from Section D still appear verbatim.
2. **Turso embedded-replica roadmap for new accounts** — the A-vs-C tiebreaker:
   confirm embedded replicas remain first-class for newly created Turso accounts
   (the reason managed Turso is the on-ramp, not the target).
3. **`sqld` HA / failover reality** — confirm the single-writer-per-namespace
   model and that promote-from-bottomless is a scripted, tested runbook.
4. **Cloudflare `<table>.<column>` token** — only if CF is kept on the
   alternatives table: confirm D1/DO still surface the `kernel_claims.issue_id`
   token in the UNIQUE message (re-openable via spike `cc25a59a`).

---

## F. Tracking

| Kernel issue | Scope |
|---|---|
| `926d772a` (epic) | Team server + sync |
| `a8b907cb` | Backend / ADR-0002 |
| `dab834e2` | Identity / ADR-0003 |
| `431c2c1e` | `external_refs` table |
| `484e3384` | Issue-surface tweaks (adapter-driven simplifications) |
| `44643ac0` | FTS over issues |
| `d4ce47bb` | BETA conflict-substring de-risk (Section D) |
| `cc25a59a` | Cloudflare DO-error spike (ADR-0002 re-open path) |
| `d5e80e07` | Verify libSQL — **CLOSED, verified** |
| `53cd20d7` (+ `7bb4196b`, `c3507eb7`) | Decision store |
| `b6bdf122` (epic) | Knowledge architecture |

**OKF eval evidence:** `docs/work/2026-07-04-info-architecture-eval/evaluation.md`.
