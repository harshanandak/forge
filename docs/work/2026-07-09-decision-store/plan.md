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
and the FTS5 index for decisions, issues, and memory alike. Because that file
*is* the kernel authority the broker already parses, the same retrieval code
ports unchanged from the local file to a libSQL server (Section C).

### B.1 Memory consolidation onto the kernel (beta)

`forge remember` / `forge recall` are the **third consumer** of this layer — and
today they bypass it. Assessment 2026-07-09 (read-only, file-grounded) found
**three disconnected stores**:

- **JSONL (the live CLI path):** `remember`/`recall` append to / scan
  `.forge/memory/notes.jsonl` (`lib/memory-store.js`) — whole-string substring
  match, **re-reads the entire file every call**, `--limit` applied only *after*
  full load, and **no default output cap** (context-flood as notes grow).
- **`kernel_memories` (orphaned):** the kernel table exists (`schema.js:267`,
  migration 005) and `insights.js:309` is its *only* writer — **nothing reads it
  back**, so everything the insights engine learns is invisible to `recall`.
- **Graphiti:** config + doctor + MCP-descriptor scaffolding only, **no runtime
  emit path** (`router.js:150` "lands in a fast-follow"); the local floor always
  writes, so it is a no-op today.
- Docs lie: `TOOLCHAIN.md:139` claims recall is "kernel-backed"; it is JSONL.

**DECISION — consolidate onto the kernel + FTS5 (one knowledge layer with
decisions and issues).** Route `remember`/`recall` through `kernel_memories`,
indexed by the **same Section B FTS5 layer**; retire the JSONL `memory-store.js`.
Chosen over keeping JSONL because it **connects insights → recall** (learnings
become recallable), makes recall **token-efficient** (FTS5 BM25 replaces both the
substring bug *and* the full-file scan), and **rides the Phase-2 server** for
online cross-machine memory later (`bb8c6508`) with zero extra plumbing — memory,
decisions, and issues then share one substrate, one retrieval router, one sync.

**BETA (build now):**

- Route `remember` write + `recall` read through `kernel_memories`
  (`recordMemory` / a read path over `searchMemoryRows`, `sqlite-driver.js:1707`),
  retiring `lib/memory-store.js`; migrate any existing `.forge/memory/notes.jsonl`
  on first run.
- **FTS5 index over `kernel_memories`** (the shared foundation, §B) → token-AND
  BM25 recall. Same index work decisions need — **built once, consumed by both**
  (and issues, `44643ac0`).
- **Cap default `recall`** to newest-N + total count (no bare full dump).
- **Connect `insights`** — its skill candidates already land in `kernel_memories`,
  so recall surfaces them the moment it reads that table.
- Fix `TOOLCHAIN.md:139`; mark the Graphiti backend **experimental** in help/docs
  until its emitter ships.

**DEFER (past beta):** the Graphiti emitter (`router.js:150`); the typed/category
memory API (`typed-api.js`) beyond what recall needs; online/server memory sync
(`bb8c6508`, Phase-2).

This finally lands the never-completed "drop `project-memory.js` / route to
remember-recall" migration (`forge-be`) — done properly by unifying on
`kernel_memories` instead of adding a fourth store.

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
- **Committed topology (NOT a throwaway phase):** **one `sqld` + namespaces +
  bottomless + embedded replicas + platform crash-restart + the control-plane
  routing seam** is the target. One well-provisioned box holds hundreds of
  projects across dozens of orgs — a long runway. Steady-state ops is *light*
  (a single stateful container + S3 backup + monitoring); the only real cost is
  the no-auto-failover cliff, and even that is soft because embedded replicas
  keep **reads** up during a primary outage (only **writes** pause, briefly).
  The following are **ADDITIVE bolt-ons IF demand requires — not a rework**,
  because the routing seam + same-protocol on-ramp are designed in from day one:
  - **Shard** (a second `sqld`) — capacity only; the control-plane router
    already indirects, so it slots in without touching the app.
  - **Zero-touch HA** — a **config-swap to managed Turso** (same protocol), or a
    dedicated per-org instance. A toggle, not a migration.
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

### C.7 Concurrency + scale + agent coordination (verified 2026-07-09)

A 4-agent adversarial probe (edge-cases + scale red-team + comm-bus design →
synthesis) tested the CAS single-writer model against "many agents write at
once" and "teams/orgs grow", and evaluated the agent-communication
pass-through. Grounded in `lib/kernel/broker.js`,
`lib/kernel/lease-enforcer.js`, `lib/kernel/readiness-model.js`.

**Verdict: correctness holds at ANY scale — throughput/latency/UX do not.** The
CAS triad at the single per-namespace primary (row-CAS `expected_revision` →
`stale_revision`; partial-UNIQUE `kernel_claims.issue_id` → `claim_conflict`;
UNIQUE `idempotency_key` → duplicate-replay), all inside `BEGIN IMMEDIATE`, means
no double-claim / no lost write however many agents connect. Serialization at the
primary IS the guarantee — never delegated to any other plane.

**Two conditional holes — both deployment/wiring, not engine:**
- **C2 — identity-key collision (`d71a824b`, THE prereq).** The claim idempotency
  key is `claim.create:${issueId}:${actor}` with `actor` defaulting to `'forge'`.
  Until `actor` carries the **agent session-id**, two concurrent agents collide
  on the same key, dedupe to `ok:true`, and *both* pass `owns()` → silent
  double-work. It is a **correctness** hole, not just provenance. Fix = session-id
  in the claim key AND lease actor. Must land **first** — it also yields the
  stable per-session **address** presence + messaging later need. (Beta.)
- **C1 — multi-primary topology.** Any path where writes don't all reach the one
  primary (silent local fallback, mis-pointed clone, two namespaces mistaken for
  one) breaks the guarantee *silently*. Fix = **fail-closed** if the primary is
  unreachable (never a silent local write) + assert namespace identity at
  connect. (Server-plane; matters once Phase-2 lands.)

Everything else that "degrades" is NOT correctness: **throughput** (one
serialized writer per namespace is a hard per-project ceiling), **latency of
conflict awareness** (races surface only at write-time or next replica sync,
never pushed), **wasted work** (queue-top thundering herd, stale-replica
reasoning, merge collisions on related files the row engine is blind to).

**The four planes** (each fails safe DOWN to the plane below; none weakens it):
1. **Correctness — CAS single-writer primary.** The floor, authoritative,
   per-row/per-namespace. Never delegated.
2. **Work-distribution — lease dispatch.** A per-project coordinator hands
   *different* ready issues to *different* idle agents as a ~30s **advisory
   reservation**; the agent then does the **real `forge claim`** (CAS decides
   ownership). Kills the herd by construction — scheduling OVER the authority,
   never replacing it.
3. **Throughput — namespace/shard spread.** One primary per project = the unit of
   write parallelism AND of coordination. Many teams/orgs = many independent
   primaries + coordinators; no global bottleneck. The ONLY answer to the
   single-writer ceiling.
4. **Coordination — the advisory real-time bus.** Fan-out of events *already in
   the projection outbox* (`issue.claimed/released/updated`, `claim.conflict`,
   `decision.proposed/superseded`, `work_folder.touched`, `ready.changed`).
   Agents react by **re-reading / re-validating — never by trusting the event.**

| Edge case | Correctness | Mitigation | When |
|---|---|---|---|
| Identity-key collision (C2) | AT RISK | session-id in claim key + lease actor | **Beta (prereq)** `d71a824b` |
| Multi-primary topology (C1) | AT RISK | fail-closed on unreachable primary | Phase-2 |
| Thundering herd on rank-0 ready | safe | randomized top-K pick → lease dispatch | Beta (top-K) / Phase-2 |
| Retry storm / livelock (no backoff today) | safe | bounded exp-backoff + jitter in adapter | **Beta** |
| Stale-replica premise | safe (CAS retry) | read-your-writes; presence/bus | Phase-2 / Phase-3 |
| Cross-work overlap (same file/decision) | safe but blind | work-scope in the coordination layer | Phase-3 |
| Presence gap | n/a | live `forge who` from leases | Phase-2 |
| Single-writer ceiling | safe | namespace = shard; dispatch cuts doomed writes | inherent |
| Org fan-out | safe within ns | per-project shards scale independently | Phase-3+ |

**Agent-communication pass-through: YES — but not first, never for correctness.**
The three cheapest, highest-value fixes are NOT the bus and land first
(session-id identity, top-K/lease dispatch, backoff+jitter) — they retire the
herd, C2, and retry collapse with no new transport. The bus earns its keep on the
two axes those cannot touch: **latency of conflict awareness** and **cross-work
overlap the row engine is structurally blind to**. Firm yes at **Phase-3,
measurement-gated** on high-density hot namespaces.

**Transport = a swappable `CoordinationBus` interface** (mirroring the
`KnowledgeStore` boundary): **Cloudflare Durable Object + WebSocket Hibernation**
hosted (one DO per project = the coordination boundary 1:1; hibernation parks
thousands of idle agent sockets at ~zero cost), **NATS JetStream** self-hosted,
Redis a substitute. This is where CF DO legitimately re-enters — **coordination
plane ONLY; authority stays self-hosted libSQL.** That split (cloud coordination
+ self-hosted authority) is the one philosophical tension to accept consciously;
the NATS impl behind the same interface is the self-hosted-purist escape hatch.

**HARD rule (non-negotiable):** the bus is **advisory only; CAS at the primary is
the sole source of truth.** It is fed FROM the authoritative commit (outbox CDC)
so it cannot become a second truth; it MUST NOT gate or block a write (lease
acquired at the primary, bus notified *after*); no exactly-once logic may make
correctness depend on it; presence/reservations hold no durable state not
reconstructible from the leases. **Bus down ⇒ agents fall back to pull `forge
ready` → CAS claim → discover conflicts at write-time** — correctness identical to
today; the only loss is earliness.

**Rollout:**
- **Beta — close the two holes + stop the cheap bleeds** (all local, no infra, no
  bus): (a) session-id in claim key + lease actor (`d71a824b`); (b) bounded
  backoff+jitter on `stale_revision`/`BUSY` in the adapter (a policy was designed
  under `forge-2a` but no backoff is implemented in `lib/` today — new); (c)
  randomized top-K ready pick as the stop-gap herd fix (new); (d) fail-closed C1
  guard captured for Phase-2.
- **Phase-2 — lease dispatch + presence (read-only bus).** Per-project
  coordinator (advisory reservation → real CAS claim); presence v1 `forge who` as
  a live projection of leases (rides `b7334f51`); emit advisory outbox events,
  agents re-read before continuing.
- **Phase-3 — full real-time bus + agent↔agent negotiation + self-hosted
  parity.** Pub/sub incl. `work_folder.touched`/subsystem scope (the cross-work
  fix); direct request/reply (supersede-my-decision, sequence-this-refactor —
  resolutions still land as kernel events); NATS behind `CoordinationBus`.
  Extends prior coordination design (`forge-og`, `cc25a59a`, the `forge-2a` DO
  mutation contract).

**The ONE seam to reserve now (so none of the above is a rewrite):** the
**`CoordinationBus` interface as a first-class boundary with the projection
outbox as its sole feed**, plus threading `session_id`/`worktree_id` (already on
claim events, `broker.js:617-618`) as the stable presence/message **address** the
moment identity lands in Beta. Reserve those two and Phases 2–3 are additive
implementations behind a stable seam — never a re-plumb of the authority path.

**Already tracked (cross-checked — NOT re-filed):** C2 `d71a824b`; typed
conflict-signal `89bf8930` / `d4ce47bb`; busy-timeout policy + concurrency tests +
lease engine + DO mutation contract + serialized-authority gate (`forge-2a`
epic); presence/live read model `b7334f51`; CF DO spike `cc25a59a`; identity
`13b80fb1` / `dab834e2`; real-time coordination service `forge-og`; team-server
epic `926d772a`. **New this pass (filed):** backoff+jitter impl; top-K herd
stop-gap.

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
