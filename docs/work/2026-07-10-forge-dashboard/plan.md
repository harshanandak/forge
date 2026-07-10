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

---

## v2 — Linear-quality multi-view app (2026-07-10, same branch)

Rebuilt the single page into a routed **app shell** after user feedback ("no
single page", "cuts badly", Kanban must scroll independently, epics/tasks were
disconnected).

### Structure
- **App shell**: fixed left sidebar (brand + global search + per-view nav) +
  main area that owns its own scroll. `body { overflow: hidden }` — the page body
  never scrolls horizontally (verified: `scrollWidth <= clientWidth`).
- **Hash router** (dependency-light): `#/overview`, `#/board`, `#/epics`,
  `#/decisions`, `#/plans`, `#/ops`.
- **Refresh**: every view has a Refresh button + "updated <time>" stamp;
  `DataSource.refetch()` re-reads `data.json` (cache-busted) over HTTP, else a
  full reload picks up the regenerated `snapshot.js`. 60s auto-refresh when the
  tab is visible. Real-time push deferred to the sync rail via `subscribe()`.

### Kanban (centerpiece, mandatory)
- Fixed-height board; each column is a flex child with its own `overflow-y:auto`
  (verified: scrolling a column leaves `window.scrollY === 0`).
- **Level toggle**: Tasks (grouped by status Ready/In-progress/Blocked/Done) ⇄
  Epics (grouped by derived health On-track/At-risk/Off-track/Completed). Same
  independent-scroll columns either way.
- Epic↔task tie-in: clicking an epic card focuses the task board to that epic's
  children (filter chip, clearable). Epics also link from the Epics table + search.

### Epics / Initiatives (Linear model)
- Table: Name (icon + title + subtitle, expandable parent→child), Target, Health
  (colored dot from closed/blocked ratio), `done/total` + progress bar, Active
  (in-progress amber / blocked red dots), Activity (recency). Tabs Active /
  Planned / Completed / All. Hierarchy uses kernel `parent_id`.

### New views
- **Decisions & Architecture**: kernel `type=decision` + `forge prime` headline
  PD records + `docs/adr/*.md` + `docs/architecture` list, with status/component/
  rationale.
- **Plans & History**: `docs/work/*` folders on a month-grouped timeline.
- **Live Ops**: `git worktree list`, `gh pr list --json`, and active claims.

### Data (snapshot generator v2)
Extended `generate-snapshot.mjs` to also emit `decisions`, `architecture`,
`plans`, and `ops` (worktrees + PRs + activeClaims). Verified counts: 610 issues,
27 decisions, 3 arch docs, 93 plans, 23 worktrees, 2 PRs, 15 active claims.

### Tests
`app.test.js` extended to cover `epicRollup` + `epicHealth` (7 tests, all pass).

---

## v3 — mono/brutalist reskin + multi-harness Live Ops + live/phase (2026-07-10)

Same v2 structure (multi-view shell, Kanban + toggle, Linear epics, decisions,
plans, refresh). Three refinements:

### 1. Aesthetic → mono / Swiss-brutalist
Full `styles.css` rewrite. Strict black/white/gray (no `--accent` var exists —
verified). Flat: no shadows/gradients/glows, sharp corners, hard 1px rules,
mono-forward type. Grayscale encodings replace all color: priority = fill density
(`rgba(var(--ink), α)`), status/health = glyphs (●/◐/○/✕ + label), selected =
inverted (ink/bg swap). Light + dark both strictly grayscale.

### 2. Live Ops → multi-harness / multi-region
**Data reality:** the kernel lease table (`lib/kernel/lease-enforcer.js`) holds
`session_id`, `worktree_id`, `actor`, `expires_at`, `agent`, but the CLI read
surface exposes only `claimed_by` (actor) — no `forge claims/leases` command,
and `forge board --json` reads the empty Beads projection. So Live Ops renders
what IS real: actor (`claimed_by`) + `git worktree list` + `gh pr list`, and
**infers** a harness `surface` from each worktree path (claude-code / worktree /
t3code / ephemeral / main). Top-line counts (actors · live claims · worktrees ·
PRs) + per-actor breakdown of what each agent is on + worktrees-by-surface + PRs
+ an explicit **seam banner** for session_id/worktree_id/harness/region.

### 3. Live pulse + lifecycle phase
- `isLive(i)` = open + claimed → a pulsing filled square on board cards, epic
  rows ("N live" rollup), overview, Live Ops. Real liveness (lease not expired)
  is the documented seam.
- `lifecyclePhase(i)` = best-effort plan→dev→validate→ship→review→verify from
  status/claim → a 6-cell mono stepper on task cards + epic child rows. Seam:
  no `currentStage` on the kernel issue record yet.

### Data (generator)
`generate-snapshot.mjs` adds `worktrees[].surface` (inferred harness),
`counts.actors`, and a `liveSeam` (exposed vs pending fields).

### Tests
`app.test.js` extended for `isLive` + `lifecyclePhase` + `epicRollup.live`
(10 tests, all pass). In-browser verified: 15 pulse dots, 88 phase steppers,
priority swatches grayscale, no `--accent`, independent column scroll intact,
body has no horizontal scroll.
