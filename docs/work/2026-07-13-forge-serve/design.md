# `forge serve` — interactive local dashboard (Tier-1 MVP)

Issue: `9f2f0320-afea-49df-98a4-cf9c5d07f0cf` (`[cockpit] Tier-2 — minimal forge serve config-intent write server`)
Epic: `363954dd`. Grounds on `docs/work/2026-07-10-forge-dashboard/interactive-two-tier-design.md`.

## Core principle

**Dashboard = thin trigger. `forge` verbs = mutation engine. Server = dumb relay.**

The browser never mutates the kernel directly. It fires the *same* `forge` verbs the
CLI and agents use, through an in-process relay. **All validation lives in the verb /
broker handlers** — the server adds no parallel validator. Zero agent/token cost: the
server only reads SQLite/kernel + writes via the broker; it never spawns an agent.

## Command

`forge serve [--port N] [--open]` — `lib/commands/serve.js`.

1. **Static host** for `web/dashboard/` over `http://127.0.0.1:<port>` (loopback only).
   A secure context, so the page may `fetch` + (future) `EventSource`, unlike `file://`.
   Missing generated bundles (`snapshot.js`, `docs.js`) return an empty `200` stub so
   the page cleanly falls to the live `data.json` path with no console noise.
2. **`GET /data.json`** — current snapshot. Re-runs `generate-snapshot.mjs` on demand
   (debounced ~2s cache; falls back to the baked `data.json` if generation fails), so a
   refetch after a mutation reflects the change.
3. **`GET /health`** — capability probe. `{ ok, forge_serve:true, version }`. Lets
   `app.js` flip `SNAPSHOT → LIVE`.
4. **`POST /api/mutation`** — the write path. Body `{ token, verb, args }`.

## Mutation routing (in-process, no shelling out)

The server reuses the CLI's own dispatch, so validation is never duplicated:

- `resolveCommandOpts(command, args, { projectRoot, env })` (`lib/commands/_resolve-command-opts.js`)
  — assembles the kernel driver + migrated broker exactly as `bin/forge.js` does.
- `executeCommand(commands, command, args, {}, projectRoot, { commandOpts })`
  (`lib/commands/_registry.js`) — invokes the real handler.

`verb` is whitelisted → mapped to a forge command; `args` is a string[] (built by the
browser as an argv array). No shell is ever invoked, so issue/comment bodies are inert
user data (the broker stores them; nothing is exec'd).

| `verb`           | forge command | Handler / validation source |
|------------------|---------------|------------------------------|
| `issue.create`   | `create`      | `_issue.js` → broker `commitGuardedAccept` |
| `issue.update`   | `update`      | `_issue.js` → broker |
| `issue.close`    | `close`       | `_issue.js` → broker |
| `issue.comment`  | `comment`     | `_issue.js` → broker |
| `gate`           | `gate`        | `gate.js` (unknown/locked gate rejection) |
| `role`           | `role`        | `role.js` (unknown role/skill rejection) |

Issue verbs append `--json` so the handler returns the machine envelope. The handler's
own rejection path (`{ success:false, error }` or the `forge.issue.error.v1` envelope) is
returned verbatim as JSON — the server never reinterprets a validation failure.

Hooks / skills-as-controllable (`forge control`) are out of scope; only the existing
`gate` + `role` verbs are wired.

## Security model

- **Loopback bind only:** `server.listen(port, '127.0.0.1')`. Never binds a public iface.
- **Per-run token:** minted with `crypto.randomBytes(32)` at startup, dies with the
  process. No accounts, no cloud, no daemon.
- **Token injected into the served page URL fragment** (`http://127.0.0.1:PORT/#token=…`).
  `app.js` reads `location.hash`; a fragment is never sent to the server, never logged,
  never in a `Referer` — so a foreign origin cannot learn it.
- **Every `POST /api/mutation` requires the token** (constant-time compare). Missing/wrong
  token → `403`. This is the CSRF / other-origin fence: a cross-site page can neither read
  our fragment nor forge the token.
- **Host/Origin fence:** POST rejects any request whose `Host` is not `127.0.0.1`/`localhost`
  or whose `Origin` (when present) is not our loopback origin → `403`.
- `/health` and static assets are unauthenticated but loopback-only.
- `/data.json` is gated by the SAME token fence as `POST /api/mutation` (loopback + constant-time
  token compare), since the snapshot carries full issue/message data.

## Dashboard write UI (`web/dashboard/app.js`)

Uses the existing `DataSource` seam (~L13-32) for capability detect + source switch — no
churn to the render pipeline.

- On boot, probe `GET /health`. Success → `LIVE` (badge `LIVE`, write UI enabled); else
  `SNAPSHOT` (today's read + copy-as-command, badge `SNAPSHOT`). `file://` always SNAPSHOT.
- **LIVE affordances:**
  - **Add issue** button (topbar) → modal form (title / type / priority / body) → POST
    `issue.create` → refetch `data.json`.
  - **Issue detail** status + priority `<select>` controls → POST `issue.update` → refetch.
  - **Cockpit copy-command buttons upgrade to RUN** (POST the `gate`/`role` verb) while
    STILL offering copy.
- After any successful POST, refetch `data.json` to reflect the change. SSE live-stream is
  a fast-follow, not built here.

## Anti-hang test strategy

- Handler routing tested by **direct in-process calls** (map verb → command, assert the
  handler's result/rejection) — no socket.
- One **bounded server smoke**: bind `127.0.0.1:0` (ephemeral port), issue one `fetch`
  per endpoint, then `server.close()` in a `finally`/`afterEach`. Never leave a listener
  open. Wrapped so a hang can't strand the suite.

## Out of scope (fast-follow)

SSE `/events`, multi-project registry (`~/.forge/projects.json`), Phase-2 authoritative
server, `forge control` for hooks/skills, self-scoped-only enforcement (server is
solo/loopback so all whitelisted verbs are allowed locally).
