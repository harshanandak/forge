Decisions needed: 5 owner questions. Each has a default; silence means the default.

1. **Trying the phone asks before the cloud launch.** A: run them on a separate test copy of the cloud that only your sign-in can open; the main cloud stays closed (default). B: open only the phone pages and the ask doors on the main cloud. C: wait for the full cloud launch.
2. **How long the phone stays signed in.** A: 15 minutes, as already built; after that, signing in again is usually one tap because the sign-in service remembers you (default). B: 12 hours for reading and ordinary answers; approvals still ask for a fresh sign-in.
3. **What the lock screen shows.** A: only counts and the oldest wait, for example "Forge: 3 waiting, 1 stopped 12 min", with no question text (default). B: also the title of the oldest question.
4. **Answering from the terminal.** A: allowed for ordinary questions only, and the answer is marked "from the terminal"; approvals need the phone (default). B: phone only, for everything.
5. **When an unanswered ask gives up.** A: after 24 hours it closes as expired and the work stays stopped (default). B: after 7 days. C: never; it waits until answered or withdrawn.

# Forge phone ask loop: technical execution plan (forge-1761)

Written 2026-11-22 against origin/main 34c6c477 (not fetched first; the tracked ref as it stood). Plan, not code. Builders are cut from section 7.

## 2. In plain words

- An agent runs `forge ask create` with a question, two to six options, a default, whether work is stopped, what is blocked and who may answer. Forge refuses an ask that lacks any of these.
- The ask goes to the cloud mailbox. The mailbox engine is Vercel Board's, imported and run inside Forge's own cloud. Forge alone decides who may answer and records who did.
- The agent runs `forge ask wait`. It sleeps on a connection that costs nothing while idle and wakes within a second of the answer. If the laptop is off, the answer waits in the cloud and the next session picks it up.
- First thing you can try (after about 9 merged PRs): an agent asks, sends you a link in chat, you open it on the phone, sign in, tap an option, and the agent carries on.
- Next: the Forge icon on your home screen, a grouped list (only you, worth a look, safe defaults with one take-all switch), and approvals that are checked with a fresh sign-in.
- Then: one phone notification that updates in place. It sounds at 0, 5, 15 and 30 minutes only for asks that stop work; the 30 minute one is loud. Asks that do not stop work never remind.
- Then: snooze (5, 10, 30 min, 1 hour, Long) and a sleep window. Agents can read when you are back.
- Every answer records who gave it, cannot be changed, and the first accepted answer wins. A late or second answer is kept as a comment.
- Backup and restore of asks ship in the first pass; a restore cancels open asks instead of reviving them.
- Size: 19 PRs, about 2,500 to 3,800 non-test lines, three lanes in parallel where files allow.
- To try it before the launch, the plan deploys a separate owner-only test copy of the cloud (question 1). You approve that deploy.
- Left for later: odd edge states beyond a clean refusal, restart test matrices, proof on real phones, light mode and accessibility, longer docs.

## 3. How it works

### Moving parts

| Part | Runs on | Stores |
|---|---|---|
| `forge/ask` block: `ask.create`, `ask.show`, `ask.list`, `ask.answer`, `ask.withdraw`, `ask.wait` | Laptop CLI and agent MCP tools (generated from the manifest) | Nothing. Last seen position is returned to the caller and passed back by it |
| Command route `/p/<project>/command` | Cloud Worker | Nothing; checks token and project before any object |
| Project object (existing) | Durable Object `PROJECTS` | Device tokens and issues (existing); checks the device token, then forwards ask commands with the verified device and session. Mints the lane approval for an approved protected ask |
| Ask mailbox object `AskMailbox` (new) | Durable Object `ASKS`, one per project | Forge tables: asks, answers, late answers, presence (snooze and sleep), push subscriptions, notification state, due timers, outbox. Board tables: one thread per ask with its numbered event log |
| Board engine `@vercel/board` 0.54.0 | Inside `AskMailbox` | Thread messages and event positions (projection for waiting and later Slack); never the answer authority |
| Wait socket `/p/<project>/ask-socket` | Worker, then `AskMailbox` (hibernating WebSocket) | Nothing beyond the open socket |
| Phone pages `/app/asks`, `/app/ask/<id>`, `/app/presence` | Worker, server-rendered HTML; form posts | Nothing in the browser; no offline copy |
| Report session (PR 730) | Worker plus a `CodeRedemption` record per session | Session deadline; this plan adds the sign-in time |
| Service worker `/app/sw.js` | Phone | Nothing; only shows the pushed notification and opens the page on tap |
| Push sender | Inside `AskMailbox` alarm | Delivery attempts per person and ladder step |

### Main journey, numbered

1. An agent calls `forge ask create` (CLI) or the `ask.create` MCP tool. The block validates the input against its schema on the laptop. The project must be cloud-bound; a local project gets `UNAVAILABLE` "Asks need a cloud-bound project".
2. The CLI sends `{requestId, op: "ask.create", input}` to `POST /p/<project>/command` with the device token, through the existing cloud client (`src/assembly/cloud-state-client.ts`). `cloudRoute()` must learn to route block `forge/ask` (today it routes only `forge/work`; `src/assembly/cloud-authority.ts:105-111` on origin/main, rung 2: pointed at the line).
3. The Worker applies its existing project and bearer checks (`cloud/src/worker.ts:76-110`, rung 2) and forwards to the Project object. Project verifies the device token as it does for `issue.*`, then calls `AskMailbox` at the private path `/__forge/ask` with the verified device, session and token id in a request it builds itself (no browser headers pass through).
4. `AskMailbox` checks the rules (options, default, stops work, blocks, answerers, sizes, pending cap) and the replay key, then in one `transactionSync` writes the ask row, a `created` event and an outbox row. Next it posts the ask as the root message of a new Board thread under the agent's principal and stores the Board event position on the ask. The outbox row is deleted when the Board post succeeds; the alarm retries it otherwise.
5. If the ask stops work, `AskMailbox` puts a due timer for ladder step 0 at once and steps 5, 15, 30. The alarm handler sends one web push per subscribed phone with tag `forge-asks-<person>`. If the issue field is set, an outbox row also adds a plain comment on the issue through the Project's existing `issue.comment` writer, so the work item shows the question.
6. The reply to `ask.create` returns `{id, url, cursor}`. `url` is `/app/ask/<id>` on the cloud origin, so before push exists the agent pastes it in chat.
7. The agent calls `forge ask wait <id> --after <cursor>`. The CLI first calls `ask.show`; if the ask is already answered, withdrawn or expired it returns at once. Otherwise it opens a WebSocket to `/p/<project>/ask-socket?ask=<id>&after=<cursor>` with the device token. The Worker checks the token through Project, then hands the upgrade to `AskMailbox`, which accepts it with the hibernation API and sends any events after the cursor at once (backlog first). Then the object sleeps.
8. The owner taps the notification or the link. The phone opens `/app/ask/<id>`. With no live report session the page sends the owner to `/app/sign-in?ask=<id>`, which runs the existing Clerk flow from PR 730 and returns to the ask.
9. The page shows the title, why now, what is stopped, the options with consequences, the default marked, and who asked. Each option is a button in a form that carries a form token: an HMAC over the session id, ask id and the digest of the brief shown.
10. The owner taps an option. The Worker checks `Origin`, the session record, the form token and, for an approval, that the sign-in is at most 300 seconds old (otherwise it sends the owner through sign-in again with `max_age=300`). It forwards to `AskMailbox` with the verified person.
11. `AskMailbox`, in one `transactionSync`: the ask must be `pending`, the brief digest must match, the person must be in `answerers`. It writes the immutable answer, sets the ask to `answered`, writes an `answered` event and outbox rows. A second or late answer is written as a late-answer comment and the reply says which answer stands. For an approval, Project first mints the lane approval as already approved, keyed by the ask id so a retry cannot mint twice (section 6).
12. `AskMailbox` posts the answer as a reply in the ask's Board thread, which appends an event, and sends a nudge with the new position on every socket waiting for that ask. It clears the ask's due timers and pushes a silent update of the one notification (counts drop).
13. The agent's CLI receives the nudge, calls `ask.show`, and returns `{state: "answered", answer, cursor}`. The agent carries on.
14. Laptop off: steps 11 and 12 still happen in the cloud. The next session's `ask wait` or `ask list --state answered` returns the stored answer at step 7 without waiting. The issue comment from step 5 gets a second comment with the answer.

## 4. What exists already, and what is new

### Exists

| Component | File or trial | Rung |
|---|---|---|
| 1 Ask record and commands | Nothing named ask, question or mailbox in `cloud/src` (lead search on da6029f2, comment 1 on forge-1761: rung 1, said so). My search on 34c6c477 for `web-push`, `vapid`, `acceptWebSocket`, `PushManager` in `cloud` and `src`: zero hits (rung 1). Block pattern: `src/blocks/agent/forge.block.json` (operations with input, output, context, timeoutMs, effects, callers, args) and `schemas/wait.input.json` (rung 2) | 1 and 2 |
| 2 Cloud mailbox | Board on a Durable Object, local trial: wait already open 50/50, reply stored 50/50, disconnect and resume 50/50 after one timeout in 50 on a rerun, restart 10/10, conformance 86 passed 0 failed 5 skipped (`forge-1761-board-on-do.md`, rung 4: ran it locally). Glue read: `prepare.ts` 20 lines, `storage.ts` 75 lines, `worker.ts` 59 lines (rung 2). Own mailbox fallback: 126-line trial in `.overseer/spikes/forge-1761-wait-trial` (forge-1761 comment 9, rung 1) | 4 |
| 2 Board Slack seat for later | `forge-1761-board-slack.md`: Board's Slack sync ran unchanged in the same object, 20/20 replies woke the wait (rung 4, local, fake Slack) | 4 |
| 3 Wait and wake | `forge-1761-wait-trial.md`: hibernating socket wake median 5.93 ms p95 21.59 ms, 1 read in 120 s idle, 0 of 100 lost on reconnect with position, 100 of 100 lost without one (rung 4) | 4 |
| 4 Sign-in and session | `cloud/src/auth/report-session.ts` (owner-only Clerk flow, `__Host-forge_report`, 900 s), `cloud/src/report-http.ts` (no-store headers, CSP), `cloud/src/adapters/workers-oauth/report-session-store.ts` (stores only the deadline, no sign-in time), wired only in `createConfiguredWorker()` in `compose.ts:170-197` (rung 2) | 2 |
| 4 Server-checked approval | `cloud/src/lane-approval.ts`: bound to project, token, device, session, policy identity, incarnation, epoch; 600 s expiry at line 278 of the file (`host.now + 600_000`); states pending, approved, denied, expired, stale, spent (rung 2) | 2 |
| 5 Installable page | forge-1672 slice 1 design, PR B (manifest, icons, issue page) not yet merged (forge-1672 comment 1 says next is PR B: rung 1) | 1 |
| 6 Web push | Nothing in code (search above, rung 1). Platform facts in `forge-1672-research.md` and `forge-1662-eval-building-blocks.md` (vendor docs, rung 1) | 1 |
| 7 Ladder timers | Project already has one alarm for receipt maintenance (`cloud/src/project.ts:367-395`, rung 2); Board's alarm adapter survived a restart in the trial (rung 4) | 2 and 4 |
| 8 Snooze and sleep | Nothing | none |
| 9 Answer record | Lane approval decision `{issuer, subject, at}` pattern (rung 2); Board stores Slack replies under `slack:user:<id>`, so the person link is Forge's job (`forge-1761-board-slack.md` Q4, rung 4) | 2 |
| 10 Opening the Worker | `cloud/src/local-only.ts` answers 503 to everything; both `compose.ts:370` and `worker.ts:274` re-export it as the default; `wrangler.example.jsonc` main is `compose.ts` (rung 2). Closed by forge-1676 so no user creates cloud data on the v2 format, "while the owner rehearsal Worker and CI keep working" (issue body, rung 1) | 2 |

### New

The `forge/ask` block; the `AskMailbox` object with its Forge tables, Board engine glue, wait socket, alarm multiplexer, push sender, presence and export; ask routing in `cloud-authority.ts`, Project and Worker; the phone pages and service worker; the sign-in time in the session record and the step-up for approvals; lane approval minted from an approved ask; an owner preview entry for the Worker.

## 5. Data shapes

All JSON. `R` = required on write. Server-filled fields are refused if a caller sends them.

**Ask** (written by `ask.create`)

```json
{
  "requestId": "R, client idempotency key, 8-128 chars",
  "kind": "R, question | approval | memory-proposal | decision-proposal",
  "issue": "optional, forge-1761 style id; when set the ask is mirrored on the issue",
  "title": "R, 1-120 chars",
  "why": "R, 1-2000 chars: what is asked and why now",
  "options": [
    { "key": "A", "label": "R, 1-80 chars", "consequence": "R, 1-300 chars" },
    { "key": "B", "label": "Ship without it", "consequence": "Faster, adds one follow-up" }
  ],
  "default": "R, one of options[].key",
  "defaultSafe": "R, boolean; must be false for approval",
  "stopsWork": "R, boolean",
  "blocks": "R, 1-200 chars: what is stopped, e.g. 'Lane 3 cannot merge PR 741'",
  "answerers": [{ "kind": "person", "id": "owner" }],
  "freeText": "optional boolean, default false",
  "expiresInHours": "optional 1-168, default 24 (question 5)",
  "evidence": [{ "label": "PR 741", "url": "https://github.com/..." }],
  "approval": { "op": "lane.resume", "scope": "<lane scope>" }
}
```

Server adds: `id` (`ask-<base32>`), `project`, `requester: {device, session, tokenId}`, `state` (`pending | answered | withdrawn | expired`), `createdAt`, `expiresAt`, `briefDigest` (sha256 of title, why, options, default), `cursor` (Board event position), `controlBinding` for approvals (`incarnation`, `epoch` read from Project at create).

Refused (`INPUT_INVALID`, 400): fewer than 2 or more than 6 options; duplicate option keys; `default` not an option key; missing `stopsWork`, `blocks` or `answerers`; an answerer other than `owner` in the first pass (teams arrive with forge-1763); `approval` missing when kind is approval or present otherwise; `defaultSafe: true` on an approval; an evidence URL that is not https; any field over its size; the whole input over 16 KiB. Refused `INPUT_CONFLICT` (409): same `requestId` with different input (same input returns the first reply). Refused `UNAVAILABLE` (503, retry later): 50 pending asks in the project, or a write that cannot commit.

**Answer** (immutable once written)

```json
{
  "ask": "ask-7f3k2q",
  "choice": "B",
  "text": null,
  "by": { "kind": "person", "issuer": "https://<clerk>", "subject": "user_...", "label": "owner" },
  "via": "phone | terminal | take-all",
  "proof": "owner-session | owner-session-fresh | device-token",
  "session": "first 16 hex of sha256(report session id), or null",
  "device": "device id for terminal answers, or null",
  "briefDigest": "sha256 the answer was given against",
  "acceptedAt": "2026-11-22T10:15:04.112Z",
  "sequence": 1
}
```

Write rules: accepted only while the ask is `pending`, before `expiresAt`, with a matching `briefDigest`, from a person in `answerers`. `text` only when `freeText` is true, 1-2000 chars. Approvals need `proof: owner-session-fresh` (Clerk sign-in at most 300 s old). Terminal answers (`proof: device-token`) are refused for approvals with `APPROVAL_REQUIRED` and "Approve on the phone" (question 4). Nothing updates or deletes an answer row; the table has no update path in code.

**Late answer** (stored when an answer loses)

```json
{ "ask": "ask-7f3k2q", "reason": "already-answered | withdrawn | expired | stale-brief",
  "choice": "A", "text": null, "by": { "...": "as in Answer" }, "via": "phone", "at": "..." }
```

The reply to the losing caller is `ok: false`, code `ASK_CLOSED` (409), with the standing answer or state in `error.observed`.

**Ask reply to agents** (`ask.show`, `ask.wait`; `ask.list` returns `items` of the same)

```json
{ "id": "ask-7f3k2q", "state": "pending", "cursor": "1042", "answer": null,
  "answerers": [{ "id": "owner", "away": true, "backAt": "2026-11-22T11:00:00Z", "why": "snoozed" }],
  "waitedSeconds": 412, "approval": null }
```

`backAt` is the end of the active snooze or sleep window, or null. For an answered approval, `approval: {"request": "<lane approval id>", "status": "approved"}`.

**Presence** (one row per person)

```json
{ "person": "owner", "snoozedUntil": "2026-11-22T11:00:00Z",
  "sleep": { "daily": { "from": "23:30", "to": "07:00", "tz": "Asia/Kolkata" },
             "once": { "from": "2026-11-23T01:00:00Z", "to": "2026-11-23T09:30:00Z" } } }
```

Refused: a snooze without an end time, or longer than 24 hours; a sleep window longer than 14 hours; an unknown time zone. Snooze choices on the page: 5, 10, 30 min, 1 hour, Long (2, 3, 6 hours, custom).

**Push subscription** (per person, at most 5)

```json
{ "person": "owner", "endpoint": "https://web.push.apple.com/...", "keys": { "p256dh": "...", "auth": "..." },
  "session": "first 16 hex of the session digest", "createdAt": "..." }
```

Refused: endpoint not https, endpoint host not in the push host list (`web.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`), over 1 KiB. Removed on a 404 or 410 from the push service.

**Notification state and delivery** (internal)

```json
{ "person": "owner", "tag": "forge-asks-owner", "stopped": 1, "other": 6, "oldestStoppedSince": "...",
  "sent": [{ "ask": "ask-7f3k2q", "step": 15, "state": "sent | failed | uncertain", "at": "..." }] }
```

**Due timer** `{ "key": "ladder:ask-7f3k2q:15", "due": 1763805300000, "kind": "ladder | snooze-end | sleep-end | expire | outbox" }`. One alarm, set to the earliest due row.

## 6. Borrow or build

| Component | Choice | Why, and what breaks if the outside package changes |
|---|---|---|
| 1 Commands | Adapt the block manifest pattern (`src/blocks/agent`, `src/blocks/work`) | CLI, MCP tools and help come from the manifest with no wiring code (forge-1761 comment 8, rung 1). Nothing outside |
| 1 Ask rules | Build, `cloud/src/ask/records.ts` | No product checks who may answer (Board trusts the authenticate hook and display names; copy audit E1, rung 2) |
| 2 Mailbox engine | Import `@vercel/board` 0.54.0, pinned exactly, with one Bun patch file | Owner default A. Gives the thread log, positions, backlog-first reads, alarm-driven scheduler and the Slack seat for forge-1763 for about 75 lines of glue (trial, rung 4). Breaks: any version bump changes hashed file names, so the patch must be regenerated and CI fails at install until it is |
| 2 Fallback | Forge's own mailbox (126-line trial) behind the same internal `AskEngine` interface | Swap if: the patch cannot be regenerated within one PR for an upgrade we need, the conformance kit regresses, or deployed CPU per request breaks the free plan's per-request limit. Cost: about 2 PRs, replacing slice 2 only, because Forge tables hold the authority |
| 3 Wait | Adapt the hibernating socket from the wait trial; Board for the log and positions | Board's own wait is a held HTTP request, which keeps the object awake and billed: 128 MB x 3,600 s = 460.8 GB-s per waiting hour against 13,000 GB-s a day free (forge-1761 comment 9: arithmetic from vendor pricing, rung 1). A sleeping socket avoids that |
| 4 Session | Adapt PR 730's report session; add sign-in time; step-up with OIDC `max_age=300` | Reuses the owner check, cookie, revocation and redemption object (rung 2). Breaks if Clerk ignores `max_age` (unverified, risk 4) |
| 4 Protected actions | Adapt `lane-approval.ts`: mint an already-approved row when the owner approves the ask | The lane link lived 10 minutes and 3 of 3 expired before the owner opened them (forge-1662 comment 1, rung 1). Minting at approval removes that window |
| 5 Pages | Build server-rendered HTML in `cloud/src/ask-app.ts`, styles from the report page | No framework; CSP `script-src 'self'` as in `report-http.ts` |
| 5 Install | Reuse forge-1672 PR B manifest and icons | Already designed |
| 6 Push sender | Import `web-push` (3.6.7 is the version I know; confirm the newest at least two weeks old in the slice) under the existing `nodejs_compat` flag; if it does not run in Workers, build RFC 8291 and RFC 8292 on Web Crypto (about 120 lines) | Cloudflare's push example uses `web-push` (building-blocks report [PUSH], rung 1). Breaks: a major version could change Node crypto use; pin exactly |
| 7 Ladder | Build in `cloud/src/ask/ladder.ts` on the alarm multiplexer from the trial's `storage.ts` | Board's local scheduler loses timers on restart and posts messages, not per-person notifications (eval-board, rung 2) |
| 8 Snooze and sleep | Build, `cloud/src/ask/presence.ts` | Nothing exists anywhere checked |
| 9 Answer | Build; borrow immutable snapshot idea from research r2 (`AnswerV1`) | First accepted answer wins needs one transaction in the authority |
| 10 Preview entry | Build a 10-line entry that exports `createConfiguredWorker()` | Same code the tests drive; no new auth path |

How the Board import is done, exactly:

1. `cloud/package.json`: `"@vercel/board": "0.54.0"` (exact, no caret). The brief names the npm package `board`; the trials and comment 7 use `@vercel/board`, and that is the one pinned here.
2. `bun patch @vercel/board@0.54.0` produces `cloud/patches/@vercel%2Fboard@0.54.0.patch`, recorded under `patchedDependencies` in `cloud/package.json`. It makes the same two edits the trial's `prepare.ts` made with regexes (exports `a2`, `deliverSchedulerAppend`, `deliverSchedulerClear` from `dist/local-RoMUU6QX.mjs`; the store in `dist/store-sqlite-D6fIszST.mjs` takes an injected database and delegates transactions), and adds `"./engine"` to the package `exports` so Forge imports `@vercel/board/engine`, never a hashed path. That Bun applies patches at install and stops when one does not apply is from my knowledge of Bun (rung 1); slice 2 shows it in CI.
3. `cloud/src/ask/board-store.ts` is the trial's `storage.ts` with the scheduler table renamed and Forge's own due rows multiplexed onto the same alarm.
4. A CI step runs Board's own conformance kit (`@vercel/board/conformance`) against the `AskMailbox` object under wrangler local mode, expecting 86 passed and the same 5 grant skips. A drop fails the PR.
5. Board's HTTP handler is not reachable from the internet in the first pass. Only Forge code inside `AskMailbox` calls it, and a Board `middleware` refuses any write whose source is not Forge's internal call. So no path can post an answer around Forge's checks.
6. Upgrades: a deliberate PR that bumps the pin, regenerates the patch and passes conformance. No automatic dependency updates for this package. With about two releases a day upstream (54 versions from 2026-10-26 to 2026-11-20, comment 9, rung 1), staying pinned is the default.
7. Apache-2.0 duties: keep the license text and add a change notice in the patch header (copy audit, rung 2).

## 7. Slices (first pass only)

Line counts are non-test lines, judgment from the trial glue sizes and the forge-1672 PR A actual (240 non-test). Security-tier slices may go to 330; any slice heading past its high number splits.

| # | Slice | Owner can see or try when it merges | Files or folders | PRs | Non-test lines | Depends on | Can run beside |
|---|---|---|---|---|---|---|---|
| 1 | Ask contract block | `forge ask --help` and every command's help; asks refuse "need a cloud-bound project" | `src/blocks/ask/` (manifest, `schemas/*.json`, `defs.json`, `docs.json`, `entry.cts`), `src/assembly/cloud-authority.ts` | 1 | 160-230 | none | 2, 6 |
| 2 | Board engine in `AskMailbox` | Nothing visible; CI shows Board's conformance passing in Forge | `cloud/package.json`, `cloud/bun.lock`, `cloud/patches/`, `cloud/src/ask/board-store.ts`, `cloud/src/ask/mailbox.ts`, `cloud/src/ask/engine.ts`, `cloud/wrangler.example.jsonc` (binding `ASKS`, migration `v5-ask-mailbox`), CI step | 1 | 140-220 | none | 1, 6 |
| 6 | Owner preview entry | A test copy of the cloud can be deployed for you only (question 1) | `cloud/src/preview-entry.ts`, `cloud/wrangler.example.jsonc` comment, `cloud/scripts/preflight.mjs`, `docs/reference/cloud.md` | 1 | 30-60 | none | 1, 2 |
| 3a | Create, show, list | An agent's ask is stored and listed from the terminal | `cloud/src/ask/records.ts`, `cloud/src/project.ts` (forward after token check), `cloud/src/issue-commands.ts` (known ops) | 1 | 180-260 | 1, 2 | 9 |
| 3b | Withdraw and issue mirror | A withdrawn ask closes; asks with an issue show as issue comments | `cloud/src/ask/records.ts`, `cloud/src/ask/outbox.ts` | 1 | 100-150 | 3a | 9, 5a |
| 4 | Answer core | `forge ask answer` from the terminal for ordinary questions; second answers become comments | `cloud/src/ask/answer.ts`, `cloud/src/ask/records.ts` | 1 | 180-260 | 3b | 5a, 9 |
| 5a | Wait socket, server | Nothing visible alone | `cloud/src/ask/socket.ts`, `cloud/src/ask/mailbox.ts`, `cloud/src/worker.ts` (socket route with token check through Project) | 1 | 140-210 | 3a | 3b, 4, 9 |
| 5b | `ask wait` client | Agent waits and wakes; reconnects from its position; returns `pending` plus cursor at its time limit | `src/blocks/ask/entry.cts`, `src/assembly/cloud-state-client.ts` | 1 | 120-180 | 1, 5a | 7 |
| 7 | One ask on the phone | **First try**: open the link from chat, sign in, tap, the agent carries on | `cloud/src/ask-app.ts`, `cloud/src/adapters/workers-oauth/compose.ts` (`/app/ask/*` dispatch), `cloud/src/auth/report-session.ts` (return to ask), `report-session-store.ts` (sign-in time) | 1 | 200-290 | 4, 6 | 5b, 9 |
| 9 | Install and service worker | Forge icon on the home screen; tapping it opens the list | `cloud/src/report-app.ts` (PR B, or this slice if PR B has not merged), `cloud/src/app-assets.ts` (`sw.js` with push and click handlers only, `app.js`) | 1 | 70-130 | 6 (and forge-1672 PR B if open) | 3a to 5a |
| 8 | Grouped list and take-all | Only you, worth a look, safe defaults collapsed with one take-all switch | `cloud/src/ask-app.ts` | 1 | 160-240 | 7 | 10a, 13 |
| 13 | Approvals from the phone | Approve a stopped lane from the phone with a fresh sign-in; the agent resumes without a 10-minute link | `cloud/src/lane-approval.ts`, `cloud/src/ask/answer.ts`, `cloud/src/auth/report-session.ts` (`max_age` step-up) | 1 | 160-260 | 7 | 8, 10a |
| 10a | Push subscription | "Turn on notifications" button; your phone is registered | `cloud/src/ask/push-store.ts`, `cloud/src/ask-app.ts` route, `app-assets.ts` | 1 | 120-170 | 9 | 8, 13 |
| 10b | Push sender, one notification | One notification that updates in place with counts | `cloud/src/ask/push.ts`, `cloud/package.json` | 1 | 150-230 | 10a | 14 |
| 11 | Reminder ladder | Sound at 0, 5, 15, 30 min for stopped work, loud at 30, nothing for the rest | `cloud/src/ask/ladder.ts`, `cloud/src/ask/board-store.ts` (alarm multiplexer) | 1 | 150-220 | 10b, 3a | 14 |
| 12a | Snooze, sleep, back time | Agents see `away` and `backAt`; snoozed you get no sound | `cloud/src/ask/presence.ts`, `ladder.ts`, `records.ts` (reply fields) | 1 | 130-190 | 11 | 14 |
| 12b | Snooze and sleep controls | Snooze buttons and Long row on every ask page; sleep window page | `cloud/src/ask-app.ts` | 1 | 130-190 | 12a, 8 | 14 |
| 14 | Backup and restore | Ask history is in the backup; a restore cancels open asks and drops phone registrations | `cloud/src/ask/export.ts`, `cloud/src/worker.ts` (admin routes under the existing admin token), `docs/reference/cloud.md` | 1 | 150-240 | 4 | 10b to 12b |
| 17 | Agent instructions | Agents use `forge ask` instead of asking in chat; a new session checks answered asks first | `templates/delivery/skills/forge-loop/SKILL.md` and `session.md` (and the canonical `skills/` copy if one exists) | 1 | 30-60 | 5b | any |

**Totals:** 19 PRs, 2,500 to 3,790 non-test lines. If two security slices split at review (most likely 7 and 13), 21 PRs. This sits inside the lead's first-pass estimate of 20 to 25 PRs (forge-1662 comment 24, rung 1).

**Order and lanes (cap 3).** Wave 1: 1, 2, 6. Wave 2: 3a, 9. Wave 3: 3b, 5a, then 4. Wave 4: 5b, 7 (first try). Wave 5: 8, 13, 10a. Wave 6: 10b, then 11, 12a, 12b in order (they share `ladder.ts` and `ask-app.ts`), with 14 and 17 beside them. Slices that touch `records.ts` (3a, 3b, 4, 12a) and `ask-app.ts` (7, 8, 10a, 12b) go in order.

**Each slice ships its never-deferred parts:** server-checked approval (13), one authoritative write (3a, 4), device and session identity (3a, 7), project scope (3a, 5a), size limits (3a, 10a, 12a), truthful result states (every reply names the state it actually reached, for example `answered` with `approval: pending-grant` if the mint is still retrying), backup and restore (14). GitHub merge proof is not touched by this part. Red first through hosted CI for every slice; the review gate is unchanged. Slices 4, 7, 13 and 14 are security tier and get the full Sol gate.

## 8. Left for later (file as issues)

- An answer arriving exactly as the ask expires or is withdrawn: richer handling than the clean `ASK_CLOSED` refusal.
- Two phones answering within the same second: beyond first-wins, show the loser a clear screen.
- An approval whose lane changed between ask and answer (new stop, new epoch): offer a fresh ask from the page instead of a refusal.
- Restart and reconnect test matrix for the socket, the alarm and the outbox (deployed, not local).
- Concurrency test: many waiters and many asks on one mailbox object.
- Real iPhone and Android proof: install, permission, one notification replaced in place, sound at the four steps, loud step, offline then back.
- Deployed cost measure: an hour of idle sockets and 50 asks a day against the free allocation.
- Board upgrade drill: bump from 0.54.0, regenerate the patch, rerun conformance.
- Light mode pass for the phone pages.
- Accessibility pass for the phone pages.
- Docs beyond the command reference (how-to, troubleshooting).
- Durable attachments on asks (screenshots, logs); the first pass takes https links only.
- Passkey confirmation for approvals instead of a fresh Clerk sign-in.
- Snooze choices that adapt to what the owner usually picks (forge-1662 comment 16).
- Local, non-cloud asks for projects that are not cloud-bound.

## 9. Owner steps, in order

1. Answer the five questions at the top, or stay silent for the defaults.
2. After slice 6: give a yes to deploy the owner test copy. The lead deploys it under a new Worker name with its own config file; reverse path is `wrangler delete` of that Worker name, which leaves the closed main Worker untouched. The lead sets the two existing secrets and the new push key secret without printing them.
3. After slice 7: on the phone, open the link an agent sends, sign in with your usual sign-in, tap an answer. Say whether the agent carried on.
4. After slice 9: add Forge to the home screen (iPhone: Share, Add to Home Screen, Open as Web App; Android: menu, Add to Home screen, Install), then sign in from the installed app, since installed apps keep their own cookies (forge-1672 research, rung 1).
5. After slice 10a: tap "Turn on notifications" inside the installed app and allow the prompt.
6. After slice 13: approve one real stopped lane from the phone. Expect a fresh sign-in.
7. After slice 11: let one test ask go unanswered for 30 minutes and say what the phone did at 0, 5, 15 and 30.
8. After slice 12b: set a sleep window or a snooze and confirm nothing sounded inside it.

## 10. Risks and unknowns

| Risk | How to find out | Cost if it goes wrong |
|---|---|---|
| 1 Board patch drift: the hashed files change with every release (about two a day) | Slice 2 CI applies the patch at install; an upgrade drill issue | Each wanted upgrade costs a patch PR; if unworkable, switch to the own mailbox (about 2 PRs) |
| 2 Free plan limits: Board's bundle (about 2 MB, 401 KB gzipped, trial) plus Forge's Worker against the free plan's Worker size limit, and Board's CPU per request against the free per-request CPU limit | Existing production dry-run bundle step in CI prints the size; first deploy of the test copy reads CPU in the dashboard | Bundle over the limit blocks the deploy; CPU over the limit fails requests. Either forces the own-mailbox fallback |
| 3 Web push on iPhone: one notification replaced in place and sound at chosen steps are untested on real phones; web pages cannot request Apple's time-sensitive level (forge-1672 research, rung 1), so the "loud" step may only be a normal alert with `requireInteraction` | Owner steps 5 and 7; the real-phone follow-up issue | The ladder promise has to be reworded, or the loud step waits for telephony or a native app (forge-1764 item 5) |
| 4 Step-up: whether Clerk honours `max_age=300` and returns a fresh `auth_time` | Slice 13 test against the Clerk fixture, then one real approval on the test copy | Without it, approvals fall back to the existing lane approval page with its own Clerk round trip (works today, slower) |
| 5 Long tool calls: block operations declare `timeoutMs` (5,000 to 15,000 in the manifests read) and MCP hosts cut long calls | Slice 5b checks the runtime cap; `ask.wait` returns `pending` plus cursor at its limit so the agent calls again | If the cap is a few seconds, the agent loop calls `ask wait` repeatedly; each call still sleeps on the socket, but more calls cost more requests |
| 6 Socket plus Board log together is not trialed; each half is | Slice 5a test: answer posted while disconnected, then reconnect with cursor; restart with a socket open | A lost wake; the authority-first read in step 7 still returns the answer on the next call, so the worst case is a late wake, not a lost answer |
| 7 Two writers across objects for approvals (Project mints, `AskMailbox` records) | Slice 13 crash test between the two writes | An approved lane approval with no answer row; it expires unused in 10 minutes, and the ask shows `pending-grant` until the retry lands |
| 8 Forge-1672 PR B overlaps slice 9 files | Check its state when slice 9 starts | A merge conflict, one rework PR |

## 11. What I read

Issues (read only, `issue show` and `issue comments`): forge-1761 with comments 1 to 10; forge-1662 with comments 1 to 25; forge-1672 with comments 1 and 2; forge-1658 with comments 1 to 3; forge-1764 (no comments); forge-1784 (no comments); forge-1676 body (to learn why the Worker was closed).

Reports: forge-1662-eval-building-blocks.md, forge-1662-eval-board.md, forge-1761-board-on-do.md, forge-1761-board-slack.md, forge-1761-wait-trial.md, forge-1761-board-copy-audit.md, forge-1672-slice1-design.md, forge-1672-research.md, forge-1658-signin-design-r2.md (sections 0 to 1 only, lines 1 to 90), forge-1662-research-r2.md (Part A lines 38 to 142, plus a keyword scan of the rest), forge-1662-INDEX.md (keyword scan).

Spike glue: forge-1761-board-on-do `prepare.ts`, `storage.ts`, `worker.ts`; forge-1761-board-slack `worker.ts`. Not read: `slack-settings.ts`, `trial-constants.ts`, the drivers; nothing run.

origin/main 34c6c477: `cloud/src/local-only.ts`, `cloud/src/report-http.ts`, `cloud/src/auth/report-session.ts`, `cloud/src/adapters/workers-oauth/report-session-store.ts`, `cloud/src/adapters/workers-oauth/compose.ts` (lines 160 to 240 and 340 to 370), `cloud/src/worker.ts` (lines 1 to 140), `cloud/src/lane-approval.ts` (lines 1 to 120 and a scan of the rest), `cloud/src/lane-commands.ts` (structure scan), `cloud/src/issue-commands.ts` (op list scan), `cloud/src/project.ts` (alarm, lines 360 to 395), `src/assembly/cloud-authority.ts` (lines 70 to 120), `cloud/wrangler.example.jsonc`, `docs/reference/cloud.md` (headings and the lines on v3, routes, device login, owner approval, deploy), `docs/writing-a-block.md` (keyword scan), folder listings of `cloud/src`, `cloud/src/adapters`, `cloud/conformance`, `src/blocks`, `src/ports`, `src/adapters`, `templates/delivery/skills/forge-loop`; block files `src/blocks/agent/forge.block.json`, `src/blocks/agent/schemas/wait.input.json`, and the `lane.resume` entry and context counts of `src/blocks/work/forge.block.json`.

Not read: the untrusted Board and Nightmail clones (the trials' line references were used instead); the forge-1672 PR B code (not merged).

COVERED 10 OF 10
