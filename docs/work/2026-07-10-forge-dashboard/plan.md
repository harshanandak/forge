# Forge Dashboard — Read-Only Kernel Screen (Phase 1)

Issue: 21cc7139-b088-4e23-a69c-82840e170394 (EPIC: Forge front-end / dashboard — read-only)
Branch: feat/forge-dashboard
Date: 2026-07-10

## Goal

Ship the FIRST working Forge "screen": a self-contained, local, read-only dashboard
that renders a LIVE kernel snapshot (the real 611-issue kernel, not placeholders).
Rail-independent — no live/real-time sync (that waits for the sync rail). This proves
the read layer and the information architecture before any server work.

## Kernel read data (verified 2026-07-10)

Source commands (all `--json` where available):

- `forge issue list --json` → `{ ok, schema_version, command, data: { issues: [...] } }`
  - Per-issue fields: `id, title, body, type, status, priority, rank, revision,
    blocked, claimed_by, parent_id, labels[], dependencies[], dependents[],
    blocked_by[], created_at, updated_at, acceptance_criteria, design, notes,
    assignee, created_by, closed_at, close_reason, metadata`
- `forge status --json` → `{ context: { branch, inWorktree, worktreePath,
  mainWorktree, workingTree }, personal: { activeAssigned[], ready[] }, ... }`
- `forge recall --json` → `[]` (memory currently empty)

### Real distribution (the snapshot renders THIS)

- TOTAL: **611** issues
- status: done 367, open 237, cancelled 7
- type: task 414, bug 110, feature 43, epic 36, decision 6, chore 1, (1 bogus)
- priority: P0 55, P1 190, P2 297, P3 61, P4 8
- actively claimed (open + claimed_by): 15
- blocked: 47 · with-parent: 42 · with-labels: 298 · with-deps: 294
- epics: 36 total, only 5 have children via `parent_id` (linkage is sparse)
- decisions: 6 issues of `type=decision` (no separate `forge decision` command exists)

## Information architecture (summary-first, importance-weighted)

Single page, top-to-bottom by decreasing decision-value:

1. **Health strip (hero)** — the "is the kernel healthy?" glance:
   totals, done %, open, blocked, actively-claimed, ready; priority distribution
   bar; type distribution chips. Big numerals, monospace.
2. **Work Board** — the core operational view. Four columns derived client-side:
   - **Ready** = open, not blocked, not claimed (matches `issue ready`)
   - **In Progress** = open + `claimed_by` set
   - **Blocked** = open + `blocked`
   - **Done** = status done (capped, newest first)
   Cards: type badge, priority badge, title, epic/label chips, owner. Global
   search + type/priority filters. Each column caps rendered cards with "show more"
   (611 issues → never dump the DOM).
3. **Epics** — 36 epics with status/priority and child rollup where present.
4. **Decisions** — the 6 `type=decision` issues with a body excerpt (the "why").
5. **Recent activity + memory** — recently-updated issues as a timeline; a memory
   panel that reads `recall` (graceful empty-state today).

## Build

Zero-build vanilla SPA under `web/dashboard/`:

- `index.html` — structure + section landmarks
- `styles.css` — design system (tokens, light/dark, responsive)
- `app.js` — render + filter/search + `DataSource` seam
- `snapshot.js` — generated `window.FORGE_SNAPSHOT = {...}` (opens via double-click,
  no server, no fetch/CORS)
- `data.json` — same snapshot as machine-readable JSON (for tooling / future fetch)
- `generate-snapshot.mjs` — Node generator: shells `forge issue list/status --json`,
  writes `snapshot.js` + `data.json`
- `README.md` — regenerate + open steps

Aesthetic: foundry/kernel theme — neutral zinc surfaces, single ember accent,
monospace for numerals + IDs, refined not generic. Light + dark (prefers-color-scheme
+ toggle). Responsive down to mobile.

## Deferred: live view (propose, do not build)

A clear `DataSource` seam in `app.js` (a single async `load()` today reading the
baked snapshot). The sync-rail outbox feed will later push real-time deltas here.

Proposed live stack (for orchestrator to confirm):

- **Option A (near-term, local):** a tiny local server (`node`/Bun) that shells
  `forge --json` on an interval or on-demand and serves `data.json` + a
  `/events` SSE endpoint fed by the sync-rail outbox. Dashboard swaps its
  `DataSource` from baked-snapshot to `fetch('/data.json')` + `EventSource('/events')`.
  Lowest lift; reuses the exact CLI contract this snapshot already consumes.
- **Option B (Phase-2, server authority):** when the kernel gains serialized
  server authority (per PD-20260606-sqlite-local-authority), expose a read API on
  that server and subscribe to its outbox directly. Multi-machine/team-safe.

Recommendation: ship A behind the same `DataSource` interface now-ish; graduate to
B when the Phase-2 kernel server lands. No dashboard rewrite either way.
