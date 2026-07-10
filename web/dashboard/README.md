# Forge Dashboard (read-only)

A self-contained, zero-build **multi-view** app that renders a **live kernel
snapshot** — a work board, epic hierarchy, decisions, plans, and multi-harness
live ops — from the real kernel (611 issues at time of writing). No framework,
no build step, no external assets. This is the **rail-independent read layer**;
real-time push is deferred to the sync rail (see the seam below).

**Aesthetic:** mono / Swiss-brutalist. A strict three-value palette — black,
white, gray, no hue. Flat (no shadows/gradients/glows), sharp corners, hard 1px
rules, mono-forward type. Everything normally carried by color is encoded in
**grayscale**: priority = fill density, status/health = glyphs (●/◐/○/✕),
a **live claim** = a pulsing filled square, lifecycle phase = a 6-cell stepper.
**Dark is the default**; light is a toggle (sidebar foot) — both strictly
black/white/gray.

## Run it (two steps)

```sh
# 1. Bake a fresh snapshot from the live kernel
node web/dashboard/generate-snapshot.mjs

# 2. Open the dashboard — just double-click it, no server needed
#    Windows:  start web/dashboard/index.html
#    macOS:    open web/dashboard/index.html
#    Linux:    xdg-open web/dashboard/index.html
```

The snapshot is baked into `snapshot.js` (kernel data) and `docs.js`
(work-folder markdown for the in-render reader) as browser globals, so
`index.html` works directly from `file://` — no local server, no CORS.

*(Optional)* Serve over HTTP so the in-app **Refresh** button can re-fetch
`data.json` without a full reload:

```sh
cd web/dashboard && python -m http.server 8080   # → http://localhost:8080
```

## Views (sidebar nav, hash-routed)

| Route | View | Source | Notes |
|-------|------|--------|-------|
| `#/overview` | **Overview** | issues + counts | health tiles, priority/type distribution, recent activity, ops summary |
| `#/board` | **Work Board (Kanban)** | issues + epics | independent-scroll columns **Backlog → Ready → In progress** (+ **Done / Cancelled** via a show/hide toggle, no separate archive view); **Epics ⇄ Tasks level toggle** (epics first); **multi-select filter chips** (OR within a facet, AND across, with visible selected state); an epic card opens its **detail**, its `filter ↳` button drills the board to it |
| `#/epics` | **Epics / Initiatives** | epics + `parent_id` children | Linear-style table, expandable hierarchy, Health (on/at-risk/off-track), `done/total`, Active/Planned/Completed/All tabs |
| `#/decisions` | **Decisions & Architecture** | kernel `type=decision` + `forge prime` headline PDs + `docs/adr` + `docs/architecture` | **graphical status board** (Proposed / Accepted / Superseded / Deprecated) with source-tagged cards → click for detail; architecture index; relationship edges = SEAM (`56461780`) |
| `#/plans` | **Plans & History** | `docs/work/*` (+ baked markdown) | timeline of work folders grouped by month; **click a folder to read its markdown in-render** (heading/list/code, tab per `.md`) — for terminal users who can't open `.md` files |
| `#/workspaces` | **Workspaces** | `git worktree list` (+ahead/behind/dirty) + PR/CI match | worktree = card: branch · surface chip · real git ahead/behind/dirty · **"working on"** (its PR/branch) · CI; Active/Merged filter; linked-issue/phase/harness = SEAM |
| `#/memory` | **Memory** | `docs/work/*` (+ baked markdown) + recall | work-folder **card grid** (click to read in-render) with filter; recall buffer (empty → SEAM); Graphiti temporal-graph = SEAM |
| `#/backlog` | **Backlog** | kernel backlog state (pending) | honest SEAM — parked ideas render once `b2f856b1` lands |
| `#/ops` | **Live Ops (multi-harness)** | kernel `claimed_by` + `git worktree list` + `gh pr list` | top-line counts (actors · live claims · worktrees · PRs); per-actor breakdown of what each agent is working on (with live pulse); worktrees grouped by inferred **surface** (Claude Code / worktree / t3code / ephemeral / main); open PRs |

**Overview → Needs-Attention lane** (v4): a ranked control-surface at the top —
ready-to-merge PRs, failing CI, merge conflicts, unresolved review threads (from
`gh` CI/mergeable + GraphQL threads), each with a deep-link; stale-claims is a SEAM
until the lease-read (`7dc229d4`). **Click-through detail** (v4): clicking any epic /
task / child card opens a summary-first slide-over (meta + body + children-as-cards);
per-issue PR/decision/plan links are a SEAM (`56461780`).

### Live indicators & seams

- **Live pulse** — a pulsing filled square marks any open+claimed issue (an agent
  working it now). Shown on board cards, epic rows (rolled up as "N live"), the
  overview, and Live Ops. Best-effort: real liveness needs the lease `expires_at`.
- **Lifecycle phase** — a 6-cell stepper (plan → dev → validate → ship → review →
  verify) per task, derived from the only real signals the kernel exposes: a
  `done` issue is **shipped** (past ship); a claimed-open issue is **in progress**
  with the remaining cells drawn **dashed = unknown** rather than asserting "dev".
  **Seam:** the kernel issue record has no `currentStage` field yet (`a2279f65`).
- **Multi-harness seam** — the kernel lease table holds `session_id`,
  `worktree_id`, `actor`, `expires_at`, but the CLI read surface exposes only
  `claimed_by` (actor). So Live Ops renders actor + worktree + PRs and **infers**
  the harness/surface from the worktree path. The real harness + region tag
  arrives with the sync-rail / Phase-2 lease read.

Global **search** (top of sidebar, `/` to focus) spans issues + epics + decisions.
Every view has a **Refresh** button and an "updated <time>" stamp; a 60s
auto-refresh re-reads the snapshot when the page is served over HTTP.

## Files

- `index.html` — app shell (sidebar + topbar + routed view container + detail overlay)
- `styles.css` — design system (tokens, dark-default/light, independent-scroll Kanban, tables, markdown reader)
- `app.js` — hash router, nine views, in-render markdown reader, click-through detail, refresh, global search, `DataSource` seam
- `generate-snapshot.mjs` — Node generator; shells `forge` + `git` + `gh`; also bakes work-folder markdown
- `snapshot.js` — **generated** `window.FORGE_SNAPSHOT` global (gitignored)
- `docs.js` — **generated** `window.FORGE_DOCS` work-folder markdown, capped per file (gitignored)
- `data.json` — **generated** same snapshot payload, machine-readable (gitignored)
- `app.test.js` — unit tests for the pure board/epic/**filter**/markdown logic

## Live view — deferred (the seam)

`app.js` reads all data through a single `DataSource`. Today `load()` returns the
baked snapshot and `refetch()` re-reads `data.json` (Refresh / auto-refresh).
When the **sync rail** lands, implement `subscribe(onDelta)` over the outbox feed
(`EventSource('/events')`) — the views update with **no render changes**.

Proposed live stack (for orchestrator to confirm — see
`docs/work/2026-07-10-forge-dashboard/plan.md`):

- **Option A (near-term):** a tiny local Node/Bun server shells `forge --json` and
  serves `data.json` + an SSE `/events` endpoint fed by the sync-rail outbox.
- **Option B (Phase-2):** a read API on the serialized kernel server (per
  `PD-20260606-sqlite-local-authority`); team/multi-machine safe.

Ship A behind the existing `DataSource` interface; graduate to B with no rewrite.
