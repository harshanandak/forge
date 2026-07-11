# Forge Dashboard (read-only)

A self-contained, zero-build **multi-view** app that renders a **live kernel
snapshot** — a work board, epic hierarchy, decisions, plans, and multi-harness
live ops — from the real kernel (611 issues at time of writing). No framework,
no build step, no external assets. This is the **rail-independent read layer**;
real-time push is deferred to the sync rail (see the seam below).

**Aesthetic:** mono / Swiss-brutalist. A strict three-value palette — black,
white, gray, no hue. Flat (no shadows/gradients/glows), sharp corners, hard 1px
rules. **Two-tier type** (v6): sans for titles/body, mono reserved for data (ids,
counts, branches, timestamps, priority); one caps-tracked tier survives (section
labels). Everything normally carried by color is encoded in **grayscale**:
status/health = glyphs (●/◐/○/✕), a **live claim** = a pulsing filled square,
priority = a small `P0`–`P4` label, the lifecycle phase = a 6-cell stepper (in the
detail hub). **Dark is the default**; light is a toggle — both strictly grayscale.

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
| `#/board` | **Work Board** | issues + epics | **status is the only axis** — a persisted **Kanban ⇄ Table** toggle: *Kanban* = independent-scroll columns **Backlog → Ready → In progress** (+ **Done / Cancelled** via show/hide) with **epics as grouping headers** inside each column; *Table* = the same items as a list, **rows grouped by collapsible epic** with columns Title · Status · Priority · Owner · Live · PR (status = sort geometry). Blocked items stay visible with a ✕ glyph (blocked ≠ backlog). One filter bar (multi-select, OR-within/AND-across, visible selected state) + `#/board?epic=:id` focus drive both views |
| `#/epics` | **Epics / Initiatives** | epics + `parent_id` children | Linear-style table, expandable hierarchy, Health (on/at-risk/off-track), `done/total`, Active/Planned/Completed/All tabs |
| `#/architecture` | **Architecture** | kernel `type=decision` + `forge prime` headline PDs + `docs/adr` + `docs/architecture` | decisions grouped into **architecture areas as folder-nodes** (from the dotted `component`, e.g. `authority.*` → *authority*); open an area → its decisions (status glyph + source/component tags), click one → its detail + a **thread** of related decisions in the same area; architecture-docs index. Supersede/relates/conflicts edges = SEAM (`56461780`) |
| `#/plans` | **Plans & History** | `docs/work/*` (+ baked markdown) | timeline of work folders grouped by month; **click a folder to read its markdown in-render** (heading/list/code, tab per `.md`) — for terminal users who can't open `.md` files |
| `#/workspaces` | **Workspaces** | `git worktree list` (+ahead/behind/dirty) + PR/CI match | worktree = card: branch · surface chip · real git ahead/behind/dirty · **"working on"** (its PR/branch) · CI; Active/Merged filter; linked-issue/phase/harness = SEAM |
| `#/memory` | **Memory** | decisions + recall (`.remember`) | ONE **reverse-chronological Memory Stream** — typed entries (glyph · text · timestamp · provenance chips: area/source/status), banded (dated → undated). Click an entry → its **thread** (related decisions in the area). A pinned **Canon** rail (accepted-decisions count + architecture docs). `forge recall` (empty) + user-global `.remember` rotation are honest **SEAMs** (the latter is deliberately not baked — cross-project leak; needs a slug-scoped ingestor). No empty graph pane |
| `#/backlog` | **Backlog** | kernel backlog state (pending) | honest SEAM — parked ideas render once `b2f856b1` lands |
| `#/ops` | **Now** | kernel `claimed_by` + `git worktree list` + `gh pr list` | ONE joined list of the **active threads of work** — one row per live claim (`pulse · agent · issue title → branch · PR · age`); a one-sentence header (`N agents active · M open PRs · K needs you`); quiet secondary lists (open PRs, worktrees). Branch/PR↔issue joins = SEAM (`56461780`) |

**Every entity is a URL** (v6): `#/issue/:id`, `#/epic/:id`, `#/decision/:id`,
`#/work/:slug`, `#/board?epic=:id`. The detail overlay is **route-driven** — opening
sets the hash, browser **Back** closes it, and any entity is deep-linkable/shareable.
Any text naming an entity is that entity's link; a topbar **breadcrumb** shows the
path (e.g. `Epic › Task`). The **issue/epic detail is the hub**: it renders every
link slot (parent epic, children, PR, worktree, work folder, files, comments) even
when SEAM-tagged, so the graph shape is always visible (fills in as `56461780` lands).

**One card, everywhere** (v6): a single card component (status-or-pulse · title ·
owner — a strict 3-item budget) is shared by the board, epic grids, memory, and
search; epics add the same progress bar + `done/total` fraction used in the detail.
Phase stepper, type badge, and id live in the detail, not on cards.

**Overview → Needs-Attention lane**: a ranked control-surface — ready-to-merge PRs,
failing CI, merge conflicts, unresolved review threads (from `gh` CI/mergeable +
GraphQL threads), each with a deep-link; stale-claims is a SEAM (`7dc229d4`).

### Live indicators & seams

- **Live pulse** — a pulsing filled square marks any open+claimed issue (an agent
  working it now). Shown on board cards, epic rollups ("N live"), the overview, and
  the Now list. Best-effort: real liveness needs the lease `expires_at`.
- **Lifecycle phase** — a 6-cell stepper (plan → dev → validate → ship → review →
  verify), shown **in the detail hub only** (retired from cards per the diet),
  derived from the only real signals the kernel exposes: a `done` issue is
  **shipped**; a claimed-open issue is **in progress** with the remaining cells
  drawn **dashed = unknown** rather than asserting "dev". **Seam:** the kernel issue
  record has no `currentStage` field yet (`a2279f65`).
- **Multi-harness seam** — the kernel lease table holds `session_id`,
  `worktree_id`, `actor`, `expires_at`, but the CLI read surface exposes only
  `claimed_by` (actor). So the Now list and Workspaces render actor + branch + PRs
  and **infer** the harness/surface from the worktree path; the branch/PR↔issue join
  and the real harness + region tag arrive with the sync-rail / Phase-2 lease read.

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
