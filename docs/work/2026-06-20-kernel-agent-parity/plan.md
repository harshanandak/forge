# Kernel Agent-Parity + Storage Model A — Decisions Record

**Date:** 2026-06-20
**Status:** Decisions locked (design only; implementation tracked separately)
**Context:** Follows #224 (K-DRV — kernel serves all 13 issue ops) and #225 (opt-in selectable kernel backend, `FORGE_ISSUE_BACKEND=kernel`). Captures decisions made while scoping how to make the Forge Kernel a pleasant, agent-friendly issue backend and a portable multi-project store.

This is a **decisions record**, not an implementation plan. It exists so the choices below survive across sessions and contributors. Registry entries are in [docs/PROJECT_DESIGN.md](../../PROJECT_DESIGN.md) (`PD-20260620-*`).

---

## 1. Storage = Model A (per-user home) — *track C, later*

Each project's live kernel DB lives in a dedicated per-user home, **not** in the repo:

```
~/.forge/                          # canonical local home (NEVER pushed)
├─ registry.json                   # every project: id → name, repo path, server link, last-opened
└─ projects/<uuid>/
   ├─ kernel.sqlite                # live authority DB (local, machine-only)
   ├─ config.local.yaml            # personal/machine config
   └─ issues.jsonl                 # projection → the "push to share" source
<repo>/.forge/project.json          # committed: { id:<uuid>, name } — stable identity
<repo>/.forge/config.yaml           # committed: shared/team config (optional)
```

- **Sharing** is via the opt-in **JSONL projection** (text, diff/merge-friendly, committable) — that's the "do I push it or not" knob. The live binary DB is never pushed.
- **Config split:** shared/team config committed in-repo; personal config + live data central and unpushed.
- **Register on first open:** a fresh clone has the committed `.forge/project.json` but no central store → on first `forge` run, create the local store under that UUID and optionally seed it from the committed `issues.jsonl`.

### Why A over the alternatives
- **(B) in-repo `.forge/`** and **(C) today's `.git/forge/`** both force building a central registry anyway just to enumerate projects, and leave the data scattered/buried.
- **A** is the only model that makes a multi-project frontend natural (one canonical home = registry = app data root). Same pattern as Docker Desktop / GitHub Desktop / VS Code workspace storage.

### Today's behavior (contrast)
DB currently lives at `<git-common-dir>/forge/kernel.sqlite` (inside `.git/forge/`), computed in `lib/kernel/broker.js` `buildLocalBrokerConfig`. Because it's inside `.git/`, git never tracks it → structurally un-pushable (good isolation), but no central home and not portable across clones. Per-repo isolation is already sound: per-repo key; worktrees of one repo correctly share one store; concurrency held by WAL + claim-leases + revision CAS. The gap A closes is the **central home + cross-machine portability**.

### Frontend (later, part of C)
A `forge serve` daemon over the **same broker** the CLI uses, backing a localhost web UI or desktop app (Electron/Tauri). Reads `~/.forge/registry.json` to show all projects, per-project settings, issues, structure, dependency graph. Read-only graph views use WAL concurrent reads; edits go through the broker so claim-leases/CAS hold. The UI is the natural place to toggle "share this project" (commit the JSONL projection).

**Status:** track C — needs its own design doc + implementation. Not started.

---

## 2. CLI rendering = agent-first

- **Human formatting SKIPPED.** Usage is agent-mostly (humans ask agents, who read JSON and summarize); the future frontend covers direct visual use. No effort on pretty CLI tables.
- **Make the CLI MORE agent-friendly instead:** preserve the full contract envelope through the CLI, always-on (KAP-1 below).

The contract is already strong for agents: stable `schema_version: "forge.issue.v1"`, per-response `next_commands`, structured errors `{code,message,exit_code,retryable}`, small taxonomy (`epic/task/bug/decision`; statuses `open/in_progress/review/done/cancelled`).

---

## 3. Don't clone Beads wholesale — Kernel Agent-Parity (KAP) backlog

Prioritize the high-leverage, low-effort agent gaps. Formulas, memory, doctor, etc. are deferred. "KAP" is an arbitrary grouping slug (Kernel Agent-Parity), not a project convention.

### Grounded gap analysis (against the code)
- **Gap 1 — CLI flattens the envelope.** `normalizeIssueResult` in `lib/commands/_issue.js` serializes only `result.data`, dropping `next_commands` + `schema_version` before the agent sees them. Agents are required to go through `forge` (not the broker), so they lose runtime next-step guidance. → **KAP-1**.
- **Gap 2 — output projection is thin.** `rowToIssueSummary` (`lib/kernel/sqlite-driver.js`) emits `id,title,body,type,status,rank,revision,blocked,claimed_by,updated_at`. It drops `parent_id`, per-issue `dependencies`, `labels`, the `priority` label (only numeric `rank` shown), `created_at`; `show` returns no comments — all already stored (`schema.js` issues table has `parent_id` + `labels`; `kernel_dependencies` table exists; comments projected to `comments.jsonl`). Projection/contract additions, not new storage. → **KAP-2/3**.
- **Gap 3 — write/query paths.** `buildCreatePayload` accepts `--id/--title/--body/--type/--status/--priority/--priority-rank/--parent`; `buildUpdatePayload` accepts only `--status/--title/--body/--priority/--priority-rank` (no reparent, no `--reason`); `labels` has no write flag; `list` has no server-side filter (returns whole board). → **KAP-4/5/6**.

### Backlog — epic KAP-0 (P1): "Kernel agent-facing parity with Beads"

| ID | P | Title | Primary files |
|----|---|-------|---------------|
| KAP-1 | P1 | Preserve full contract envelope through CLI (next_commands/schema_version) | `lib/commands/_issue.js` `normalizeIssueResult` |
| KAP-2 | P1 | Enrich output projection: parent_id, dependencies[], labels[], priority label, created_at | `sqlite-driver.js` `rowToIssueSummary` + `issue-command-contract.js` `ISSUE_SUMMARY_SCHEMA` |
| KAP-3 | P2 | Include comments in `show` | `sqlite-driver.js` show + contract |
| KAP-4 | P2 | Label write path (`--label` on create/update) | `broker.js` `buildCreatePayload`/`buildUpdatePayload` |
| KAP-5 | P2 | Reparent on update (`--parent`) + `close --reason` | `broker.js` |
| KAP-6 | P2 | Server-side `list` filters (`--status/--type/--label`) | `sqlite-driver.js` list |
| KAP-7 | P1 | Derived queries: blocked / stale / orphans | `sqlite-driver.js` + contract + `_issue.js` |
| KAP-8 | P2 | `close --suggest-next` (newly unblocked) | readiness model (exists) |
| KAP-9 | P3 | Batch close (multiple ids) | `_issue.js` |
| KAP-10 | P3 | Content fields: acceptance / design / notes | (track C) |
| KAP-11 | P3 | Assignee semantics (vs claim lease) | (track C) |
| KAP-12 | P3 | Content validation (`--validate` / lint / required sections) | (track C) |

### Waves & sequencing
- **Wave 1:** KAP-1, KAP-2, KAP-6, KAP-7, KAP-9.
- **Wave 2 (after 1):** KAP-3 (→KAP-2), KAP-4 (↔KAP-2), KAP-5, KAP-8.
- **Wave 3 (under C):** KAP-10, KAP-11, KAP-12.

> **Implementation note:** although Wave 1 is "independent surfaces," the tasks **share files** — `sqlite-driver.js` (KAP-2/6/7), `issue-command-contract.js` (KAP-2/7), `_issue.js` (KAP-1/7/9). Implement **sequentially**, not via parallel worktrees (which would conflict). Recommended order: **KAP-2 (foundation) → 1 → 6 → 7 → 9**.

### Deferred (revisit only if dogfooding demands)
`defer`/snooze, `supersede`, `human`-decision flag, `doctor`/`preflight`, `remember`/`memories`, `formula`/`mol`. Beads `dolt push/pull/sync` is **not** a gap — it's the JSONL-projection model in §1 (track C).

---

## 4. Dogfooding

The KAP backlog is filed **into the kernel itself** (`FORGE_ISSUE_BACKEND=kernel`), so building the agent-parity features also exercises the kernel as the issue tracker.
