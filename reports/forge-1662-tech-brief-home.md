Decisions needed: 5 (each has a default; silence takes the default)

1. **Which projects appear on your phone?** Your laptop already keeps a list of every project Forge has written to, and that list may include work folders.
   - A: only the projects you switch on, one at a time (default)
   - B: every project on this laptop
   - C: every project except the ones you switch off
2. **Finished work: show before and after numbers?** Today nothing records them. Only an agent could type them, and that breaks the rule that every number comes from the record.
   - A: leave them out of the first pass and show finished items by name only (default)
   - B: agents write one before and after line when they close work, shown as "the agent says", never added into any count
3. **How often does your own agent rewrite each project summary?**
   - A: every 30 minutes, and only when something changed (default)
   - B: every 2 hours
   - C: only when you ask for it
4. **When does "new since you left" reset?**
   - A: when you open that project on the phone (default)
   - B: only when you tap "Mark as seen"
5. **How long can you undo a default an agent took for you?**
   - A: 24 hours (default)
   - B: until you clear it from the list

# Technical plan: catch-me-up brief and all-projects home (forge-1762)

Date 2026-11-22. Repo facts are read from origin/main at 34c6c477. Rungs: R1 said so, R2 pointed at the line, R3 showed the bad case cannot happen, R4 ran it, R5 reproduced live. Nothing here was run, so no claim goes above R2.

## In plain words

- First, Forge gets a published format for what the owner screens show: projects, asks, events, progress and stage. It is mock v7's data document, cut down and made strict.
- Next, one command, `forge view build`, reads the tracker, claims, lanes, checks and decisions already on the laptop and writes that format. Agents do nothing new. Forge counts everything itself.
- Try it: run `forge view build --all` on the laptop and read one JSON document covering your switched-on projects.
- Next, your own agent writes a 2 to 3 line summary per project on a schedule. Forge rejects any summary that cites an event that does not exist or that types a number of its own. Numbers come from the record, never from the agent.
- Try it: ask the agent for a summary, then break a citation and watch Forge refuse it.
- Next, the laptop sends the finished view to the cloud. The phone cannot read the laptop directly, and the tracker stays on the laptop.
- Next, the phone app (from the ask loop plan) gets an all-projects home: one line across everything, the asks that stop work, then one card per project ordered needs you, stopped, running, idle.
- Try it on the phone: open the app and see every switched-on project, each with its age ("as of 10 minutes ago").
- Next, tapping a card opens the project home: what it is, current goal, summary with "written from N events", only you, progress, new since you left, wrong or paused, done for you.
- Next, a timeline one level down, with a marker showing where you last looked.
- Last, defaults an agent took while you were away appear in a "done for you" list, each with an Undo button that reaches the agent as your answer.
- Order: this part starts after the cloud is usable and the phone ask loop is merged. Owner direction 7 puts it side by side with Teams. The laptop half (first five slices) can start earlier, because it needs no cloud.

## How it works

Components, where they run, what they store:

| # | Component | Runs on | Stores |
|---|---|---|---|
| C1 | View contract `forge.view/0` (JSON Schemas) | repo `schemas/view/` | nothing |
| C2 | Record feed `forge.feed@1`: a read-only, ordered, paged event feed across allowed namespaces | laptop CLI (core state) | nothing new; reads the existing `state_events` table |
| C3 | View block `forge/view`: `view.build`, `view.summary-prepare`, `view.summary-submit`, `view.push`, `view.share` | laptop CLI and agent tool (MCP) | local namespace `forge/view`: `summary/<projectId>`, `share/<projectId>`, `push/<projectId>` |
| C4 | Device project list (exists) | laptop device store | `forge/core-projects`, key `project/<16-hex>`, value `{name, root}` |
| C5 | Brief schedule skill `forge-brief` | owner's own agent harness (Claude Code loop, Codex automation, T3 scheduled task) | nothing; calls C3 |
| C6 | Cloud view records | Durable Object of the Worker's one admitted project, through the existing `state/commit` route | namespace `forge/view`: `project/<projectId>` (snapshot), `seen/<personId>` (marker) |
| C7 | Phone read routes `GET /app/view`, `GET /app/view/<projectId>`, `POST /app/seen` | Worker, behind the owner session | `seen/<personId>` in C6 |
| C8 | Phone pages: all-projects home, project home, timeline | phone page inside the installable app shell | per-viewer UI choices only (local storage) |
| C9 | Provisional defaults and undo | ask record (ask loop) plus C7 and C8 | fields on the ask record |

Main journey, owner returns after 8 hours:

1. While the owner is away, agents work through existing commands (`issue claim`, `issue close`, `lane next`, `check run`, `decision propose`). Each accepted write already appends a `StateEvent` row with a store-wide `sequence` (R2: `src/core/state/index.ts:1621` inserts `state_events(namespace,key,body,sequence)`).
2. Every 30 minutes the owner's agent runs the `forge-brief` skill (C5). It calls `forge view build --all --since-cursor` (C3).
3. `view.build` asks the device project list (C4) for registered projects and keeps only those with a `share/<projectId>` record (decision 1, default A). It opens each one read-only through the existing peer lookup (R2: `src/assembly/levels.ts:398` `lookup(ref)`, "other projects open read-only, by the stable id or the name", line 66).
4. For each project, `view.build` reads `forge.feed@1` (C2) from the project's last cursor. It derives:
   - items and stage from `TrackerItem` (status, lease, receipt or withoutReceipt) and `issue.board` facts;
   - running from live leases, with the holder marked unverified as `issue.board` already does;
   - stopped from the lane stop flag (`lane.control`) and from asks that stop work;
   - asks from local `autopilot-ask:<issue>` records (R2: `src/blocks/work/README.md:98`) and, in the cloud, from the ask loop mailbox;
   - progress from the goal issue's child counts (`issue.tree`, R2: `src/blocks/work/docs.json` "open/closed child counts");
   - events, as one plain-word headline per event type, made from a fixed template table. No agent text appears except quoted titles.
5. The skill then calls `view.summary-prepare --project <id>`. Forge returns the window (from-sequence, to-sequence), the derived counts and the event list, plus a prepare token bound to that window. If no event is new, it returns `UNCHANGED` and the agent stops, spending no tokens.
6. The agent writes `{short[], long[], cites[]}` and calls `view.summary-submit`. Forge checks four things: the schema; that every cited id is an event inside the token's window; at least one citation per sentence; and no digit outside a `{placeholder}`. Placeholders such as `{needsYou}` are filled from derived counts at render time. Any failure refuses the write, names the line, and stores nothing. On pass, Forge stores `summary/<projectId>` with `fromEvents` equal to the window's event count, computed by Forge.
7. The skill calls `view.push`. The CLI sends each project's view as one record `project/<projectId>` through the existing `POST /p/<home>/state/commit` route with the device token. The Worker admits it only if `FORGE_STATE_NAMESPACES` lists `forge/view` (R2: `docs/reference/cloud.md:178`: config may not grant `forge/work`, `forge/cloud` or `forge/core-*`, so `forge/view` is grantable). Results are `PUSHED`, `UNCHANGED`, `REFUSED` or `UNVERIFIED`. A lost reply is UNVERIFIED and is never retried, matching the HTTP adapter (R2: `cloud.md:166`).
8. The owner opens the app on the phone. The ask loop's owner session (assumption A1) admits `GET /app/view`. The Worker reads every `project/*` record, plus the live asks from the mailbox (assumption A4), plus `seen/<personId>`. It returns one `forge.view/0` document.
9. The all-projects home (C8) draws the overview line, the asks that stop work, and the cards in state order needs, stop, work, idle. Each card shows its snapshot age. When the laptop has been off, the age says so.
10. A tap opens the project home: `GET /app/view/<projectId>` returns the full snapshot. "New since you left" means events with a sequence above that project's cursor in `seen/<personId>`.
11. On opening (decision 4, default A), the page sends `POST /app/seen {projectId, sequence, expectRevision}`. The Durable Object is the only writer of seen records and checks the revision. A stale revision refuses and the page re-reads.
12. "Done for you" lists asks whose resolution is `default-provisional`. Undo sends the owner's other option as a new answer through the ask loop's answer route (A3), which checks owner approval on the server. The agent sees a superseding answer. The item shows "undo sent" until the agent records the reversal, then "undone".

Laptop journey without the cloud: steps 2 to 6 alone. `forge view build` prints the same document, so builders can test every derivation before the cloud is on (owner direction: the local page is a build harness only).

## What exists already

| Component | What covers it on origin/main or in a trial | Rung |
|---|---|---|
| C1 contract | Mock v7 embeds one `forge.view/0` document and a `forge.templates/0` layout document (`.overseer/reports/forge-1662-shape-mock-v7.html:428-583`). Nothing in the repo. Search for `forge.view`, `catch-me-up`, `since-last`, `last-look` under src, cloud, schemas, docs/reference: 0 hits. | R2 for the mock, R1 for the absence |
| C2 feed | `StateOwner.events(namespace, key?)` returns every event of a namespace in sequence order, unpaged (R2: `src/core/state/index.ts:1568`). `history()` pages one key only (R2: `src/ports/state.ts:43`). The block state client is limited to its own namespace (R2: `src/ports/state.ts:1-2`). No cross-namespace, cursor-paged feed exists. Retired history refuses `CHECKPOINT_REQUIRED` (R2: `index.ts:1587`). | R2 |
| C3 sources | `issue.list`, `issue.board`, `issue.events`, `issue.tree`, `issue.comments`, `lane.status`, `lane.control` (R2: `src/blocks/work/forge.block.json`); `check.show`, `schemas/receipt.json` (R2: `src/blocks/check/`); `decision.list`, `memory.proposals` (R2: `src/blocks/memory/forge.block.json`). Asks: `autopilot-ask:<issue>` and digest "merges and closes since the last message" (R2: `src/blocks/work/README.md:98`). There is no `receipts` block. Receipts belong to the check block and the `forge.receipts@1` interface (R2: `src/assembly/providers.ts:211`). Receipts carry no measure or proof field: searching `measure|before|after|proof` in `src/blocks/check/schemas` and `schemas/evidence.json` found nothing relevant. | R2, R1 for absences |
| C4 project list | **Yes, a device-level list exists.** Namespace `forge/core-projects`, comment "The device's list of projects it has written for" (R2: `src/assembly/levels.ts:25-28`). A project is registered on its first write with `{name, root}` (R2: `levels.ts:319-331`) and read back by id or name (R2: `levels.ts:398-442`). The project's shared id lives in the committed `.forge/project.json` (UUID, R2: `src/assembly/project-manifest.ts:10-12`). Name comes from the folder (R2: `levels.ts:127`). Limits: only projects Forge has written to on this device, nothing about other devices, no "show on phone" flag. | R2 |
| C5 schedule | Harness scheduling exists outside Forge. Forge ships six delivery skills under `templates/delivery/skills/` (R2, inventory). | R1 for harness behaviour |
| C6 cloud records | One SQLite Durable Object per project; a Worker admits exactly one project, `FORGE_CLOUD_PROJECT` (R2: `docs/reference/cloud.md:7,40`). `state/read` and `state/commit` take device tokens and namespaces from `FORGE_STATE_NAMESPACES` (R2: `cloud.md:178`). The standard entry is closed with 503 (R2: `cloud/src/worker.ts:274`, `cloud/src/local-only.ts`). | R2 |
| C7 phone routes | Report session: cookies `__Host-forge_report`, `/app/` paths, sign-in and logout, a session bound to origin, project, issuer, client and owner (R2: `cloud/src/auth/report-session.ts`). Page headers with a strict CSP, `script-src 'self'` (R2: `cloud/src/report-http.ts`). | R2 |
| C8 pages | Mock v7 renderer, 2193 lines, vanilla JS, draws both homes from the JSON (R2: mock file). Lead rendered the first screen; nobody clicked through (R1: forge-1662 comment 17). | R1 to R2 |
| C9 defaults | Lane asks never apply a default on silence (R2: `README.md:98` "Silence never applies a default"). No record of provisional defaults exists. | R2 |
| Identity | Session identity from `FORGE_SESSION` or the harness session id (R2: `README.md:98` naming `src/assembly/identity.ts`). Team directory is an in-memory store (R1, inventory F9). | R1 to R2 |

### What is new

- C1 schemas, C2 feed capability, C3 view block with five operations, C5 skill text, the `forge/view` grant in cloud config plus a conformance case, C7 three routes, C8 three pages, C9 fields and an undo action on the ask record.

## Data shapes

All records are JSON. `*` marks a required field. Unknown fields refuse (`additionalProperties: false`). Every string has a max length. Every array has a max count.

**View document** (laptop output, phone input). Max 1 MiB in total, because `state/read` replies are capped at 1 MiB (R2: `cloud.md:166`).

```json
{
  "schema*": "forge.view/0",
  "generatedAt*": "2026-11-22T15:30:00Z",
  "source*": {"device": "device-3f2a", "session": "claude:lead-33f6e698"},
  "overview*": {"needsYou": 3, "stopped": 1, "running": 6, "idle": 1, "by": "forge"},
  "projects*": [ "...project" ],
  "asks*": [ "...ask" ],
  "seen": {"person": "owner", "at": "2026-11-22T07:10:00Z", "cursors": {"<projectId>": 18234}}
}
```

**Project** (one record `project/<projectId>` in the cloud, max 256 KiB):

```json
{
  "id*": "6f1c2a44-1b7e-4c1a-9f00-2d3e4f5a6b7c",
  "name*": "Forge",
  "about": "One owner, many coding agents.",
  "goal": {"issue": "forge-1762", "title": "Release 0.0.12", "due": "2026-11-28"},
  "state*": "needs",
  "counts*": {"needsYou": 2, "running": 3, "stopped": 0, "by": "forge"},
  "progress*": {"done": 5, "total": 8, "of": "goal-children", "by": "forge"},
  "cursor*": 18310,
  "historyFrom*": 1,
  "asOf*": "2026-11-22T15:30:00Z",
  "summary": {"status*": "accepted", "short*": ["{needsYou} things wait on you.", "Release is packed."],
              "long": [], "cites*": ["e-9b1f0c2d7a11"], "window*": {"from": 18200, "to": 18310},
              "fromEvents*": 41, "writtenAt*": "2026-11-22T15:28:00Z", "writtenBy*": "claude:lead-33f6e698"},
  "items*": [ "...item, max 500" ],
  "events*": [ "...event, max 200, newest first" ],
  "truncated*": false
}
```

- `state` is `needs | stop | work | idle`, derived by Forge. `stop`: nothing runs, and a stop flag or an ask that stops work holds it. `needs`: an open ask exists and work still runs. `work`: a live lease exists. `idle`: none of these. These rules reproduce the mock: Product Suite is `stop`, Forge is `needs`.
- `about` comes only from owner-written config (`blocks.view.config.about` in `.forge/config.yaml`), never from an agent. `goal` is the one open issue labelled `goal`. Two such issues refuse with `GOAL_AMBIGUOUS`, and the card shows "no goal set".
- `summary.status` is `accepted | stale | missing`. It is `stale` when `cursor` moved more than 50 events past `window.to`.

**Item** (derived from a `TrackerItem`):

```json
{"id*": "forge-1754", "title*": "Open view contract", "status*": "open", "stage*": "building",
 "holder": {"label": "codex:lane-2", "unverified": true}, "isNew*": true, "pr": 731}
```

- `stage` v0 is a fixed set, `queued | building | in-review | landed | stopped`. `landed` is set only for a closed item with a verified receipt, or a cloud close verified by PR (GitHub merge proof). A close with `withoutReceipt` shows as `closed-no-proof`. Declared workflows replace this set in forge-1755.

**Event** (derived from a `StateEvent`; never agent-written except quoted titles):

```json
{"id*": "e-9b1f0c2d7a11", "seq*": 18307, "at*": "2026-11-22T15:15:00Z", "kind*": "issue.closed",
 "s*": "done", "hl*": "Finished: Fair memory check", "item": "forge-1701", "actor": {"kind": "agent", "unverified": true}}
```

- `id` is `e-` plus the first 12 hex digits of sha256 over `projectId|namespace|key|revision`. It stays stable across rebuilds because `(namespace, key, revision)` is unique per store (R2: `schemas/state.json` StateEvent requires all three).
- `kind` comes from a closed table (about 20 kinds). An unknown event type maps to `other` with `hl` "Record changed". It never refuses the whole build.

**Ask** (owned by the ask loop, assumption A3. This plan adds only the last three fields):

```json
{"id*": "ask-…", "project*": "<projectId>", "short*": "Merge the two meeting lists?", "options*": ["Merge", "Keep two"],
 "default*": 0, "stops*": true, "state*": "open", "waitingSince*": "2026-11-22T11:20:00Z",
 "resolution": "default-provisional", "undo": {"until": "2026-11-23T11:20:00Z", "state": "none"}}
```

- `resolution`: `answered | default-provisional | expired`. `undo.state`: `none | sent | undone | refused`. Undo is refused after `until` (decision 5) or for kinds that always ask (publishing, credentials, money, deleting data; R1: r3 §3.3).

**Summary submit input** (agent tool):

```json
{"project*": "<projectId>", "token*": "<prepare token>", "short*": ["…"], "long": ["…"], "cites*": ["e-…"]}
```

Refusal codes: `CITE_UNKNOWN` (id not in the window), `CITE_MISSING` (a sentence has no citation), `NUMBER_TYPED` (a digit outside a placeholder), `PLACEHOLDER_UNKNOWN`, `TOKEN_STALE` (the window moved or is older than 2 hours), `TOO_LONG` (short: max 3 lines of 140 characters; long: max 5).

**Seen marker** (`seen/<personId>` in the cloud): `{"person*": "owner", "cursors*": {"<projectId>": 18234}, "at*": "…"}`. Written only by `POST /app/seen` with `expectRevision`. A cursor never moves backwards; an attempt refuses `SEEN_BACKWARDS`.

**Share switch** (`share/<projectId>` local): `{"on*": true, "at*": "…", "approval*": {"request", "quote", "source"}}`. Switching a project on uses the existing relayed-approval shape (R2: `README.md:98` `approval: {request, quote, source}`), because it sends project data off the laptop.

## Mock v7: what stays and what changes

- **Stays:** schema id `forge.view/0`; project `id, name, about, goal, state, summary{short,long,fromEvents,writtenAt}, counts{needsYou,running,stopped}, progress{done,total}`; ask `short, options, default, stops, unblocks`; event `id, s, hl, sl, item`; state words needs, stop, work, idle; the all-projects and project panel order of the "Owner brief" layout.
- **Changes:** clock strings ("15:30", "Wed") become RFC 3339; `waitMin` becomes `waitingSince` and the phone computes the wait. `by` becomes Forge-only on counts and progress, and agent text exists only in `summary` and ask text. Summary gains `cites`, `window` and `status`. `questions` and `asks` merge into one ask record. `defaults` becomes asks with `resolution: default-provisional`. `threads` and `runs` become items with a holder marked unverified. `lastChange` becomes `asOf` plus `cursor`.
- **Dropped from v0 (parked by forge-1764, forge-1755, forge-1754):** `features` with before and after and proof (decision 2), `workflows` and flow map, `days`, `machines`, `usage`, and the whole `forge.templates/0` layout document. The phone uses one fixed layout.

## Borrow or build

| Component | Choice | Why | If the outside thing changes |
|---|---|---|---|
| C1 schemas | Build. Adapt the shape from mock v7 and the JSON Schema style of `src/blocks/*/schemas`; validate with the existing `SchemaRegistry` (R2: `cloud/src/evidence-receipts.ts:2`) | Forge already validates every block I/O this way | nothing outside |
| C2 feed | Build, small, in core state beside `events()` | Blocks cannot read other namespaces by design, so the feed must be a declared read-only capability | nothing outside |
| C3 view block | Build as a block with manifest, schemas and docs, following `examples/hello-block` and `docs/writing-a-block.md` | A block gets MCP and CLI exposure for free | nothing outside |
| C4 project list | Reuse as is | Exists (R2) | nothing outside |
| C5 schedule | Template skill text, no code | Owner direction 4 favours templates; the harness owns timers | If a harness drops scheduling, the owner runs the brief by hand; the result is identical |
| C6 transport | Reuse `state/commit` and `state/read` plus one config entry | No new upload route, and the existing transport checks (1 MiB cap, no retry on a lost reply) apply | nothing outside |
| C7 routes | Adapt `report-session.ts` gating; build three handlers | Same cookie and CSP rules | Depends on the ask loop session (A1) |
| C8 pages | Adapt the mock v7 renderer, split into static files under the app shell (CSP forbids inline script) | It already draws both homes from this data | nothing outside |
| C9 undo | Build on the ask loop answer route (A3); no Board-specific code | Who may answer and proof of who answered stay Forge's | If the Board mailbox import fails, the fallback Forge mailbox must expose the same answer route; C9 changes nothing |
| Mailbox reads | Through the ask loop's read API only, never Board's tables directly | Isolates this part from Board 0.54.0 internals (the trial needed private patches, R2: `forge-1761-board-on-do.md` "Private package patches") | a Board upgrade can only break the ask loop adapter, not this part |

## Slices

First pass only. One lane builder per PR; a different model gates it; tests run red then green in hosted CI.

| # | Slice | Owner can see or try when merged | Files or folders | PRs | Non-test lines | Depends on | Can run beside |
|---|---|---|---|---|---|---|---|
| S1 | View contract v0 | Read the published shapes in `docs/reference/view.md` | `schemas/view/*.json`, `docs/reference/view.md`, generated types | 1-2 | 150-220 | none | S2 |
| S2 | Record feed `forge.feed@1` (security tier: a cross-namespace read) | Nothing visible; agents can page events with a cursor | `src/core/state/index.ts`, `src/ports/state.ts`, `src/assembly/providers.ts`, trust profile | 1 | 150-250 | none | S1 |
| S3 | View block and project derivation | `forge view build --project forge` prints counts, state, progress, items, stage | `src/blocks/view/` (manifest, entry, schemas, docs) | 2 | 250-400 | S1, S2 | S8 after its first PR |
| S4 | Event headlines and since-cursor | `forge view build --since-cursor 18200` prints plain-word events | `src/blocks/view/events.ts`, docs | 1-2 | 180-300 | S3 | S5 (different file) |
| S5 | All projects plus share switch | `forge view share forge` (asks your approval); `forge view build --all` | `src/blocks/view/`, read-only peer open via `forge.project-state` | 1 | 120-200 | S3 | S4 |
| S6 | Summary prepare and submit with citation check | Agent submits a summary; a broken citation is refused with the line named | `src/blocks/view/summary.ts`, schemas | 2 | 250-380 | S4 | S8 |
| S7 | Brief schedule skill | Your agent refreshes summaries every 30 minutes when something changed | `templates/delivery/skills/forge-brief/SKILL.md`, template manifest | 1 | 60-120 | S6 | S8, S9 |
| S8 | Push to the cloud | `forge view push` reports PUSHED or UNCHANGED; the deploy needs your yes | `src/blocks/view/push.ts`, cloud config for `forge/view`, `cloud/conformance/` view and restore case, `docs/reference/cloud.md` | 2 | 200-320 | S3; cloud usable | S4, S6 |
| S9 | Phone read and seen routes (security tier) | `/app/view` returns your projects once signed in; the seen marker moves | `cloud/src/view-http.ts`, `cloud/src/worker.ts` routing | 1-2 | 200-330 | S8; ask loop session and shell | S7 |
| S10 | All-projects home page | Phone opens on the overview line, stopping asks, ordered cards with age | app shell `home` page files | 2 | 250-400 | S9 | none (S11 shares files) |
| S11 | Project home page | Tap a card: identity, goal, summary with "written from N events", only you, progress, new since, wrong or paused | app shell `project` page files | 2 | 280-420 | S10 | none |
| S12 | Timeline and since marker | Timeline one level down with a "you last looked here" line | app shell `timeline` page files | 1 | 150-220 | S11 | S13 |
| S13 | Provisional defaults and undo list | "Done for you" list; Undo reaches the agent; state goes sent, then undone | ask record fields (ask loop schema), `cloud/src/view-http.ts`, project page panel, `docs/reference/view.md` | 2 | 220-360 | S11; ask loop answer route | S12 |

Totals: **17 to 21 PRs, 2,460 to 3,920 non-test lines.** That sits inside the lead's first-pass estimate of 15 to 20 PRs, at the top end (R1: forge-1662 comment of 2026-11-22T06:24). Median line count per PR is about 150 to 190, against the measured median of 122 (R4 by the lead, not by me), so expect one or two PRs to split.

Order and lanes: S1 and S2 together; then S3; then S4, S5 and S8 side by side (three lanes, different files); then S6; then S7 and S9; then S10 to S12 in order (same page files); S13 beside S12. Slices S1 to S7 need no cloud and can start before the ask loop lands.

## Left for later

File each as an issue at merge (owner direction 3):

1. Edge states beyond a clean refusal: a summary racing a push, a seen marker from two phones at once, a project removed from the device list while shared.
2. Restart and reconnect test matrix: phone offline then online, laptop asleep mid-push, Worker restart during a seen write.
3. Proof on real iPhone and Android phones for the three pages.
4. Light mode and accessibility pass on the three pages.
5. Docs beyond the command reference: a user guide for the brief and the share switch.
6. Snooze choices that adapt to what the owner usually picks (forge-1762 "later" item).
7. Before and after numbers on finished work, if decision 2 picks A now.
8. Declared stages replacing the fixed v0 stage set (forge-1755).
9. Layout documents and a public read API (forge-1754).
10. Projects from more than one device merged into one home (needs Teams identity).
11. A paged feed in the cloud so the phone can scroll past 200 events.

## Owner steps

In order:

1. Answer the five questions at the top, or let the defaults stand.
2. After S5: switch on each project you want on the phone (`forge view share <name>`). Each switch asks for your yes once, because it sends that project's data off the laptop.
3. After S7: say yes once to your agent setting up the 30-minute brief in your harness.
4. After S8: give a yes for the Worker config deploy that adds `forge/view` to the allowed namespaces. Reverse path: redeploy the prior config; records already stored stay but are no longer readable through state routes.
5. After S9: sign in on the phone with the ask loop's sign-in link (assumption A1).
6. After S10 and S11: open the app on the phone and say whether you can tell, within two minutes, what changed and what is stuck in each project. This is the issue's success test.
7. After S13: undo one default from the list and confirm the agent acted on it.

## Assumptions about the ask loop (forge-1662-tech-ask-loop.md, not yet readable)

- A1: an owner session on the phone that extends the report session (`cloud/src/auth/report-session.ts`) and gates every `/app/*` route. Used in S9.
- A2: an installable web app shell served by the same Worker, with static script files allowed by `script-src 'self'`. Used in S10 to S12.
- A3: an ask record with id, project, options, default, stops, state and answers, plus a server-checked answer route bound to request, project, device and session. Used in S13 and the asks list.
- A4: a cloud mailbox that the Worker can read for open asks without going through the laptop. Used in step 8. If the mailbox lives in a different Durable Object, `GET /app/view` makes one internal call to it.

## Risks and unknowns

| Risk | How to find out | Cost if wrong |
|---|---|---|
| R-1 The feed (S2) is a new trust boundary: a read across namespaces could expose comments or notes that one block was never meant to show another | Gate review on S2, plus an allow list of exact namespaces (`forge/work`, `forge/check`, `forge/memory` decisions only) and a test that `forge/core-*` and device namespaces refuse | One reworked security PR; worst case, private notes reach the phone |
| R-2 The cloud admits one project per Worker, so all projects' views sit in the "home" project's Durable Object. Work folders could leak into a personal cloud | Decision 1 default A (opt-in with approval); conformance case that an unshared project is never pushed | Data in the wrong account; owner trust |
| R-3 A citation check proves only that events exist, not that the summary is fair. A summary can still leave out the blocker | Counts, stopping asks and "wrong or paused" are derived and shown above the summary, never written by the agent; the owner's two-minute test (step 6) | A misleading brief; mitigated because the brief's facts do not depend on the summary |
| R-4 Laptop off means a stale phone view | Every card shows its age; the brief skill runs only while a harness runs | Owner reads old state as current if the age label is missed |
| R-5 Ask loop interfaces (A1 to A4) differ from these assumptions | Read forge-1662-tech-ask-loop.md as soon as it exists; reconcile before S9 | S9 and S13 rework, about 2 to 4 PRs |
| R-6 Event headline mapping is wider than planned: the work entry file is 7,131 lines (R2) with about 18 key families | S4 maps the top 10 kinds and sends the rest to `other`; count unmapped kinds on the real Forge store before S4 | One extra PR |
| R-7 A checkpoint retires old history, so the feed refuses `CHECKPOINT_REQUIRED` | S2 reports `historyFrom` instead of failing the whole build | A blank timeline for old projects |
| R-8 The 1 MiB reply cap and 256 KiB per project cap may cut busy projects | `truncated` flag; measure the Forge store's view size in S3 | Fewer events shown; no data loss |
| R-9 Restore: seen markers and snapshots must survive dump and restore without reviving anything | S8 adds a conformance restore case; snapshots are rebuildable, and seen markers are harmless if lost | A reset "new since" marker |

## What I read

- Brief: `.overseer/spikes/forge-1662-tech-plan/BRIEF.md`.
- Issues: forge-1762 (body; it has no comments), forge-1754, forge-1755, forge-1764, forge-1662 body and all 25 comments.
- Reports: `forge-1662-shape-mock-v7.html` (lines 425-586: data and layout documents), `forge-1662-shape-r2-owner-summary-style.md` (all), `forge-1662-shape-r3-owner-workflow.md` (headings and §3-5), `forge-1662-shape-r1-blocks-timelines.md` (all), `forge-1662-shape-r1-oversight-tools.md` (first 40 lines), `forge-1662-final-shape.html` (searched for brief and home lines only), `forge-1780-inventory-built.md` (all), `forge-1761-board-on-do.md` (first 30 lines), `forge-1662-INDEX.md` (searched).
- origin/main at 34c6c477: `src/blocks/` listing; `src/blocks/work/forge.block.json` (read operations), `docs.json` (events), `README.md` (lines 28, 80, 98), schemas `events.json`, `ListItemsInput.json`, `ListItemsOutput.json`, `board.output.json`; `schemas/state.json` StateEvent; `schemas/tracker.json` TrackerItem; `schemas/interfaces/forge.tracker.json`; `src/blocks/check/forge.block.json` and schemas listing; memory manifest via inventory and `src/blocks/memory/index.cts` lines 20-45; `src/ports/state.ts`; `src/core/state/index.ts` lines 1560-1600; `src/assembly/levels.ts` lines 1-210, 300-450; `src/assembly/project-manifest.ts` head; `src/ports/device-files.ts`; `src/blocks/accounts/entry.cts` bindings lines; `src/blocks/cloud/README.md`; `cloud/src/` listing, `project-name.ts`, `report-http.ts`, `auth/report-session.ts` head, `worker.ts` routing lines, `local-only.ts`; `docs/reference/cloud.md` headings, lines 1-11 and 164-180.
- Not read: the ask loop plan (not yet written); the untrusted Board and nightmail clones (not needed); `team/` source beyond the inventory; `docs/reference/cloud.md` after line 180, apart from searched lines.

COVERED 8 OF 8 (1 view contract: Data shapes and Mock v7 section; 2 derivation: C2, C3, steps 3-4, S2-S5; 3 cloud path and device project list: C4, C6, step 7, S8; 4 summaries and citation check: C5, steps 5-6, S6-S7; 5 all-projects home: step 9, S10; 6 project home: steps 10-12, S11; 7 timeline and per-person marker: seen record, S12; 8 provisional defaults with undo: C9, ask fields, S13)
