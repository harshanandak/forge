# Kernel-Native Skills & Agents — Design

Status: DESIGN ONLY (no code). Date: 2026-07-04.

## Purpose

Forge is migrating off the Beads plugin onto its own event-sourced SQLite **kernel**. This
doc designs a SKILLS + AGENTS catalog that (a) covers everything the Beads plugin offered,
(b) is *more* extensive because the kernel exposes more, (c) is reliable by construction, and
(d) encodes our ideology: skills/gates/workflows are **editable canonical sources** users fork
and carve ("hammer and shovel"), TDD-first, kernel = single source of truth.

## Landscape inventoried (read, not guessed)

**Beads plugin** (`~/.claude/plugins/cache/beads-marketplace/beads/0.49.1`):
- 1 skill: `beads` (SKILL.md) — "git-backed issue tracker … survives compaction".
- 1 agent: `task-agent.md` — "Autonomous agent that finds and completes ready tasks":
  `ready` → `show` → `update in_progress` → execute → on discovery `create`+`dep discovered-from`
  → `close` → repeat. **No lease awareness, no conflict handling — it just flips status.**
- 30 command docs: audit, blocked, close, comments, compact, create, daemon(s), delete, dep,
  epic, export, import, init, label, list, prime, quickstart, ready, rename-prefix, reopen,
  restore, search, show, stats, sync, template, update, version, workflow.

**Forge current skills** (`skills/*/SKILL.md`) — these are **workflow-stage** skills, not
issue-store skills: `kernel` (umbrella index/router), `plan`, `research`, `dev`, `validate`,
`ship`, `review`, `verify`, `status`, `rollback`, `shepherd`, `sonarcloud(-analysis)`,
`hermes-forge`, `parallel-deep-research`. There is **no** kernel work-finder agent, no
backlog-hygiene / dependency-planning / triage / insights-tuning / memory skill.

Two facts anchor this design to *extend, not duplicate* (both verified in the repo):
- **`kernel/SKILL.md` is the umbrella INDEX/ROUTER, not a worker** (5.8 KB, 45 references to the
  stage skills). It documents the `forge issue`/`board` verbs and routes to `plan/dev/validate/
  ship/review/verify/status`. Every net-new skill below is registered *through* this index — the
  `kernel` skill gains a "Kernel operations" section linking to them, and no new skill
  re-documents the stage ladder or the verb reference the `kernel` index already owns.
- **Agent infra is minimal:** the only agent file is `.claude/agents/command-grader.md` (no root
  `agents/` dir, no autonomous work-finder). So `kernel-worker` is genuinely net-new infra, not a
  rewrite of an existing agent.

**Kernel surface** (`lib/commands/*.js`, `lib/kernel/*.js`) confirmed present: create, update,
claim, release (+`release check` gate), comment, close, show, list, ready, search, stats,
blocked, stale, orphans, lint, dep, `issue children` (epic rollup); top-level insights, explain,
export, sync (hydrate), adapter, add, audit, doctor, board, orient, recap, recall, remember.
Kernel modules: broker, evaluators, **lease-enforcer**, **readiness-model**, taxonomy-validator,
planning-buckets-schema, projection-jsonl-writer.

**Two structural facts that make the kernel richer than Beads:**
1. **Readiness is a *derived* read model (D18).** `ready`/`blocked` are computed on demand from
   dependencies + claims + quarantine/conflicts + gates + defer windows + policy, and are never
   stored as status. Epics and decisions are `claimable:false` so they never enter the ready
   queue. Beads `ready` is a flat "no open blockers" query.
2. **Claims are leases with a race-safe result contract.** A claim is a `kernel_claims` row
   protected by a partial UNIQUE index (`idx_kernel_claims_active_lease`). The broker's
   `mapMutationResult` (broker.js:788-822) makes the CLI result trustworthy:
   `accept` → `ok:true` (you own a fresh lease); `duplicate/dedupe/projection_echo` → `ok:true`
   (idempotent replay of *your* claim — still owned); `quarantine` (a genuine conflict against
   another agent's live lease) → **`ok:false`** error envelope (`FORGE_ISSUE_CONFLICT`,
   exit=conflict). So — correcting an earlier draft — a real conflict does **not** return
   `ok:true`; the loser is told `ok:false`. Beads has no leases at all; two agents can both "claim"
   the same task. **The two real residual risks (below) are lease expiry/reclaim and the shared-
   actor duplicate-collapse bug — not a phantom `ok:true`-on-conflict.**

## Prerequisite — kernel fix: per-agent actor identity (blocks reliable multi-agent skills)

Tracked as kernel issue **d71a824b**. Verified in source and it undermines every claim-based skill:

- The CLI issue context wires **no** actor / sessionId / idempotencyKey (`forge-issues.js:452-457`
  builds `context = { projectRoot, deps }` only).
- The claim idempotency key is `` `${eventType}:${issueId}:${actor}` `` (`broker.js:605`) and
  `actor` defaults to the literal `'forge'` (`broker.js:658`).
- Same-key claims are collapsed to a **duplicate replay before the lease-conflict guard even runs**
  (`lease-enforcer.js:18`).

Consequence: two concurrent CLI agents both run as actor `'forge'`, so a second agent's claim on
the same issue produces the **same idempotency key** → `decision:'duplicate'` → **`ok:true`** with
the issue + `claim_id`. Both agents believe they own the lease; the guard never sees a conflict.
The lease is only race-safe when actors are *distinct*.

**Fix (design, not built here):** wire a distinct per-agent `actor` (e.g. `FORGE_ACTOR` env, else
worktree/branch, else a session id) into the kernel issue context so distinct agents get distinct
idempotency keys. Then a genuine second claim reaches the guard and returns **`ok:false`**
(conflict), and `claim-safety` can verify `claimed_by == own actor`. This is **build step 0** — no
claim-based skill is reliable until it lands.

## Gap table

Rows = kernel capability. Columns = Beads equivalent · current Forge skill · proposed
kernel-native · **Coverage** (NET-NEW = no existing Forge skill; PARTIAL = a stage skill grazes it
but doesn't own it; EXISTING = already covered, we only wrap/link it).

| Kernel capability | Beads equivalent | Current Forge skill | Proposed kernel-native | Coverage |
|---|---|---|---|---|
| Find + claim + execute ready work, lease-safe | `task-agent` (status-only, no leases) | — (`dev` executes a *known* task) | **AGENT `kernel-worker`** | NET-NEW |
| Derived readiness (deps+claims+gates+defer+policy) | `ready` (flat) | `status` (read-only surface) | **SKILL `triage-ready`** | PARTIAL → extend |
| Lease acquire/verify/reclaim + conflict result | none | — | **SKILL `claim-safety`** (its own reusable canonical skill) + used by `kernel-worker` | NET-NEW (needs prereq d71a824b) |
| Orphans (dangling deps) | none | — | **SKILL `backlog-hygiene`** | NET-NEW |
| Lint (missing content) | none | — | `backlog-hygiene` | NET-NEW |
| Stale (expired claims / idle in-progress) | none | `status` (surfaces, no repair) | `backlog-hygiene` | PARTIAL → extend |
| Dependency graph edit/repair (`dep`) | `dep` (add/remove) | — | **SKILL `dependency-planning`** | NET-NEW |
| Epic rollup (`issue children`) | `epic` | — | `dependency-planning` | NET-NEW |
| Recurring-pattern detection (`insights`) | none | — | **SKILL `insights-tuning`** | NET-NEW |
| Runtime graph explain (`explain`) | none | — | **SKILL `graph-forensics`** | NET-NEW |
| Event history / quarantine / outbox | none (JSONL snapshots) | — | `graph-forensics` | NET-NEW |
| Export / hydrate / sync (JSONL projection) | `export`/`import`/`sync` | — | **SKILL `snapshot-portability`** | NET-NEW |
| Memory: remember/recall/recap/orient | none (compaction survival only) | `kernel` orient (index only) | **SKILL `memory-handoff`** | PARTIAL → extend |
| Extension lockfile + review adapters (`add`/`audit`/`adapter`) | none | — | **SKILL `extend-kernel`** (ideology core) | NET-NEW |
| Health (`doctor`) | none | — | `backlog-hygiene` (health sub-step) | NET-NEW |
| Team status view | `stats`/`list` | `status` + `kernel` index | `triage-ready` uses **`ready`/`blocked`/`stats`** (NOT `board`) | PARTIAL → extend |
| Issue/board verb reference + stage routing | `prime`/`workflow` | **`kernel` umbrella index** | — (keep; add links to new skills) | EXISTING |
| Stage ladder (plan→dev→validate→ship→review→verify) | none | 6 stage skills + `status` | — (unchanged) | EXISTING |
| CRUD (create/update/close/comment/show/search/stats) | ✓ (1:1) | via commands, no skill | **SKILL `issue-basics`** (parity floor) | NET-NEW |

Net-new = 11 of 13 proposed items. The two EXISTING rows are deliberately **not** touched except
that the `kernel` umbrella index gains links to the net-new skills. Where the kernel clearly
exceeds Beads: lease/conflict-aware ready work, derived readiness, orphans, lint, stale, event
history + quarantine, insights, explain, and extension adapters.

**Note — `board` reads Beads, not the kernel** (`board.js:3` → `readBeadsSnapshot`). It is out of
scope for kernel-native triage; `triage-ready` uses `ready`/`blocked`/`stats` instead.

### Beads verb disposition (nothing silently dropped)

Every Beads verb with no 1:1 kernel skill is accounted for, so the migration has no silent gaps:

| Beads verb | Kernel disposition |
|---|---|
| `label` | **No subcommand** — map to the `--label "a,b"` comma-separated flag on `create`/`update` (`broker.js:448-455`); `issue-basics` documents this. |
| `delete` | **Intentionally unsupported** — the kernel is append-only/event-sourced; use `close` (state this explicitly; do not design a delete skill). |
| `reopen` | Map to `update` (set status back to open); covered by `issue-basics`. |
| `daemon` / `daemons` | Out of scope — no background sync daemon in the local-authority kernel. Backlog, not a skill. |
| `rename-prefix` | Out of scope for the migration; backlog. |
| `compact` / `restore` | Beads-only semantic compaction; no kernel analog (see Open Questions). |
| `template` | Beads-only; no kernel analog (see Open Questions). |
| `audit` (Beads = append-only **interaction log**) | **NOT** covered by forge `audit` (= extension **lockfile** verify). Different concept — flag as an unmet capability, not a rename. |
| `sync` | Kernel `sync` is a deliberate **local-noop** (single-machine authority); `snapshot-portability` documents this rather than implying remote sync. |

## Proposed catalog

Convention (ideology): every entry is a single editable `SKILL.md` / agent `.md` with a
`## Fork points` section naming the exact thresholds, queries, and gate toggles a user changes to
carve their own workflow. Skills never hard-code a fixed ladder; they call `forge` verbs and read
JSON (`--json`) so a fork can swap steps.

### AGENTS (autonomous workers)

- **`kernel-worker`** — the flagship; the lease-safe successor to `beads:task-agent`.
  Loop: `ready --json` → pick by priority/readiness → `claim` → **embed `claim-safety` to verify
  ownership** (`forge issue show <id> --json` → `data.claimed_by == own actor`, not expired) →
  `dev`/execute → `create`+`dep discovered-from` for discoveries → **`forge release check`
  (release-readiness gate) → `close`** → repeat. More extensive/reliable than task-agent: respects
  derived readiness (skips epics/decisions, honors defer windows + gates), verifies it actually
  won the lease before working, and gates the close on `release check`. Editable: fork points for
  selection policy, per-loop budget, and stop conditions. **Depends on prereq d71a824b.**

- **`backlog-groomer`** — **DEFERRED** (not in the first cut). The autonomous scheduled variant of
  `backlog-hygiene` (bounded `orphans`+`lint`+`stale`+`doctor` sweep, dry-run first). Ship the
  `backlog-hygiene` *skill* first; add this agent only once its autofix set is trusted, so a
  human-in-the-loop validates repairs before they run unattended.

### SKILLS (procedures an agent follows)

- **`triage-ready`** — surface the *right* next work. Read-only; uses `ready`, `blocked`, `stats`
  (**not `board`**, which reads Beads). Explains *why* the top item is ready (deps/claims/gates).
  Fork: ranking weights, filters.
- **`claim-safety`** — the reusable, **standalone canonical** "claim → verify you own the lease"
  procedure (NOT folded into `kernel-worker`, so any skill that mutates a claimed issue reuses it).
  Contract: `ok:false` ⇒ you did not get it (conflict/validation) → reselect; `ok:true` ⇒
  provisionally yours, but because a `duplicate` replay also returns `ok:true`, **always confirm
  ownership** via `forge issue show <id> --json` → `data.claimed_by` equals your own actor and the
  lease is not expired. Re-verify before `release`/`close` (lease can be reclaimed on expiry). Fork:
  actor source, expiry/lease TTL, re-verify cadence. See Reliability. Depends on prereq d71a824b.
- **`backlog-hygiene`** — `orphans` (dangling deps) + `lint` (missing content) + `stale`
  (expired/idle claims) + `doctor`, with a safe repair playbook. Fork: staleness window, autofix set.
- **`dependency-planning`** — build/repair the graph: `dep` add/remove, cycle checks, `issue
  children` epic rollup, planning-bucket assignment. Fork: dependency taxonomy, epic thresholds.
- **`insights-tuning`** — run `insights`, read recurring-pattern signals, propose conservative
  workflow/gate adjustments (never auto-applied). Fork: which patterns act vs. only report.
- **`graph-forensics`** — answer "why is this blocked/quarantined?" via `explain`, event history,
  and quarantine/conflict inspection. Read-only. Fork: depth, which primitives to trace.
- **`snapshot-portability`** — JSONL projection for review/backup/migration. Export = `forge export
  [--dir]`; **hydrate = `forge export --import`** (reads committed JSONL → writes `kernel.sqlite`,
  integrity-checked; `export.js:120-124`) — there is no separate `import`/`hydrate` verb. `sync` is
  a deliberate **local-noop** (single-machine authority), so this skill does not imply remote sync.
  Fork: export dir, dry-run policy.
- **`memory-handoff`** — session continuity via `remember`/`recall`/`recap`/`orient`; write a
  durable handoff note keyed to issues before context ends. Fork: note schema, tags.
- **`extend-kernel`** — the ideology-defining skill: how to fork a skill/gate/adapter and register
  it via `add`/`audit`/`adapter` (extension lockfile). Turns "hammer and shovel" into a procedure.
- **`issue-basics`** — parity floor mapping every Beads command a user relied on to its `forge`
  verb so nothing regresses: create/update/close/comment/show/search/list/stats direct; `label` →
  `--label "a,b"` flag; `reopen` → `update` status; `delete` → **unsupported** (append-only, use
  `close`). See the Beads-verb disposition table.

## Reliability requirements (per skill)

- **`kernel-worker` / `claim-safety` — lease ownership (corrected):** the hazard is **not** a
  phantom `ok:true`-on-conflict — a genuine conflict returns **`ok:false`** (broker.js:811-821). The
  real risks: (a) a `duplicate` replay also returns `ok:true`, and under the shared-actor bug a
  *second agent's* claim collapses to `duplicate`, so `ok:true` alone does not prove sole ownership;
  (b) a live lease can be **reclaimed on expiry** (`planClaimAcquisition` → `reclaim`, supersedes
  the prior owner; lease-enforcer.js:68-74). Therefore: on `ok:false` reselect; on `ok:true`
  **verify `forge issue show <id> --json` → `data.claimed_by == own actor` and not expired** before
  working, and **re-verify before `close`/`release`**. `data.claimed_by` is lease-derived
  (sqlite-driver.js:193-196) — there is no `claims` command. RED test: assert the skill refuses to
  proceed on a `duplicate`-collapsed foreign claim; do **not** author an impossible `ok:true`+conflict
  test. Full multi-agent safety requires prereq d71a824b (distinct actors).
- **`triage-ready`:** readiness is derived — always recompute from `ready`, never cache a stored
  "status == ready"; exclude non-claimable types (epics/decisions) and defer-windowed items.
- **`backlog-hygiene` / `backlog-groomer`:** dry-run before any mutation; repairs idempotent and
  reversible; `orphans`/`lint` findings become issues, not silent edits. Bounded per pass.
- **`dependency-planning`:** reject cycles before writing; validate against taxonomy-validator;
  epic rollup reads children, never guesses membership.
- **`graph-forensics` / `snapshot-portability`:** strictly read-only / export-only; never mutate
  kernel state while inspecting or exporting.
- **`insights-tuning`:** advisory only — surface suggestions, require explicit human/gate approval
  before changing any threshold.
- **All:** consume `--json` and check `ok`/error envelopes; fail closed on missing clock/state
  (mirror readiness-model's "no usable clock ⇒ not workable").

## Build sequencing (TDD, verified)

Build the smallest reliable spine first; each ships with a RED test before implementation.

0. **Actor-identity kernel fix** (prereq, issue d71a824b) — wire a distinct per-agent `actor` into
   the kernel issue context. *Verify:* two contexts with distinct actors claiming one issue — the
   second returns **`ok:false`** (conflict), not `ok:true` (duplicate). Blocks steps 2-3.
1. **`triage-ready`** (skill, read-only) — safe to build first; needs no claim path.
   *Verify:* snapshot of `ready`/`blocked` derivation across deps/gates/defer fixtures; asserts
   `board` is never called.
2. **`claim-safety`** (skill, rewritten) — the reusable ownership-verification procedure.
   *Verify:* broker doubles for `accept`/`duplicate`/`ok:false-conflict`; assert it proceeds only
   when `show.claimed_by == own actor` and refuses on a foreign `duplicate`-collapsed claim. (No
   impossible `ok:true`+conflict test.)
3. **`kernel-worker`** (agent) — embeds `claim-safety`, runs `release check` before `close`.
   *Verify:* e2e with **two concurrent workers with distinct actors** (post-step-0): exactly one
   wins each lease, the loser reselects; epics/decisions/deferred never claimed; close is gated on
   `release check`.
4. **`backlog-hygiene`** (skill) — highest-value net-new capability Beads lacked.
   *Verify:* fixtures with known orphans/lint/stale; assert findings + idempotent dry-run repairs.

**Deferred:** `backlog-groomer` agent (until hygiene autofix is trusted). Then, in order:
`dependency-planning`, `memory-handoff`, `insights-tuning`, `graph-forensics`,
`snapshot-portability`, `extend-kernel`, `issue-basics`.

## Open questions

1. **Autonomy boundary for `kernel-worker`:** should it call the full `plan→dev→validate→ship`
   pipeline per claimed issue, or only execute pre-planned tasks and stop at `validate`? (Affects
   how much it overlaps the existing stage skills.)
2. **Actor-identity source (prereq d71a824b):** what defines a distinct `actor` — an explicit
   `FORGE_ACTOR` env, the worktree/branch, a generated session id, or a precedence chain of all
   three? This determines how robust the multi-agent lease guarantee is and must be settled before
   `claim-safety` / `kernel-worker`.
3. **Beads parity scope:** replicate Beads-only conveniences with no kernel analog —
   `compact`/`restore` (semantic compaction), `template`, and the append-only **interaction-log**
   `audit` (distinct from forge lockfile `audit`) — or declare them out of scope for the migration?
   (`delete`, `daemon(s)`, `rename-prefix` are already dispositioned above.)
