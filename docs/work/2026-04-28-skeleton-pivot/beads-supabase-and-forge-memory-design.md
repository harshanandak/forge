# Beads "Supabase" Question + Forge Memory Design

- **Date**: 2026-04-29
- **Status**: Research + Design Proposal
- **Owners**: skeleton-pivot
- **Companions**: [`locked-decisions.md`](./locked-decisions.md), [`n1-moat-technical-deep-dive.md`](./n1-moat-technical-deep-dive.md), [`../2026-04-26-project-memory/design.md`](../2026-04-26-project-memory/design.md)

---

## TL;DR

1. **The "Supabase migration" premise is incorrect.** Beads has never migrated to Supabase. The repository moved namespace (`steveyegge/beads` → `gastownhall/beads`, see CHANGELOG `[1.0.2]` 2026-04-15), and the storage backend went **SQLite → Dolt**, not Postgres/Supabase. Searching the canonical repo for `supabase` returns zero relevant issues.
2. **The actual recent breaking change** is the v0.51 Dolt-native cleanup ([CHANGELOG `[0.51.0]` 2026-02-16](https://github.com/gastownhall/beads/blob/main/CHANGELOG.md)) plus v0.55-era removals: SQLite backend deleted, JSONL sync pipeline deleted, embedded Dolt mode removed (now requires running `dolt sql-server`). Forge already runs in `dolt_mode: server` per `.beads/metadata.json`, so we are on the supported path.
3. **Forge Memory already exists** as a *complement* to Beads (see [`docs/work/2026-04-26-project-memory/design.md`](../2026-04-26-project-memory/design.md), status: Implemented at `lib/project-memory.js`). It is not a Beads replacement — it stores agent-agnostic durable context, keyed and upserted in `.forge/memory/entries.jsonl`.
4. **Recommendation**: **Coexist**, not replace. Harden the Beads/Dolt adapter (already a locked Wave-1 deliverable in `n1-moat-technical-deep-dive.md`) and extend Forge Memory to optionally adapt issue ops behind a thin interface for users who refuse the Dolt dependency.

---

## Question 1 — Beads' actual recent migration history

### What actually happened

Verified from the canonical `gastownhall/beads` CHANGELOG.md (URL: https://raw.githubusercontent.com/gastownhall/beads/main/CHANGELOG.md):

| Version | Date | Change |
|---|---|---|
| `0.50.0` | 2026-02-14 | Default backend flips from SQLite to **Dolt**. Existing projects honored. |
| `0.51.0` | 2026-02-16 | 8-phase "Dolt-native cleanup": removes daemon, 3-way merge, tombstones, JSONL sync, **SQLite backend entirely**, storage factory/memory backend/provider abstraction. ~30k LOC deleted. |
| `~0.55+` | 2026-03 | "Embedded Dolt mode" removed; `dolthub/driver` and CGO bifurcation gone. Binary 168 MB → ~41 MB. Now requires running `dolt sql-server`. |
| `1.0.0` | 2026-04-15 | Repo move `steveyegge/beads` → `gastownhall/beads`. Stale npm `repository.url` caused npm publish E422 sigstore failures (fixed in `1.0.2`). |
| `1.0.3` | 2026-04-24 | `go install ...@latest` restored; Windows install cleanup; macOS npm archive layout fixed. |
| `[Unreleased]` | now | `bd init --reinit-local` / `--discard-remote` named-intent flags replace overloaded `--force` (after a documented incident where an AI agent destroyed 247 issues by pattern-matching on the tool's own error output, commit `58f5989b`). New stable exit codes 10/11/12 for init refusals. |

**There is no Postgres, Supabase, or hosted-database migration.** The "migration" the user is concerned about is the Dolt cutover, which Forge has already been on for months.

### Pain points actually reported (canonical issues, last 30 days)

From `https://github.com/gastownhall/beads/issues?q=...`:

- [#3586](https://github.com/gastownhall/beads/issues/3586) — `bd dep/link/dep-rm` deadlock for ~5 min in contributor mode when both IDs route to the planning repo.
- [#3585](https://github.com/gastownhall/beads/issues/3585) — `bd init --reinit-local` reports `Mode: embedded` while active store is server-mode.
- [#3582](https://github.com/gastownhall/beads/issues/3582) — Sandboxed agents (Claude Code/bwrap on Linux) cannot reach a host-level shared dolt server.
- [#3575](https://github.com/gastownhall/beads/issues/3575) — Race condition in `bd ready` / `bd update --claim` allowing simultaneous claims (already merged, see commit `7bd46ea`).
- Forge's own `.beads/dolt-server.lock` / `.beads/dolt-server.pid` artefacts in `git status` indicate we hit the same server-lifecycle category.

These are real but small-surface bugs in the Dolt server lifecycle, init safety, and worktree routing — not architectural breakage.

### Recoverability — three options

**A. Pin to pre-Dolt Beads.** Last SQLite-only build is roughly `0.49.x` (before `0.51.0` Phase 6 deletion). Doable via `go install github.com/steveyegge/beads/cmd/bd@v0.49.0` *if* the old import path still resolves. Cost: lose ~6 months of fixes (hash IDs, batch ops, init safety, race fixes), no further upstream fixes will land. **Not recommended.**

**B. Wait for upstream fix.** Most pain points have open PRs or merged fixes within the last week (e.g. `#3578` atomic ready/claim fix, the `--reinit-local` ADR). Cost: 0; benefit: high. **Recommended for the immediate term.**

**C. Migrate off Beads to Forge Memory's issue adapter.** Cost: 3–4 weeks of work to build feature parity (graph deps, ready-work computation, hash IDs, JSONL/Dolt sync). Risk: huge. Benefit: removes Dolt server dependency on machines that can't run it (sandboxed Linux agents per #3582). **Only justified if #3582 stays unfixed for >60 days.**

**Verdict:** the situation is fully recoverable. Stay on Beads, take upstream fixes as they land, build a thin Forge Memory adapter so we *could* swap if upstream stalls — but do not pre-emptively replace.

---

## Question 2 — How Forge Memory works (and why it is not a Beads replacement today)

### What Forge Memory is, per the implemented design

Source: `docs/work/2026-04-26-project-memory/design.md` (status: **Implemented**), `lib/project-memory.js`.

- Storage: `.forge/memory/entries.jsonl` (one upsertable entry per line, keyed by `key`).
- Schema: `{ key, value, source-agent, timestamp, tags, scope?, confidence?, supersedes?, beads-refs? }`.
- API: `read / write / search / list` — pure file IO, no SQLite, no FTS5 yet, no MCP server.
- Purpose: **durable cross-session context** (decisions, preferences, policies, repeated troubleshooting notes). NOT issue lifecycle.

### What Forge Memory deliberately is NOT (from the design doc)

> *"This complements Beads issue tracking. Beads remains the source of truth for issue lifecycle, workflow stages, ownership, dependencies, and task status."*

So the original design picked **coexist**, not replace. There is no D26 or D31 in `locked-decisions.md` — those numbers were assumed in the prompt but the file currently ends at D20.

### Proposed extension — Forge Memory as an optional issue adapter

If we want the "swap-out path" the n1-moat doc gestures at (kill criterion: "drop hosted Dolt, fall back to JSONL+git-only"), here is the concrete shape.

**Files (additive):**

```text
.forge/memory/
  entries.jsonl     # already exists — durable KV memory
  issues.jsonl      # NEW — append-only issue events (mode=adapter only)
  deps.jsonl        # NEW — append-only dependency edges (mode=adapter only)
  index.sqlite      # NEW — derived FTS5 index, regenerable from JSONL
.forge/config.yaml
  memory:
    issue-adapter: beads | forge-memory     # default: beads
```

**`.forge/memory/issues.jsonl` — 5 example entries (event-sourced):**

```jsonl
{"op":"create","id":"fm-a1b2","ts":"2026-04-29T10:00:00Z","actor":"harsha","title":"Wire forge-memory adapter","type":"feature","priority":1,"status":"open","tags":["adapter"]}
{"op":"update","id":"fm-a1b2","ts":"2026-04-29T10:05:00Z","actor":"harsha","fields":{"status":"in_progress","assignee":"harsha"}}
{"op":"comment","id":"fm-a1b2","ts":"2026-04-29T11:00:00Z","actor":"claude","body":"RED tests landed in commit abc123."}
{"op":"close","id":"fm-a1b2","ts":"2026-04-29T15:00:00Z","actor":"harsha","fields":{"status":"closed","resolution":"completed"}}
{"op":"create","id":"fm-c3d4","ts":"2026-04-29T15:30:00Z","actor":"harsha","title":"Doc adapter","type":"docs","priority":2,"status":"open","parent":"fm-a1b2"}
```

**`.forge/memory/deps.jsonl` — 3 examples:**

```jsonl
{"op":"add","from":"fm-c3d4","to":"fm-a1b2","kind":"blocks","ts":"2026-04-29T15:30:00Z","actor":"harsha"}
{"op":"add","from":"fm-e5f6","to":"fm-a1b2","kind":"relates_to","ts":"2026-04-29T16:00:00Z","actor":"harsha"}
{"op":"remove","from":"fm-c3d4","to":"fm-a1b2","kind":"blocks","ts":"2026-04-29T18:00:00Z","actor":"claude"}
```

**SQLite/FTS5 index (regenerable, never source of truth):**

```sql
CREATE TABLE issues (id TEXT PRIMARY KEY, title TEXT, status TEXT,
  type TEXT, priority INT, parent TEXT, assignee TEXT,
  created_at TEXT, updated_at TEXT, closed_at TEXT, json TEXT);
CREATE TABLE deps (from_id TEXT, to_id TEXT, kind TEXT,
  PRIMARY KEY(from_id, to_id, kind));
CREATE VIRTUAL TABLE issues_fts USING fts5(id UNINDEXED, title, body, tags);
CREATE INDEX idx_issues_status_priority ON issues(status, priority);
```

### Operations (adapter mode)

| Command | Files touched | Index update |
|---|---|---|
| `forge issue create "Title" --type=task` | append `create` op to `issues.jsonl` | INSERT into `issues`, `issues_fts` |
| `forge issue list --status=open` | none | `SELECT id,title FROM issues WHERE status='open' ORDER BY priority` |
| `forge issue close abc123` | append `close` op | UPDATE row, set `closed_at` |
| `forge issue dep add A B` | append to `deps.jsonl` | INSERT into `deps` |
| `forge sync` (cross-machine) | `git pull origin <branch>` → JSONL is the merge surface; rebuild SQLite from JSONL on first read if mtime newer than DB | full rebuild ≈ O(events); on a 228-issue repo, ~1-2 s |

Cross-machine merge: JSONL is append-only, so two machines appending different events just produces a sorted union. Conflicts only happen when the same `id` gets two simultaneous `update` ops with overlapping fields — resolve by `ts` then `actor` lexicographic (deterministic).

### Migration `forge migrate-from-beads`

```text
bd export jsonl > /tmp/beads-export.jsonl
forge migrate-from-beads --input /tmp/beads-export.jsonl
  → for each Beads issue:
      emit one synthetic {"op":"create",...} to .forge/memory/issues.jsonl
      emit one {"op":"update",...} per status transition recorded in audit
      emit deps to .forge/memory/deps.jsonl
  → preserve: id (rewrite bd-* → fm-*), title, status, priority, type, parent,
              dependencies, comments (as op=comment events), tags
  → lose: Dolt branch history, three-way merge metadata, schema version chain
  → produce .forge/memory/migration-report.md with mapping table
```

Reversibility: keep the original `bd export` JSONL alongside `migration-report.md`. To revert, run `bd init` + `bd import < .forge/memory/migration-report-source.jsonl`. Two-way reversibility for at least one release after migration.

### Beads-as-adapter abstraction

```js
// lib/issue-adapter.js (proposed)
interface IssueAdapter {
  create(input): Promise<Issue>          // forge issue create
  update(id, fields): Promise<Issue>     // forge update / forge claim
  list(filter): Promise<Issue[]>         // forge issue list
  close(id, resolution): Promise<void>   // forge close
  ready(): Promise<Issue[]>              // forge ready (deps-aware)
  depAdd(fromId, toId, kind): Promise<void>
  sync(): Promise<{pulled:n, pushed:n}>  // forge sync
}
// implementations:
//   lib/adapters/beads.js          — shells out to `bd` (today's behavior)
//   lib/adapters/forge-memory.js   — JSONL + SQLite (proposed)
```

Features that lose fidelity in `forge-memory` adapter mode:

- Cell-level merge of conflicting field updates (Dolt does this natively; we get last-write-wins by `ts`).
- Branch-scoped issue history (each git branch has the same issues).
- `bd compact` semantic decay.
- Hash-ID birthday-paradox guarantees (forge-memory uses `nanoid(6)`).
- Federation across multiple repositories.

---

## Beads + Dolt today vs Forge Memory tomorrow

| Axis | Beads + Dolt (current) | Forge Memory adapter (proposed) |
|---|---|---|
| Dependencies | Go binary `bd`, running `dolt sql-server`, `.beads/embeddeddolt/` | Bun + `better-sqlite3` (already installed) |
| Disk footprint | ~41 MB binary + Dolt data | <2 MB index + JSONL |
| Cross-machine sync | `bd dolt pull && bd dolt push` over Dolt remote | `git pull && git push` (JSONL) |
| Issue features | full graph + branches + compaction + federation | basic graph + ready-work + FTS |
| Failure modes (verified) | server crash, port exhaustion, 3-way merge, JSONL/Dolt drift, init-safety footguns | append-only file race (mitigable with file lock), SQLite rebuild time |
| Latency budget | local push 200–800 ms, remote 1–4 s | local write <10 ms, remote = git push time |
| Lock-in risk | if upstream stalls or repo moves again, we're stuck | own format, exportable to anything |
| Maintenance burden for Forge | thin shell wrapper (`scripts/beads-context.sh`, 553 LOC) | full implementation: ~2k LOC + tests |

---

## Decision proposal: COEXIST (do not replace)

1. **Keep Beads + Dolt as the L2 default issue adapter.** Already in `n1-moat-technical-deep-dive.md` Wave-1 hardening (400 LOC new, 600 LOC tests).
2. **Promote `lib/project-memory.js` to first-class L1.** Already implemented; enforce that every stage handoff writes one decision/policy entry.
3. **Add `forge-memory` issue adapter as opt-in escape hatch.** Build to satisfy the kill criterion in n1-moat: "B2 p95 > 8 s after optimization → drop hosted Dolt, fall back to JSONL+git-only." Do not enable by default.
4. **Add a new locked decision D21 — "Issue tracking abstraction".** Forge ships an `IssueAdapter` interface; Beads is the default; Forge-memory is the fallback. Records this commitment so the work can be deferred without losing intent.

### Migration timeline

- **Now (v3 Wave 1, weeks 1–4):** Ship `lib/issue-adapter.js` interface; Beads stays as default impl.
- **Wave 2 (weeks 5–8):** Build `forge-memory` adapter behind a feature flag. Smoke-test on test-env fixtures only.
- **Wave 3 (weeks 9–11):** Run two-machine convergence benchmark (B5 in n1-moat) on both adapters. Document results.
- **Wave 4 (weeks 12–14):** Promote forge-memory adapter to opt-in production for new projects on platforms where Dolt is unavailable (mainly sandboxed Linux per [#3582](https://github.com/gastownhall/beads/issues/3582)).

### Three risks + mitigations

1. **Dependency graph correctness regression.** Beads' `bd ready` accounts for transitive blockers, custom statuses, and message-type non-blocking edges. Mitigation: port the SQL recursive-CTE query verbatim into `lib/adapters/forge-memory/ready.js` and run a property-based test that compares output against `bd ready` on the Forge repo's own 228-issue history for ~1 month.
2. **JSONL append race on simultaneous writes.** Two agents on one machine can interleave bytes. Mitigation: use `proper-lockfile` (already a transitive dep) on `.forge/memory/issues.jsonl` plus an fsync after each append; benchmark <5 ms p99.
3. **Schema drift between adapters.** Beads issues have fields forge-memory doesn't (e.g., `wisp`, `mol_state`, `external_ref`). Mitigation: namespace foreign fields under `extensions: {beads: {...}}` in JSONL; preserve on round-trip even though forge-memory won't read them.

### One surprise about what is actually hard

**Cross-branch consistency, not storage.** The naive view is "swap Dolt for SQLite + JSONL and we're done." The hard part is that Beads with Dolt gives you *branch-isolated* issue state — each git branch can have a different DB state, and `bd dolt pull` merges them. Forge users actively rely on this for worktrees (`.beads/redirect`, per-worktree state). A flat JSONL on the main branch loses this. The forge-memory adapter must either (a) accept that worktrees share state and document the regression loudly, or (b) implement per-branch JSONL files plus a merge tool — which re-invents most of Dolt for issues. Plan to ship (a) and only escalate to (b) if user pain emerges.

---

## Open question for the user (single decision needed)

**Do we want issue-tracking adapter abstraction in Wave 1 (parallel with `forge-core` extraction), or deferred to Wave 4 behind a feature flag?**

- **Wave 1**: ~2 extra weeks, locks in the abstraction before extension authors bind to Beads-specific behavior, but slows the v3 critical path.
- **Wave 4**: zero impact on v3 ship date, but extension API may accidentally leak `bd`-specific concepts that we then have to deprecate.

Recommendation: **Wave 4 with a Wave-1 interface placeholder** — define `IssueAdapter` types in `lib/core/` during the contract extraction (N2), but only ship Beads as an implementation until Wave 4. This commits to the abstraction without paying the implementation cost up-front.
