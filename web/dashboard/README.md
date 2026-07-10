# Forge Dashboard (read-only, Phase 1)

The first Forge "screen": a self-contained, local dashboard that renders a **live
kernel snapshot** — work board, epics, decisions, health and recent activity — from
the real kernel (611 issues at time of writing). No framework, no build step, no
external assets. This is the **rail-independent read layer**; live/real-time sync is
deferred to the sync rail (see the seam below).

## Run it (two steps)

```sh
# 1. Bake a fresh snapshot from the live kernel
node web/dashboard/generate-snapshot.mjs

# 2. Open the dashboard — just double-click it, no server needed
#    Windows:
start web/dashboard/index.html
#    macOS:   open web/dashboard/index.html
#    Linux:   xdg-open web/dashboard/index.html
```

The snapshot is baked into `snapshot.js` as a browser global, so `index.html` works
directly from `file://` — no local server, no CORS.

*(Optional)* To serve over HTTP instead (uses `data.json` via `fetch`):

```sh
cd web/dashboard && python -m http.server 8080   # → http://localhost:8080
```

## What it shows (all real kernel data)

| View | Source | Notes |
|------|--------|-------|
| **Health** | derived from `issue list` | totals, % complete, open/ready/in-progress/blocked, priority + type distribution |
| **Work board** | `issue list` | Ready / In progress / Blocked / Done, derived per-issue; search + type/priority filters; capped render with "show more" |
| **Epics** | `type=epic` (36) | status, priority, child rollup where `parent_id` linkage exists |
| **Decisions** | `type=decision` (6) | title + body excerpt (the "why") |
| **Activity + memory** | recent `updated_at` + `recall` | timeline of recent changes; memory panel (empty-state until `recall` returns entries) |

## Files

- `index.html` — structure and section landmarks
- `styles.css` — design system (tokens, light/dark, responsive)
- `app.js` — render + filter/search + the `DataSource` live-view seam
- `generate-snapshot.mjs` — Node generator; shells `forge issue list/status/recall --json`
- `snapshot.js` — **generated** `window.FORGE_SNAPSHOT` global (git-ignorable)
- `data.json` — **generated** same payload, machine-readable

## Live view — deferred (the seam)

`app.js` reads all data through a single `DataSource` object. Today `load()` returns
the baked snapshot. When the **sync rail** lands, swap `load()` to `fetch('data.json')`
and implement `subscribe(onDelta)` over the outbox feed (`EventSource('/events')`) —
**no render code changes**.

Proposed live stack (for orchestrator to confirm — see `docs/work/2026-07-10-forge-dashboard/plan.md`):

- **Option A (near-term):** tiny local Node/Bun server shells `forge --json` and serves
  `data.json` + an SSE `/events` endpoint fed by the sync-rail outbox. Lowest lift.
- **Option B (Phase-2):** read API on the serialized kernel server (per
  `PD-20260606-sqlite-local-authority`); team/multi-machine safe.

Ship A behind the existing `DataSource` interface; graduate to B with no rewrite.
