# Forge Dashboard (read-only)

A self-contained, zero-build **multi-view** app that renders a **live kernel
snapshot** — a Linear-style work board, epic hierarchy, decisions, plans, and
live ops — from the real kernel (610 issues at time of writing). No framework,
no build step, no external assets. This is the **rail-independent read layer**;
real-time push is deferred to the sync rail (see the seam below).

## Run it (two steps)

```sh
# 1. Bake a fresh snapshot from the live kernel
node web/dashboard/generate-snapshot.mjs

# 2. Open the dashboard — just double-click it, no server needed
#    Windows:  start web/dashboard/index.html
#    macOS:    open web/dashboard/index.html
#    Linux:    xdg-open web/dashboard/index.html
```

The snapshot is baked into `snapshot.js` as a browser global, so `index.html`
works directly from `file://` — no local server, no CORS.

*(Optional)* Serve over HTTP so the in-app **Refresh** button can re-fetch
`data.json` without a full reload:

```sh
cd web/dashboard && python -m http.server 8080   # → http://localhost:8080
```

## Views (sidebar nav, hash-routed)

| Route | View | Source | Notes |
|-------|------|--------|-------|
| `#/overview` | **Overview** | issues + counts | health tiles, priority/type distribution, recent activity, ops summary |
| `#/board` | **Work Board (Kanban)** | issues + epics | independent-scroll columns; **Tasks ⇄ Epics level toggle**; click an epic card to drill the task board to it |
| `#/epics` | **Epics / Initiatives** | epics + `parent_id` children | Linear-style table, expandable hierarchy, Health (on/at-risk/off-track), `done/total`, Active/Planned/Completed/All tabs |
| `#/decisions` | **Decisions & Architecture** | kernel `type=decision` + `forge prime` headline PDs + `docs/adr` + `docs/architecture` | ADR board with status/component/rationale |
| `#/plans` | **Plans & History** | `docs/work/*` | timeline of work folders grouped by month, plan/tasks/decisions tags |
| `#/ops` | **Live Ops** | `git worktree list` + `gh pr list` + active claims | running agents (claims), open PRs, worktrees |

Global **search** (top of sidebar, `/` to focus) spans issues + epics + decisions.
Every view has a **Refresh** button and an "updated <time>" stamp; a 60s
auto-refresh re-reads the snapshot when the page is served over HTTP.

## Files

- `index.html` — app shell (sidebar + topbar + routed view container)
- `styles.css` — design system (tokens, light/dark, independent-scroll Kanban, tables)
- `app.js` — hash router, six views, refresh, global search, board toggle, `DataSource` seam
- `generate-snapshot.mjs` — Node generator; shells `forge` + `git` + `gh`
- `snapshot.js` — **generated** `window.FORGE_SNAPSHOT` global (gitignored)
- `data.json` — **generated** same payload, machine-readable (gitignored)
- `app.test.js` — unit tests for the pure board/epic/filter logic

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
