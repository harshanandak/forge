# Forge Sync Authority — Architecture & Interim De-Bead Design

**Date:** 2026-06-26
**Status:** Design (no product code changes in this PR)
**Author:** sync-authority worktree
**Scope:** Define the target `local kernel ↔ forge server ↔ external stacks` model, and the
**interim local behavior** that lets five Beads/Dolt-coupled files be de-beaded *now*, ahead of
the server existing.

---

## 0. Why this exists

The Beads-retirement gate is stuck on a cluster of files that still use `bd`/Dolt for **sync** and
**bootstrap**, not for issue storage (issue storage already routes through the Kernel — see
`lib/issue-backend.js`, default backend = `kernel`). These files can't be de-beaded until we decide
what they *do* without Beads/Dolt:

| File | Today (Beads/Dolt) |
| --- | --- |
| `lib/commands/sync.js` | `forge sync` = `bd dolt pull` + `bd dolt push` |
| `lib/commands/worktree.js` | per-worktree `.beads` bootstrap (`bootstrapBeads`) + `stopDolt` (kills Dolt server on remove) |
| `lib/commands/setup.js` | beads install/bootstrap, `bd init`, Dolt remote check (`hasBeadsDoltRemote`) |
| `scripts/preflight.sh` | `bd init`, writes `.beads/config.yaml` (`backend: dolt`), `bd doctor --fix` |
| `scripts/smart-status.sh` | `bd list --json` as the issue data source + `bd init --force`/`bd backup restore` recovery |

This document defines the model to design around so a follow-up PR can execute the de-bead as a
**clean swap** (to a `SyncBackend` interface), not a deletion of capability.

This reconciles with prior decisions, which it does **not** re-litigate:

- `docs/work/2026-06-06-kernel-backlog-memory-roadmap/storage-decision.md` — **SQLite WAL is the
  Forge Kernel local authority; Dolt is not a Kernel authority backend.** Strict team authority is
  "serialized server authority, not raw SQLite or raw Dolt merges."
- `.../storage-and-concurrency-risks.md` — risk register row: *local-mode writes remain
  single-machine; team-mode writes require server authority* (project-scoped sequence, revisions,
  leases, replay, dead-letter queue).
- `.../agent-memory-federation.md` — Forge as the project memory **federation layer**; external
  data is `source_kind: external_projection` with `authority: proposal`, never authority-by-default.
- `.../dolt-re-evaluation.md` — Dolt remains valuable as history/provenance/branchable substrate
  *outside* the authority path, not as the sync hot path.

---

## 1. Target architecture

```text
   ┌──────────────────┐        push / pull         ┌──────────────────┐     projection (outbox)     ┌──────────────────┐
   │  LOCAL KERNEL     │  ───────────────────────▶  │   FORGE SERVER    │  ───────────────────────▶  │  EXTERNAL STACKS  │
   │  (this machine)   │  ◀───────────────────────  │  (authority hub)  │  ◀───────────────────────  │  GitHub, Dolt, …  │
   │                   │     accepted events        │                   │     inbound proposals       │  (projections)    │
   │ SQLite WAL        │                            │ serialized accept │                            │                   │
   │ .git/forge/       │                            │ project sequence  │                            │ mirrors behind    │
   │   kernel.sqlite   │                            │ + revision/lease  │                            │ the server        │
   └──────────────────┘                            └──────────────────┘                            └──────────────────┘
        single-machine                                team / cross-machine                              eventually consistent
          authority                                       authority                                       read models
```

### 1.1 Local kernel (today, single-machine authority)
- The Kernel is a single-machine SQLite WAL store at `<gitCommonDir>/forge/kernel.sqlite`
  (resolved by `lib/kernel/cli-broker-factory.js → resolveKernelDatabasePath`; `KERNEL_DB_FILE =
  'kernel.sqlite'`, default dir is the git **common dir**).
- **Critical property:** the DB lives in the git *common dir*, which every worktree of a repo
  shares. So the Kernel is automatically shared across all worktrees of one machine with **no
  per-worktree bootstrap** (this is the de-bead lever for `worktree.js`). It is bounded to *one
  user, one physical machine, many worktrees* — exactly the local-authority envelope in the risk
  register.
- All writes go through the broker (`lib/kernel/broker.js`): atomic `BEGIN IMMEDIATE`, CAS on
  `expected_revision`, idempotency-key dedup, DB-enforced claims, and a **projection outbox**.
- Because `kernel.sqlite` lives *inside* `.git/`, it is never committed and never pushed. **Pure
  Kernel issues are strictly single-machine until something projects them out** (see §2.1).

### 1.2 Forge server (future, team / cross-machine authority)
The server is the **sync/authority hub**, not just a relay:
- **Authority for cross-machine/team writes.** It owns a *project-scoped sequence* and assigns
  server revisions. Local kernels are clients: they push local events and pull accepted events.
  Conflicts are resolved by the same domain rules the broker already encodes locally
  (stale-revision → quarantine, duplicate → dedupe), applied at the serialization boundary.
- **Projection hub to external stacks.** External systems (GitHub Issues/Projects, Dolt, etc.) sit
  *behind* the server as projections/mirrors. The server drains its outbox to per-stack adapters;
  inbound external edits are ingested as **proposals** that need server acceptance (federation
  model: `external_projection` = proposal, not authority).
- The local kernel already contains the server's *local* analog: the same outbox + dead-letter +
  replay machinery (`enqueueKernelProjection`, `listProjectionOutbox`, `markProjectionDelivered`,
  `recordProjectionFailure`, `kernel_dead_letters`). The server generalizes this from one machine to
  a team.

### 1.3 External stacks (projections behind the server)
- External systems are **never authority**. They are read-model mirrors kept in sync by draining the
  outbox. This preserves the `storage-decision.md` split:
  `Kernel(SQLite)=authority`, `Beads/Dolt=compatibility/projection/history`, `team=server`.
- The existing outbox already carries a `target` discriminator (broker
  `buildProjectionOutboxEntry(event, context.projectionTarget || 'beads', now)`; `kernel_outbox`
  has a `target` column — `lib/kernel/sqlite-driver.js`). Each external stack is just another
  `target`: `beads`, `github`, `dolt`, …

---

## 2. The sync protocol shape

The protocol is **event-log replication with serialized acceptance** — *not* file/DB merge.

### 2.1 Push / pull
- **Push:** the local kernel sends its un-acknowledged local events (append-only, each carrying an
  idempotency key + the base revision it was written against) to the server. The server serializes
  them into the project sequence and returns, per event, one of `accepted` (with assigned server
  revision), `duplicate` (dedupe), or `quarantine` (stale-revision conflict).
- **Pull:** the local kernel requests events since its last-known server-sequence **cursor** and
  applies them locally. Application is idempotent — the broker already classifies re-applied events
  as `duplicate`/`projection_echo`, so replays are safe.
- **Cursor:** the local kernel persists a server-sequence high-water mark. This is the only new piece
  of local state the server era adds.

### 2.2 Conflict model / who-wins
- The server is the **serializer**; local is a working copy/cache. There is **no last-writer-wins**.
  Writes carry `expected_revision`; the server applies CAS at the sequence boundary. A write whose
  base revision is stale is **quarantined** for the agent/human to rebase — the same decision the
  local broker makes today (`storage-and-concurrency-risks.md`: "Forge still has to decide the domain
  result"). Dolt-style low-level conflict surfacing is an *input*, never the final answer.

### 2.3 External keep-in-sync (outbox / projection)
- Outbound: the server drains its outbox per `target` to an adapter that upserts into the external
  stack (idempotent on a stable external key). Failures go to dead-letter with exponential backoff —
  the consumer pattern already implemented locally by
  `lib/kernel/projection-jsonl-writer.runJsonlProjectionConsumer`.
- Inbound: an external poll/webhook converts external changes into proposal events submitted to the
  server's accept path. Proposals never bypass acceptance.

---

## 3. The sync interface/contract (the seam the server implements)

We introduce a single seam — `SyncBackend` — so each gated command codes to the interface now, and
the server era is a backend swap rather than a rewrite. This deliberately mirrors the existing
`lib/issue-backend.js` resolver pattern (precedence: explicit deps > env > `.forge/config.yaml` >
default), which already cleanly abstracts kernel-vs-beads for *storage*. `SyncBackend` does the same
for *sync*.

```js
/**
 * SyncBackend — the seam between `forge` commands and whatever moves Kernel
 * state off this machine. Selected by precedence (mirrors resolveIssueBackend):
 *   deps.syncBackend > FORGE_SYNC_BACKEND env > .forge/config.yaml `syncBackend` > 'local-noop'
 *
 * Every method is async and returns a plain result object (never throws for the
 * "nothing configured" case — that path must stay a graceful no-op).
 */
interface SyncBackend {
  name: string; // 'local-noop' | 'git-jsonl' | 'server'

  /** One-shot convenience used by `forge sync`. push()+pull() or a no-op. */
  sync(opts): Promise<{ success: boolean, synced: boolean, message?: string, error?: string }>;

  /** Send un-acked local events to the authority. */
  push(opts): Promise<{ pushed: number, accepted: object[], rejected: object[] }>;

  /** Pull accepted events since the local cursor; apply idempotently. */
  pull(opts): Promise<{ pulled: number, appliedThrough: string | null }>;

  /** Health/info for `forge doctor`, preflight, setup. */
  status(opts): Promise<{
    configured: boolean,   // is a remote/server endpoint set?
    endpoint?: string,
    cursor?: string | null,
    ahead?: number,        // local events not yet pushed
    behind?: number        // server events not yet pulled
  }>;
}
```

### Implementations (one ships now; the rest are the swap)
- **`LocalNoopSyncBackend` (default now).** `sync()` ensures the kernel is migrated, then returns
  `{ success: true, synced: false, message: 'Local kernel is single-machine authority; no remote
  configured.' }`. `status().configured = false`. This is the literal "local-noop now" the
  maintainer asked for; it makes the de-bead a clean, honest swap.
- **`GitJsonlSyncBackend` (recommended first *real* implementation — see decision in §5).** `sync()`
  drains the projection outbox into the **committable** mirror `.forge/kernel/{issues,comments,
  dependencies}.jsonl` + `manifest.json` (the format `projection-jsonl-writer.js` already produces;
  `DEFAULT_PROJECTION_DIR = .forge/kernel`, confirmed **not** gitignored). Cross-machine sharing then
  rides the existing `forge push`/git flow — the same "JSONL-in-git" model Beads used, but
  kernel-native and Dolt-free. No server required.
- **`ServerSyncBackend` (future).** Implements §2 push/pull/status against the Forge server over
  HTTP/gRPC. This is the seam the server team implements.

The server implements the *other* side of the same contract: serialized acceptance (project sequence
+ revision + lease + replay + dead-letter) and external projection via the outbox `target` it already
shares with the kernel.

---

## 4. Interim LOCAL behavior + de-bead plan (per gated file)

Goal: remove every `bd`/`.beads`/`dolt` reference while preserving (or cleanly stubbing) behavior
under §1's model. Each item is scoped enough for a follow-up PR to execute.

### 4.1 `lib/commands/sync.js` — `forge sync`
**Today:** `bd --version` gate → `bd dolt pull` + `bd dolt push`; `isRecoverableBeadsSyncError`.
**Change:**
- Delete `isRecoverableBeadsSyncError`, the `bd --version` probe, and the `bd dolt` calls.
- `handler` resolves a `SyncBackend` (default `local-noop`) and returns
  `await backend.sync({ projectRoot, ...opts })`. Keep the existing return shape
  (`{ success, synced, message?, error? }`) so callers/tests adapt minimally.
- Update `name`/`description`/usage strings: drop "Beads/dolt"; e.g. *"Sync Kernel issue state with
  the configured sync backend (local-noop until a server/remote is configured)."*
**Interim result:** `forge sync` is a graceful no-op that *names the model* instead of silently
shelling to `bd`. Swaps to `git-jsonl` or `server` with zero call-site churn.

### 4.2 `lib/commands/worktree.js` — `forge worktree create|remove`
**Today:** `bootstrapBeads` import + `setupBeadsWithBootstrap` (links `.beads`, runs `bd init`,
verifies `bd --version`) on create; `stopDolt` (kills the Dolt server via `bd dolt stop` / PID kill
from `.beads/*.lock`) on remove.
**Change:**
- **Create:** remove the `bootstrapBeads` import and `setupBeadsWithBootstrap`. **No per-worktree
  bootstrap is needed** — the kernel DB is in the shared git common dir, so a new worktree already
  sees the same kernel. `handleCreate` becomes: bare-repo guard → slug validation → `git worktree
  add` → `runInstall`. Drop `beadsWarning` from the result. *(Optional, additive:* call
  `ensureKernelMigrated` once so the shared kernel exists before first use — but first kernel command
  auto-migrates, so this is convenience, not necessity.)
- **Remove:** delete `stopDolt` entirely (no Dolt server, no `.beads/*.lock`, and the SQLite DB lives
  in the common dir — removing a worktree directory never touches it). `handleRemove` becomes slug
  validation → `git worktree remove`. The 500 ms lock-release wait can go.
- Update the module description ("…with Beads integration" → "…isolated worktrees").
**Interim result:** worktree create/remove is pure git, correct under the shared-common-dir kernel.

### 4.3 `lib/commands/setup.js` — `forge setup`
**Today:** `checkForBeads`, "Beads available — Run: `bd init`" / "npm install -g @beads/bd && bd
init" prompts, `requireBeadsCli`, `hasBeadsDoltRemote` (Dolt remote check), `scaffoldBeadsSync`.
**Change:**
- Drop the beads install/bootstrap path and the `bd` required-tool entry. Replace with a
  **kernel-ensure** step: ensure `<gitCommonDir>/forge/kernel.sqlite` is migrated via
  `buildMigratedKernelIssueDeps` / `ensureKernelMigrated` (idempotent).
- Map `hasBeadsDoltRemote` → `SyncBackend.status().configured`: interim message *"Local kernel ready;
  team sync server not configured (local-noop)."* No `bd dolt remote` guidance.
- Remove the `scaffoldBeadsSync` import/call (adjacent cleanup; see §6).
**Interim result:** setup provisions the kernel, not Beads, and reports sync as not-yet-configured.

### 4.4 `scripts/preflight.sh`
**Today:** `write_beads_config` (writes `.beads/config.yaml` `backend: dolt`), `write_beads_gitignore`,
`safe_bd_init` (`bd init --database forge --prefix forge`), `check_beads` (`bd list` / init / `bd
doctor --fix --yes`), and `bd` in `check_tools`.
**Change:**
- Delete `write_beads_config`, `write_beads_gitignore`, `safe_bd_init`, `check_beads`. Remove the
  `bd` check from `check_tools` (keep `jq`, `gh`).
- Add `check_kernel`: **FIX** = run the kernel-ensure command (the thing that triggers
  `ensureKernelMigrated` — e.g. `node bin/forge.js issue stats` auto-migrates, or a dedicated
  ensure entry point); **VERIFY** = `node bin/forge.js doctor` (D19 — reports the kernel DB path's
  filesystem class). Note: **`forge migrate` is *not* the migrator** (it is a v2→v3 dry-run PoC);
  `forge doctor` only *reports*, it does not init — so the FIX step must call a real auto-migrating
  command, then `forge doctor` verifies.
**Interim result:** preflight validates the kernel is present/readable on a healthy filesystem,
without touching `.beads` or Dolt.

### 4.5 `scripts/smart-status.sh`
**Today:** issue data source is `bd list --json --limit 0`; epic children via `bd children <id>
--json`; an auto-recovery block (`bd init --force` + `bd backup restore`, reads
`.beads/metadata.json`); `BD_CMD` override.
**Change:**
- Replace the data producer: `bd list --json --limit 0` → `node bin/forge.js issue list --json`
  (kernel-backed). Replace `bd children <epic> --json` with the kernel equivalent (a dependency/child
  query, or compute children from the dependency edges already in the issue list).
- Delete the beads auto-recovery block and `.beads/metadata.json` read. Kernel "recovery" = the
  broker's `ensureKernelMigrated` (auto), so the script no longer self-heals storage.
- Rename `BD_CMD` → `FORGE_ISSUES_CMD` (or similar) for the test override.
- **Keep the entire jq scoring/session/team-activity engine unchanged** — it operates on a JSON array
  of issues.
**Required verification (do not assume):** the scoring jq depends on exact fields — `.dependent_count`,
`.dependency_count`, `.dependents`, `.type`, `.priority`, `.updated_at`, `.status`. The compat
adapter `lib/adapters/beads-kernel-compat.js` already emits beads-shaped `type`/`priority`/
`updated_at`/dependencies, but the **denormalized** `dependent_count`/`dependency_count`/`dependents`
(readiness fields) must be confirmed present in `forge issue list --json` (see
`lib/kernel/readiness-model.js`). If absent, either extend the list projection or adjust the jq to
derive them from the dependency edges. This is the riskiest de-bead — it is a field-shape contract,
not a command rename.

---

## 5. Open questions / decisions for the maintainer

1. **Interim sync default: `local-noop` vs `git-jsonl`?** *(headline decision)*
   `local-noop` = pure no-op, honest, single-machine-only until the server. `git-jsonl` = drain the
   outbox to committable `.forge/kernel/*.jsonl` so teammates share issues over git **today** (the
   Beads model, minus Dolt). Recommendation: ship `local-noop` as the default to unblock the gate
   cleanly, land `git-jsonl` as the first real `SyncBackend` immediately after. **Decision needed:**
   do we want cross-machine issue sharing before the server, and if so should `.forge/kernel/*.jsonl`
   be auto-committed by `forge sync`/`forge push` or left for the user to commit?
2. **Server scope:** full serialized authority (owns sequence/revision/lease) vs thin relay over
   git? The risk register assumes full authority; confirm.
3. **Auth:** how do local kernels authenticate to the server (per-project token? user identity?
   existing `.forge-push-token`?), and what is the trust boundary for inbound external proposals?
4. **Transport:** HTTP/JSON, gRPC, or a git-remote-style protocol for push/pull?
5. **External adapter set & directionality:** which stacks first (GitHub Issues/Projects? Dolt for
   history?), and is sync bidirectional (inbound GitHub edits as proposals) or outbound-only mirror
   at first? Note existing `lib/issue-sync/*` and `scripts/github-beads-sync/*` are prior art.
6. **When does the server land?** This determines how much to invest in `git-jsonl` as a bridge.
7. **Cursor/sequence ownership & replay:** server owns the sequence; confirm local stores only a
   high-water cursor and that replay/dead-letter UX is server-side.

---

## 6. Adjacent (not in the 5 gated files, but same de-bead)

These also carry `bd`/Dolt sync/bootstrap coupling and should be cleaned in the same campaign:
- `lib/commands/clean.js` — `forge clean` stops Dolt servers on merged-worktree cleanup (same
  `stopDolt` removal as §4.2).
- `lib/beads-sync-scaffold.js` / `lib/setup.js` (`scaffoldBeadsSync`, `cleanupDeprecatedSyncFiles`).
- `lib/beads-health-check.js` — runs `bd sync`.
- `bin/forge.js` — imports `scaffoldBeadsSync`.
- Docs/strings: `CLAUDE.md`, `.claude/rules/workflow.md`, `lib/agents-config.js` still describe
  `forge sync` as "dolt pull + push" / "Sync Beads state".

---

## 7. Summary

- **Model:** `local kernel (SQLite, single-machine authority) ↔ forge server (serialized team
  authority + projection hub) ↔ external stacks (projections behind the server)`.
- **Seam:** one `SyncBackend` interface, selected like `resolveIssueBackend`; `local-noop` now,
  `git-jsonl` next, `server` later — de-bead is a swap, not a capability deletion.
- **Unblock:** `forge sync` → `SyncBackend.sync()` (no-op); `worktree` drops per-worktree bootstrap
  and `stopDolt` (shared common-dir kernel makes both unnecessary); `setup`/`preflight` ensure the
  kernel instead of `bd init`; `smart-status` reads `forge issue list --json` (with a field-shape
  verification gate).
