Decisions needed: none.

# 1. Verdict in plain words

- Board is a useful example of a shared conversation and task mailbox for people and agents.
- Its ordered event log and position markers give Forge a concrete reconnect pattern.
- Its wait checks earlier events before waiting, so a fast answer can be found if the question's position is supplied.
- Task claims show how to refuse an old worker after its lease expires.
- Typed blocks can validate a question's data, but Forge must define and require its own question fields.
- A task's approval hold is a work status, not proof that an authorized human approved it.
- A named profile can share a person's credential; a displayed name alone is not proof of a person.
- The inspector can post replies, but its deployed handler uses the application's identity and asks visitors for a profile name.
- Local Board stores data on the machine and loses pending timers on restart, so it cannot be the offline laptop mailbox.
- Schedules post messages; the inspected code does not establish a single updating phone notification or per-person reminder receipts.
- The code includes Slack, GitHub and Linear sync patterns, but a secure answer path still needs identity binding and delivery state.
- Build a small Forge mailbox first; borrow cursor, claim fencing, validation and deduplication patterns, and consider a Board adapter later.

# 2. Need by need

Evidence is static source reading, rung 2, at Board commit `a65cb8be4c29d86f61f69b6f427d6429b96324cf`. Verdicts are judgments, not executed proof. Paths below are relative to the Board root.

| Need | Board implementation and reason | Verdict |
| --- | --- | --- |
| N1 | `packages/board/src/server/serve.ts:438-463`, `server/schemas.ts:62-85`: validates registered typed blocks, but does not make Forge's ask schema mandatory. | adopt the pattern |
| N2 | `src/client/client.ts:890-944`, `src/server/feed.ts:560-593` under `packages/board`: cursors, stream reconnection and backlog-first long polling. Persist the cursor in Forge. | adopt the pattern |
| N3 | `packages/board/src/server/serve.ts:279-287`, `src/inspect/handler.ts:24-30,45-59`: principal and profile are distinct; visitor-chosen profiles are not verified people. Per-ask authorization and handoff need Forge rules. | adopt the pattern |
| N4 | `packages/board/src/server/schedules.ts:203-215,267`: schedules posts, not demonstrated phone delivery state or updates. Forge needs its own timer and delivery model. | not useful |
| N5 | `packages/board/src/server/local.ts:57-63`: local storage and timers require the running process. A remote service is needed for offline devices. | not useful |
| N6 | `packages/board/src/server/local.ts:1-10,57-63`: local implementation uses Node, SQLite and local timers, not a demonstrated Workers/DO deployment. Free allocation fit is unmeasured. | not useful |
| N7 | `packages/board/src/sync/engine.ts:350-362,592-617,1146-1160`: external threads and authors are mapped and echoes suppressed; per-person reminder state remains Forge work. | adopt the pattern |
| N8 | `LICENSE:1-4`, `packages/board/package.json:5`, `.github/workflows/check.yml:1-22`: Apache-2.0 permits reuse subject to its terms; young project and untested compatibility make a dependency premature. | adopt the pattern |

# 3. Under the hood

All references below are to the recorded commit, not the hosted service. `src/` and `test/` mean `packages/board/src/` and `packages/board/test/`.

## 1. Event log

Files read: `src/server/feed.ts:108-110,339-351,479-491,560-593`; `src/store/sql.ts:216-216,359-359`. Local event IDs are decimal log indexes. A feed emits an event cursor derived from that index. A poll reads after the saved index and advances the cursor over examined events, including filtered-out ones; this avoids rescanning. Omitting `after` starts at the current head. Retention and hosted cursor behavior were not independently established.

## 2. Wait and tail

Files read: `src/client/client.ts:890-944`; `src/server/feed.ts:560-593`; `src/server/tails.ts:4-9,18-19,39-57`; `src/api/routes.ts:148-148`. `wait` uses repeated long polls up to 25 seconds each, default overall timeout 30 minutes, and returns the first match or null. The server first reads the backlog, then waits on a stream for a new event. Give the question's cursor as `after` to see a reply already written; without it wait starts at now. `events()` uses server-sent events, reconnects from the last received event ID and backs off from 500 ms to 30 seconds on failures. `tails.ts` is the server watcher tail, also using 25-second long polls. The wait method itself does not show an explicit retry on failed requests; callers must handle errors and persist their own position across process restarts. No live gap test was run.

## 3. Tasks

Files read: `src/server/tasks.ts:18-30,63-79,133-157,247-297,659-706,710-757`; `src/api/routes.ts:250-250`; `test/tasks.test.ts:92-96,295-310,387-414`. The task states include waiting, ready, claimed, blocked, completed, failed and canceled. A claim increments an epoch and returns a random token and expiry; the log stores its SHA-256 hash. Each fenced operation checks claimed state, matching epoch, unexpired lease and token hash, returning 409 `claim_lost` if stale. Renewal checks the proof, extends the expiry and arms a timer. This snapshot defaults to 900 seconds and allows 30 to 3600 seconds, unlike the earlier documentation report's five-minute statement; hosted behavior remains unverified. Blocking a claimed task requires its proof and ends the claim; the kind can say `awaiting_approval`, but it is a label on the hold. Unblock requires owner or management authority and returns it to ready or dependency-waiting; it does not authenticate an answer.

## 4. Typed data

Files read: `src/server/schemas.ts:11-23,39-85`; `src/server/serve.ts:438-463`; `src/conformance/index.ts:2077-2079`. Registry keys are name and version. The first registered definition wins; a changed definition or description returns 409 `schema_immutable`, while identical registration is idempotent. The server checks block data against the registered schema on writes; a bad block returns HTTP 400 `invalid_block` with a reason. Forge must require its block and specify its own required fields; merely registering a schema does not require every post to use it.

## 5. Access and identity

Files read: `src/server/access.ts:47-71,89-114`; `src/server/grants.ts:43-56,109-154`; `src/server/auth.ts:33-63,580-603,645-650`; `src/server/serve.ts:279-287,340-340,394-426,618-619`; `src/inspect/handler.ts:24-30,45-59`. Exact channel wins over longest matching subtree, then wildcard. At the winning pattern, principal outranks group, then everyone, with ties combined. A principal represents the authenticated credential; a profile is attribution under that principal, not a separately authenticated person. Server writes use the caller's resolved principal and actor. Imported external actors may be names under the importer, whose word the attribution is. The handler trusts its configured authentication and sync boundaries; it cannot prove the physical human behind a shared credential. Inspector visitors choose a profile and use the app's board handle. This does not establish an authorized answer or handoff policy.

## 6. Watchers and schedules

Files read: `src/server/registrant.ts:6-7,48-49,72-85`; `src/server/watch.ts:57-67,161-201,206-227`; `src/server/registered.ts:8-18,56-64,137-150,164-211,216-245`; `src/server/watch-run.ts:26-41`; `src/server/schedules.ts:26-31,203-215,227-227,267-267,419-425`; `src/server/local.ts:57-63`. A deployment registers filters and a wake location; matching stored events generate deterministic watcher/event IDs and queue entries. Queues lease the oldest item per watcher/thread, acknowledge or retry with exponential delay capped at 30 seconds, and eventually give up; own watcher writes do not normally wake itself, except scheduled sends. Scheduled posts arm timers and use stable IDs on retries. Repeats are at least one minute and at most a year ahead; long delays use hops. Local timers run only in process and pending timers are lost on restart. The public registrant describes Vercel's API matching and waking a deployment, but I did not inspect Vercel's hosted implementation, exact delivery guarantees, all retry limits or billing.

## 7. Local backend and compatibility

Files read: `src/server/local.ts:1-27,57-104`; `src/store/sql.ts:31-87,216-216,359-359`; `src/scheduler/local.ts:25-61`; `test/conformance.test.ts:162-186,324-339,604-621`. One SQLite file per board holds projected positions, messages, versions, search terms, sync threads and external mappings; attachments are files beside it. Its backend exposes the protocol methods and supports local schedules/watchers while running. Restart drops pending timers; it is explicitly unsuitable for serverless. Hosted storage, queues, wakeups and exact feature parity cannot be inferred from this source. A third-party server can target the client protocol and use the conformance kit, which tests many behaviors and reports skipped checks; passing it would be useful evidence, not proof of complete equivalence or production safety.

## 8. Inspector

Files read: `src/inspect/handler.ts:24-30,39-83,89-105`; `src/inspect/server.ts:41-81,151-151`; `src/inspect/app/composer.tsx:51-51,123-123`; file inventory includes `src/inspect/app/feed.tsx`, `tasks.tsx`, `schemas.tsx` and `grants.tsx`. The UI has a composer and can post via the proxy, so a person can reply. The deployed handler serves a page token and checks origin for writes, then acts with the configured board handle under a visitor-selected profile. These are origin protections, not visitor authentication; deployment needs its own access control and verified person identity for approvals. I did not audit all UI views or external proxy configuration.

## 9. Sync adapters

Files read: `src/sync/chat-provider.ts:115-119,132-158`; `src/sync/slack.ts:824-827,880-894`; `src/sync/github.ts:14-29,93-102`; `src/sync/linear.ts:29-47,300-311,475-475`; `src/sync/engine.ts:164-173,350-362,545-556,592-617,1049-1059,1146-1160`. Slack maps a channel and root timestamp to a thread; GitHub names user IDs and issue/PR context; Linear maps issue and comment events and names users. The engine prefixes external identities by integration key, finds the mapped thread/root, and queues incoming event IDs for deduplication. `noSync` and origin checks stop sending a message back to its origin. These mappings are attribution from the integration, not proof of Forge authorization; webhook verification and all provider edge cases were not audited.

## 10. Tests and CI

Files read: `test/tasks.test.ts:295-310,387-414,828-852`; `test/conformance.test.ts:162-186,324-339,604-621`; `.github/workflows/check.yml:1-22`, `release.yml:76-77`. Tests include a concurrent claim race, stale token/epoch refusal, schema immutability, compatibility and simulated interleavings. The check workflow describes build, typecheck and tests on PRs and main; release also invokes typecheck and tests. These are test cases and configuration found in source, not evidence they passed here or in the hosted service. No untrusted code was executed.

# 4. Build on it or build our own

1. **Run local Board as mailbox:** its existing protocol, SQLite and task engine are useful for offline development, but an off laptop cannot accept answers and pending local timers disappear on restart. Poor fit for N4 and N5.
2. **Build a Board-compatible Worker:** cursor and conformance contracts offer interoperability, but Board's broad surface includes grants, streams, tasks, sync and watcher behavior that Forge would have to reproduce and operate. Workers compatibility, quotas and cost remain untested.
3. **Build a small Forge mailbox and add an adapter later:** implement only validated asks, authenticated answer and handoff, durable cursor, delivery state and timers; keep Board mapping at the boundary. This best matches the inspected code and requested scope. This is a design judgment, not a demonstrated cheaper build.

# 5. Proof we could run

- Send 10,000 numbered events, disconnect at random points, then resume from a persisted cursor. Measure omissions, duplicates and p95 recovery time. Target zero omissions and explainable deduplicated repeats; any missing accepted answer changes the design.
- Race 100 clients to answer one request, including expired and wrong-person attempts. Measure accepted answers and stale/wrong-person successes. Target exactly one authorized result and zero unauthorized successes; a violation blocks release.
- With a device offline, schedule the 0, 5, 15 and 30 minute reminders and restart the service between them. Measure actual delay, number of visible notifications and per-person receipt state. Target one updated notification and four correctly recorded attempts; platform inability to update it would change the channel or requirement.
- Exercise expected monthly volume on a Workers/DO prototype, including idle and reconnect traffic. Measure requests, duration, storage and timer use against the then-current free allocation and spend. Any paid requirement or quota overrun changes the zero-cost design assumption.

# 6. Limits

Read the prior report's sections 2 and 4 before this audit. The clone is a shallow default-branch snapshot. GitHub API reported default branch `main`, Apache-2.0, 179 stars, 18 open issues, created 2026-10-01, and not archived at query time. Both root and package LICENSE files start with Apache License 2.0; a repository-wide `package.json` license-field search found one field, `packages/board/package.json:5`, Apache-2.0. License reuse is subject to Apache-2.0 conditions, including notices; this is not a legal opinion. Youth is a judgment based on the creation date, not a reliability measurement.

The first targeted search using shell brace expansion failed because PowerShell does not support that syntax; equivalent searches were rerun with explicit paths. No dependencies were installed, no scripts or tests executed, and no live hosted service, phone, Workers quota, billing, authorization, delivery or runtime behavior verified. I did not read the entire repository, every provider verification path, all scheduler retry limits, or hosted server internals. Missing implementation details above are explicitly unverified, rather than assumed absent. The report is written locally; its findings remain rung 2.

COVERED 10 OF 10
