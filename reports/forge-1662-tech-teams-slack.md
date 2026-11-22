Decisions needed: 5 owner questions below. Each has a default; silence means the default.

1. **After you hand an ask to someone, can you still answer it yourself?**
   A. Yes, both of you can answer and the first answer counts (default).
   B. No, only the person you handed it to.
2. **Who may approve a protected action (publish, merge, deploy, resume a stopped lane) that a teammate's agent asks for?**
   A. Only you, the project owner (default; matches today's server check).
   B. The teammate whose agent asked.
   C. Any member except the teammate whose agent asked.
3. **Who may invite and remove people?**
   A. Only you (default).
   B. Any member.
4. **How does a person link their Slack account to Forge?**
   A. Forge shows them a one-time code and they send it to the Forge bot in Slack (default; no extra Slack sign-in setup).
   B. You type each person's Slack name into Forge by hand.
5. **When does a waiting ask move to the person's backup?**
   A. At the 15 minute reminder (default).
   B. At the 5 minute reminder.
   C. At the 30 minute reminder.

# Teams first pass, team asks, handoff and Slack: technical execution plan

Reading notes: "Board" means the npm package `@vercel/board` pinned at 0.54.0. The brief names the package `board`; both trials import `@vercel/board` (pointed at the line: spike `package.json`, `worker.ts:3`). This plan uses the trial's name.

## In plain words

- Step 1: a second person gets an invite from you, signs in once in a browser, and becomes a member of the shared project. Try it: `forge team invite`, the person opens the link, `forge team list` shows two people.
- Step 2: that person's laptop logs in with the same device login you use today, and the server now accepts any member, not only you. Their agents act under their name.
- Step 3: they claim an issue. The project's cloud authority checks they are a member before the claim lands. Try it: you see "held by <name> since <time>" and `issue ready` no longer offers that issue to you.
- Step 4: you remove a person, or one of their devices. Every device and agent of a removed person stops on its next write. Backup and restore carry the member list and never bring back old access.
- Step 5: every ask says who may answer it. A team of one is just you. The answer records the person who gave it. Only a person signed in on the phone page, or a linked Slack account, can answer; an agent never answers for a person.
- Step 6: each member gets the phone app with their own sign-in, own notifications, own sleep hours and own "since you last looked" marker.
- Step 7: "I am busy, ask this person": one tap hands the ask on. The record shows who handed it and to whom, and the new person's answer then counts.
- Step 8: a backup person. If you do not look by the chosen reminder, the ask moves to your backup before the reminders get louder. Asleep people are skipped.
- Step 9: link Slack. Forge shows a code, you send it to the Forge bot in Slack, and from then on your Slack replies count as you.
- Step 10: Slack delivery. A personal ask arrives as a direct message, a team ask as a channel post that tags the person and shows who it waits on, and a reply in the thread is recorded as the answer. The message edits itself in place when answered or handed on.
- Step 11: protected actions (publish, merge, deploy, resume a stopped lane) never take a Slack reply as the answer. Slack shows an "Open in Forge" button; the answer is given on the signed-in Forge page.
- Shared project memory waits. Notes stay private to each device in this pass.

## How it works

Components and where they run:

| Component | Runs in | Stores |
|---|---|---|
| Forge CLI and MCP tools (`forge team *`, `forge ask *`) | laptop CLI and agent tool | device credential file `~/.forge/cloud/credentials.json` (exists) |
| Worker | Cloudflare Worker | nothing; routes requests |
| Project authority | Durable Object per project (`cloud/src/project.ts`) | issues, claims, tokens, members, invites, membership epoch |
| Mailbox | Durable Object per project running Board's engine (assumption A2) | asks, answers, handoffs, per-person settings, Slack links, Board's Slack thread map |
| Phone page | installable web app served by the Worker (assumption A3) | per-person session cookie, push subscription |
| Slack app | Slack, one app per workspace | bot token and signing secret as Worker secrets |
| Clerk | hosted sign-in | people's accounts; Forge keeps only issuer plus subject |

Assumptions about the phone ask loop plan (`forge-1662-tech-ask-loop.md`, not readable when this was written):

- A1. An ask record exists with a who-may-answer field and an immutable answer record carrying who answered.
- A2. The mailbox is Board's engine inside a Durable Object, one per project, with Forge middleware on writes.
- A3. An owner session on the phone page exists, built like the report session (`cloud/src/auth/report-session.ts`, cookie `__Host-forge_report`).
- A4. Web push exists, with one updating notification per ask, and a reminder ladder at 0, 5, 15 and 30 minutes driven by Durable Object alarms.
- A5. An agent waits on an ask and wakes when its answer is stored.

Where this plan relies on one, it says so with the label.

Main journey (team ask handed off and answered in Slack):

1. **Invite.** The owner runs `forge team invite --role member` on the laptop. The CLI calls the project authority with the owner's device token. The authority checks the caller's person is the owner (question 3), creates an invite with a random code, stores only its hash, expiry 7 days, single use, and returns a link `https://<host>/join#<code>`.
2. **Join.** The new person opens the link on any browser. The Worker serves the join page, which starts Clerk sign-in using the same upstream as device approval (`cloud/src/auth/device-browser.ts`). On the Clerk return, the project authority verifies the identity, maps `(issuer, subject)` to a Forge person through the directory (`team/identity.ts` logic over a SQL store), spends the invite, and adds the member in the same transaction. Membership epoch goes up by one.
3. **Device login.** The new person runs `forge auth login` on their laptop. The device code is approved on `/device` as today, but the server check changes from "is the configured owner" (`device-browser.ts:287`, and the mint recheck at `project-login.ts:253`) to "maps to an active member of this project". The minted `fct_` token row now carries the person id and the membership epoch.
4. **Agent works.** Their agent uses that device token with its session name (existing `session` column). Every typed command reaches the project authority, which reads the token, its person, and checks the member is active and the token epoch is not fenced, with no await between the check and the write (existing pattern: `authorizeToken` comment, `tokens.ts`). Claims record the holder person. `issue show` and `issue list` print the holder's display name.
5. **Ask.** The agent runs `forge ask` (A1) with `answerers: {team: true}` or a list of people, and `route: personal | team`. The CLI sends it to the mailbox with the device token. The mailbox snapshots the allowed set and the current routing target, and refuses an ask that names a non-member.
6. **Deliver.** The mailbox writes the ask as a Board message. Board's Slack sync (`@vercel/board/sync-slack`) sends it. A personal ask goes to the target person's linked Slack user as a direct message (`conversations.open`, then `chat.postMessage`). A team ask goes to the project's configured channel as `chat.postMessage` with `<@U...>` for the routing target and a "waiting on <name>" line. Web push to the target's phone fires in parallel (A4). Proven locally against a fake Slack (ran it, forge-1761 comment 10).
7. **Handoff.** The target taps "Ask someone else" on the phone page, or types `handoff @name` in the Slack thread, or runs `forge ask handoff`. The mailbox checks the actor may answer this ask now (in the allowed set, active member, human session or linked Slack), and the new person is an active member. It appends a handoff record, adds the new person to the allowed set, and moves the routing target. Board edits the Slack message in place (`chat.update`, proven locally) to "waiting on <new name>, handed on by <old name>", and the new person gets a push and, for a personal ask, a direct message.
8. **Answer in Slack.** The new person replies in the Slack thread. Slack signs the event; Board verifies it at `POST /webhooks/slack` (bad signature returns 401, proven locally). Board imports the reply under author `slack:user:<id>`. Forge middleware on the write looks up the Slack link. Linked, in the allowed set, ask open and not protected: the mailbox records the answer with `by: <person>`, `via: slack`, and the Slack user and message ids. Anything else stays a plain thread comment and never becomes the answer.
9. **First answer wins.** The answer write is a compare-and-set on the ask's state. A later reply from anyone becomes a comment. Board edits the root message to "answered by <name>".
10. **Agent resumes.** The waiting agent wakes (A5) and reads the answer with its provenance.
11. **Protected action.** If the ask's kind is publish, merge, deploy or resume, step 6 posts an "Open in Forge" link instead of choices, step 8 records a Slack reply only as a comment, and the answer is accepted only from a phone or web session of a person allowed by question 2. The project authority rechecks that person's membership and role when the agent uses the approval.
12. **Escalation and sleep.** At the chosen reminder step (question 5), if the target has not opened the ask, the mailbox alarm performs an automatic handoff to the target's backup, recorded with `by: <target>`, `via: standing-backup`. A person inside their sleep window gets no push and is skipped for escalation; the ask shows "waiting on <name>, asleep until 07:00".
13. **Removal.** The owner runs `forge team remove <name>`. In one project-authority transaction: member marked removed, epoch bumped, all that person's tokens revoked, their claims released. The authority then pushes the new member list and epoch to the mailbox, which drops that person from every open ask's allowed set.

## What exists already

| Component | What exists on origin/main or in a trial | Rung |
|---|---|---|
| 1. People and membership | `team/identity.ts` (21 lines): `PersonDirectory.bind` maps a verified issuer plus subject to one person id, refuses unverified identities. `team/directory.ts` (114 lines): organizations with owner, admin, member roles, revisioned compare-and-set edits, last-owner protection, in-memory store only. `team/migrations.ts` (42 lines): table descriptions for persons, identity_bindings, organizations, memberships, default_teams. No caller outside tests (searched `team/directory\|team/identity\|OrganizationDirectory` across origin/main: only `test/team/directory.test.ts` and docs). | pointed at the line |
| 1. Membership seam | `src/ports/authorization.ts`: `AuthorizationPort` with authority `single-owner` or `team`; `singleOwnerPolicy` refuses team with `TEAM_AUTHORIZATION_UNAVAILABLE`. `cloud/src/auth/compose.ts` takes an optional `team` port. `cloud/src/worker.ts:246` never passes `team`, and `fct_` tokens skip the policy (`worker.ts:238-243`). | pointed at the line |
| 1. Boundary | `test/structure/team-boundary.integration.test.ts` refuses public imports of the team build output. | pointed at the line |
| 2. Credentials | `cloud/src/tokens.ts`: `fct_` token rows with hash, device, session, agent, harness, expiry, revoked; no person column. `authorizeToken` is synchronous for check-then-write. Revoke by id exists, admin token only. | pointed at the line |
| 2. Owner-only sign-in | `FORGE_OWNER_SUBJECT` checked in `device-browser.ts:287`, `project-login.ts:253` (mint recheck), `lane-approval.ts:104` and `:241`, `report-session.ts` (owner in the session binding), `adapters/workers-oauth/config.ts:41`. `device-login.ts:206` keeps the approving identity on the challenge. | pointed at the line |
| 3. Shared claims | `cloud/src/issue-commands.ts`, `issue-lease.ts`, `lease-command.ts`; ready mode skips leased issues (`issue-list.ts:40`). Standard entry closed (`worker.ts:274` exports `local-only.ts`). | pointed at the line |
| 4. Who may answer | Assumed from the ask loop (A1). Lane resume consumes a server-issued approval id bound to project, device, session (`lane-commands.ts:165-173`). | pointed at the line (lane); said so (ask) |
| 5. Handoff | None found (searched `handoff`, `hand off`, `hand-off` case-insensitive in `cloud/src` and `team` on origin/main: zero hits, rung 1). Board has no answer handoff (eval-board report N3). | said so |
| 6. Escalation, sleep, markers | Assumed per owner from the ask loop (A4). Nothing per person exists. | said so |
| 7. Slack | Trial `.overseer/spikes/forge-1761-board-slack`: Board's sync-slack unchanged in a Durable Object, 20 of 20 signed replies landed and woke a wait, DM by person id, channel post with mention, in-place edit, 401 on bad signature, replay deduplicated; unlinked Slack user refused by middleware. 67 lines of glue. | ran it (locally, fake Slack) |
| 8. Protected actions | Lane resume refuses a relayed quote and consumes only the server approval id (`lane-commands.ts:108-173`). forge-887 records that a relayed chat approval cannot be verified. | pointed at the line |
| 9. Memory | Device notes only; team memory deferred by the phase 1 plan (`plan.md` deferred table). | pointed at the line |
| Recovery | `cloud/src/dump.ts:2`: device tokens never enter a dump. | pointed at the line |

**What is new:** a SQL-backed member store and invites in the project authority; team authorization installed and selected for `fct_` and session requests; person and epoch on tokens; member-aware device approval; remove and revoke commands for people; member list in dump and restore; team fields on asks (allowed set, routing target, route); handoff records; per-person sessions, push subscriptions, settings and markers; standing backup escalation; Slack link records and link-code flow; Slack routing and the answer middleware; protected-kind refusal on non-session channels; a two-person conformance journey.

## Data shapes

Required fields are marked `*`. Unknown fields are refused on every write (JSON schema `additionalProperties: false`).

Person binding (project authority, from `team/migrations.ts` tables):
```json
{ "person*": "per_7f3a", "issuer*": "https://clerk.example", "subject*": "user_2x...", "name*": "Priya" }
```
Refused: unverified identity; a second binding for the same issuer plus subject (returns the existing person); `name` over 64 characters. Email never maps a person.

Member (project authority):
```json
{ "person*": "per_7f3a", "role*": "member", "state*": "active", "addedBy*": "per_owner", "addedAt*": 1795000000000, "epoch*": 4 }
```
`role` is `owner` or `member`. Refused: removing or demoting the last owner; a role change by a non-owner (question 3 default); a stale `epoch`.

Invite (project authority):
```json
{ "id*": "inv_91c2", "codeHash*": "sha256...", "role*": "member", "createdBy*": "per_owner", "expiresAt*": 1795600000000, "spentBy": null }
```
Refused: spent, expired, or more than 20 open invites per project. The code is shown once and never stored.

Device token row (project authority, `domain_cloud_tokens`, two new columns):
```json
{ "id*": "a1b2c3d4e5f60718", "hash*": "...", "device*": "priya-laptop", "session": "claude:lane-3", "person*": "per_7f3a", "epoch*": 4, "expires_at*": 1797600000000, "revoked_at": null }
```
Refused at use: revoked, expired, person not active, `epoch` older than the person's last removal fence. Old owner tokens with `person` null map to the seed owner once, at first use after the migration.

Ask team fields (mailbox, added to A1's ask):
```json
{ "answerers*": { "people": ["per_owner"], "team": false }, "route*": "personal", "target*": "per_owner", "protected*": false, "kind*": "question" }
```
Refused: a non-member in `people`; `target` not in the allowed set; `protected: false` with kind `publish`, `merge`, `deploy` or `resume`; `route: team` with no Slack channel configured is allowed (phone only) and says so in the result.

Answer (mailbox, immutable, from A1 plus provenance):
```json
{ "ask*": "ask_55", "choice*": "B", "text": "ship it", "by*": "per_7f3a", "via*": "slack", "slack": { "team": "T01", "user": "U02", "ts": "1795.0001" }, "session": null, "memberEpoch*": 4, "at*": 1795000300000 }
```
`via` is `phone`, `web` or `slack`. Refused: ask not open; `by` not in the allowed set or not active at `memberEpoch`; `via: slack` on a protected ask; any device-token caller (agents never answer). A second answer becomes a comment, not an error.

Handoff (mailbox, append-only):
```json
{ "ask*": "ask_55", "from*": "per_owner", "to*": "per_7f3a", "by*": "per_owner", "via*": "phone", "reason": "busy", "at*": 1795000100000 }
```
`via` adds `standing-backup` for escalation. Refused: `by` not allowed to answer now; `to` not an active member; ask not open; more than 5 handoffs on one ask.

Person settings (mailbox):
```json
{ "person*": "per_7f3a", "sleep": { "from": "23:00", "to": "07:00", "zone": "Asia/Kolkata" }, "backup": "per_owner", "lastLook": 1288, "push": ["sub_ab12"] }
```
Refused: `backup` equal to self or not a member; set by anyone other than that person.

Slack link (mailbox):
```json
{ "person*": "per_7f3a", "team*": "T01", "user*": "U02", "linkedAt*": 1795000000000, "codeId*": "lnk_3f" }
```
Refused: a Slack user already linked to another person; a link code older than 10 minutes or used. Unlink by the person or the owner.

## Borrow or build

| Component | Choice | Why | If the outside package changes |
|---|---|---|---|
| Person binding and member rules | Adapt `team/identity.ts` and `team/directory.ts` (in repo), add a SQL store implementing `DirectoryStore` | Rules (one person per issuer plus subject, last owner, revision) are written and tested; only storage is missing | none |
| Organizations | Drop for this pass | Phase 1 plan already uses project members only | none |
| Sign-in | Adapt the existing Clerk device-browser flow for join | Same upstream, same state and cookie protections; no second login path | Clerk API change breaks join and device approval together; covered by existing auth fixtures |
| Team authorization | Build `team/authorization.ts` implementing `AuthorizationPort` | Seam exists; logic is a membership lookup | none |
| Mailbox engine | Import `@vercel/board@0.54.0` (A2) | Chosen by the ask loop; Slack comes with it | Two private-file patches and private paths break on upgrade; stay pinned, upgrade only with the conformance kit and Slack trial rerun |
| Slack delivery, replies, edits | Import `@vercel/board/sync-slack` with `@chat-adapter/slack@4.41.1`, `chat@4.41.1`, `@vercel/connect@2.3.4` | Proven unchanged in a Durable Object for 67 lines | Adapter option rename breaks config only; a change to the author id format `slack:user:<id>` breaks the link lookup; pin all four and keep the trial as a regression check |
| Slack link | Build link-code flow on Board's inbound DM import | No Slack sign-in app needed; proves both sides | depends on Board importing DMs; trial proved DM routes |
| Handoff, escalation, sleep, markers | Build as operations of the ask block (manifest gives CLI and MCP) | Board has none; Forge authority | none |
| Push per person | Adapt A4's push sender, keyed by person | Same code, new key | none |
| Protected action gate | Adapt lane approval consumption | Already refuses relays | none |
| Backup and restore | Adapt `cloud/src/dump.ts` paging | Add one table, bump epoch on restore | none |

## Slices

First pass only. Sizes are estimates. Security tier applies to T1 to T5, A1, A5, A6 and A7 (cap 330).

| # | Slice | Owner can see or try | Files or folders | PRs | Non-test lines | Depends on | Can run beside |
|---|---|---|---|---|---|---|---|
| T1 | Members in the project authority (forge-1054 trimmed) | `forge team list` shows you as owner | `team/members.ts`, `team/sql-directory.ts`, `cloud/src/project.ts` (migration), `src/blocks/cloud/` (team.list op) | 1 | 150-230 | owner cloud journey usable | A2 |
| T2 | Invite and join page | invite a second person; they sign in and appear in `forge team list` | `team/invites.ts`, `cloud/src/auth/join.ts`, `src/blocks/cloud/` (team.invite) | 1 | 180-260 | T1 | T5 |
| T3 | Member device approval and person-bound tokens (forge-1055 trimmed) | the second person logs in a laptop; `forge auth whoami` shows their name | `cloud/src/tokens.ts`, `cloud/src/auth/device-browser.ts`, `cloud/src/auth/project-login.ts`, `team/authorization.ts` | 1 | 200-300 | T2 | T5, A1 |
| T4 | Team authority on commands and claims (forge-1056 trimmed, forge-1176 trimmed) | they claim an issue; you see "held by Priya"; a non-member is refused | `cloud/src/worker.ts`, `cloud/src/project.ts`, `cloud/src/issue-commands.ts`, `cloud/src/issue-list.ts` | 1 | 180-280 | T3 | A1, A3 |
| T5 | Remove, revoke, backup (forge-1055, forge-1061 trimmed) | `forge team remove`, `forge team devices`, `forge team revoke`; restore keeps members and fences old tokens | `team/removal.ts`, `cloud/src/dump.ts`, `src/blocks/cloud/` | 1 | 170-280 | T1 | T2, T3 |
| A1 | Who may answer and answer provenance (forge-1763) | asks show "only you" or "the team"; the answer shows who gave it; agent tokens cannot answer | ask block schemas, mailbox middleware, `cloud/src/` membership mirror | 1 | 220-320 | T1, A1 to A5 of ask loop | T3, T4 |
| A2 | Person sessions, push and settings per member | each member signs in on the phone app, sets sleep hours and backup; own "since you last looked" | report or owner session code (A3), push sender (A4), phone page | 1 | 200-300 | T1, ask loop phone session | T1, A1 |
| A3 | Handoff | "Ask someone else" on the phone and `forge ask handoff`; record shows who handed to whom | ask block (handoff op), mailbox, phone page | 1 | 150-230 | A1 | T4, A5 |
| A4 | Escalation to backup and sleep skip | an unanswered ask moves to your backup at the chosen reminder; asleep people skipped | mailbox alarm handler, ask block config template | 1 | 160-260 | A2, A3 | A5 |
| A5 | Slack app and link | create the Slack app from a manifest; link your Slack with a code | `templates/` Slack app manifest, mailbox link store, phone page link screen, Worker secrets doc | 1 | 180-280 | A2 | A3, A4 |
| A6 | Slack delivery and thread answers | personal ask as DM, team ask in channel with tag and waiting-on line, thread reply recorded as answer, edits in place | mailbox Durable Object (mount sync-slack), Slack routing config, answer middleware | 1 | 220-330 | A1, A5 | A4 |
| A7 | Protected actions open Forge | a merge ask in Slack shows "Open in Forge"; a Slack reply does not approve it | ask block kinds, mailbox middleware, `cloud/src/lane-approval.ts`, `cloud/src/lane-commands.ts` | 1 | 150-250 | A1, T3 | A6 |
| J | Two-person journey check | one command replays invite, join, claim race, handoff, Slack answer, protected refusal, removal against fake Slack | `cloud/conformance/team-journey.ts` | 1 | 40-100 | all above | none |

Totals: 13 PRs, 2,200 to 3,420 non-test lines. Teams side (T1 to T5): 5 PRs, 880 to 1,350. Ask and Slack side (A1 to A7, J): 8 PRs, 1,320 to 2,070. Command reference updates in `docs/reference/cloud.md` ride inside each slice.

Order and lanes (cap 3): T1 and A2 first, side by side. Then T2 and T5 beside A1 (A1 needs the ask loop merged). T3 then T4 go in order (shared `project.ts` and `tokens.ts`). A3 beside T4. A4 and A5 side by side. A6 after A5. A7 after A6 because both edit the mailbox middleware. J last. T4, A1 and A7 all touch the mailbox or `project.ts` write path; never run two of those at once.

Nine Teams slices:

| Slice | Pass | What is in, what is out |
|---|---|---|
| forge-1054 membership | In, trimmed | project members (owner, member), installed authorization, removal epoch. Out: organizations, viewer role, org admins |
| forge-1055 credentials | In, trimmed | person and epoch on device tokens, member device approval, remove fences all tokens, revoke one device. Out: narrow agent session exchange, parent-token tree, OS keychain |
| forge-1056 shared commands | In, trimmed | membership check and holder person on existing typed commands and claims. Out: new graph edit forms, cycle-safe concurrent graph edits beyond today's checks |
| forge-1059 approvals | In, trimmed | protected actions need a human session from the person question 2 allows; answers carry the person. Out: versioned team policy, runner attestations, receipt provenance changes |
| forge-1061 migration and recovery | In, trimmed | members in dump and restore, restore bumps epoch so old tokens and approvals grant nothing. Out: personal to team cutover tool, quotas, self-hosted OIDC run |
| forge-1176 team view | Trimmed | holder name on show and list. Out: joinable attempt queue, checkpointed transfer |
| forge-1057 offline cache | Waits | cloud-only reads and writes, as today |
| forge-1058 lane reservations | Waits | two people do not need shared lane capacity |
| forge-1060 shared memory | Waits | see component 9 |

**Component 9, shared memory: not in the first pass.** The success line for this part (an ask handed off and answered in Slack, a second person claiming work) needs no shared notes. Publishing notes adds read permissions on every memory search, show, count and export, plus purge on removal (forge-1060 acceptance), which is a new data exposure surface. Device notes stay private, which is the safe default the phase 1 plan already chose.

## Left for later

- Edge states beyond a clean refusal: tagged person left the team mid-ask, two people answering in the same second on different channels, handoff target asleep with no backup.
- Restart and reconnect test matrix for the mailbox, Slack replay across a Durable Object restart, and membership mirror delivery.
- Proof on real phones: per-person push, one updating notification per person, sleep window silence.
- Proof against a real Slack workspace: scopes, rate limits, private channels, Slack edit not re-alerting a phone.
- Light mode and accessibility passes for the join page, team list and handoff screens.
- Docs beyond the command reference: a team setup guide and a Slack setup guide.
- Viewer role and organizations (forge-1054 rest).
- Narrow agent session exchange and revocation tree (forge-1055 rest).
- Offline cache and proposals (forge-1057).
- Lane reservations across devices (forge-1058).
- Independent approval policy and runner attestations (forge-1059 rest).
- Shared project memory (forge-1060).
- Personal to team cutover, quotas, self-hosted OIDC journey (forge-1061 rest).
- Joinable attempt queue and checkpointed transfer (forge-1176 rest).
- GitHub as an ask channel for teams.
- Slack buttons and a details form (Block Kit) instead of thread replies.
- Verifying relayed chat approvals (forge-887).

## Owner steps

1. Answer the 5 questions above, or stay silent for the defaults.
2. After T2: send an invite to the second person; they sign in with Clerk. If the Clerk instance requires an organization at sign-up, they create or join one first (`docs/reference/cloud.md:409`).
3. After T3: the second person runs `forge auth login` on their laptop and approves the device code themselves in the browser.
4. After T5: try `forge team remove` on a test person and confirm their laptop is refused.
5. After A2: each member installs the phone app, signs in, and allows notifications.
6. Before A5 merges to a deployed cloud: create the Slack app in your workspace from the manifest the slice adds, invite the bot to the team channel, and place the bot token and signing secret as Worker secrets yourself. Free Slack allows this (research r2 part C: 10 custom apps on the free plan).
7. After A5: each member links Slack with the code.
8. Every deploy that opens these routes on the live Worker: give an explicit yes. The standard entry stays closed until the v3 launch (`worker.ts:274`).
9. After A6: hand an ask to a teammate and watch them answer it in Slack.

## Risks and unknowns

| Risk | How to find out | Cost if wrong |
|---|---|---|
| The owner's own cloud journey is not usable yet (standard entry returns 503), so none of this can be tried live until the launch work lands | check the launch issue state before T1 starts | Teams ships as fixture-proven only; owner tries it weeks later |
| Board engine upgrades break the two private-file patches (54 versions in about 4 weeks, forge-1761 comment 9) | pin 0.54.0; rerun both trials before any upgrade | a forced upgrade costs a re-patch and a Slack trial rerun, about one PR |
| Mailbox and project authority are separate objects, so a removed person could answer a non-protected ask in the gap before the member mirror arrives | J measures the gap; protected answers recheck at the project authority | one wrong non-protected answer at removal time; fix is putting the mailbox inside the project object (ask loop decision) |
| A Slack account proves Slack, not Forge; a hijacked Slack account could answer ordinary asks | link requires a Forge sign-in plus a DM; protected kinds never accept Slack | an ordinary answer from the wrong person; protected actions unaffected |
| Slack behaviour never seen live: scopes for DMs and history, retries after the 3 second limit, replay after restart | first real workspace run in owner step 6 | Slack slice slips one PR |
| `team-boundary` test may refuse cloud code importing `team/` | read the test's file scope before T1; install the team port from the team build entry (PR 381) if needed | T1 plus 50 to 80 lines of composition |
| Board's wait keeps the mailbox object awake while agents wait; more people means more waiting hours against 13,000 GB-s a day free (forge-1761 comment 9 arithmetic) | measure GB-s per waiting hour in the ask loop trial | zero spend at risk for busy teams; fallback is Forge's own sleeping mailbox |
| Clerk free tier or organization rules block a second person's sign-up | owner step 2 on a test account | join page slips until Clerk settings change |
| Ask loop plan differs from A1 to A5 | read `forge-1662-tech-ask-loop.md` when written and diff the assumptions | A1, A2 and A6 sizes move up to 100 lines each |

## What I read

- Brief: `.overseer/spikes/forge-1662-tech-plan/BRIEF.md`.
- Issues: forge-1763, forge-1169 and its 2 comments, forge-1054, forge-1055, forge-1056, forge-1057, forge-1058, forge-1059, forge-1060, forge-1061, forge-1176, forge-1761 and comments 7 to 10 (tail, including the Slack trial result), forge-887, forge-1458.
- Reports: `forge-1761-board-slack.md`, `forge-1662-research-r2.md` part C, `forge-1662-board-x-impressions.md`, `forge-1780-inventory-cloud-team.md`, `forge-1662-eval-board.md`, `forge-1662-eval-building-blocks.md`, `.worktrees/briefs/team-scale-design.md`.
- Spike code (read, not run): `forge-1761-board-slack/worker.ts`, `slack-settings.ts`, `trial-constants.ts`, `package.json`.
- origin/main: `docs/work/2026-11-10-teams-phase1/plan.md`, `tasks.md`; `docs/work/2026-11-09-teams-research/options-paper.md` (recommended model section, rest saved but skimmed); `team/directory.ts`, `team/identity.ts`, `team/migrations.ts`; `cloud/src/auth/compose.ts`, `device-browser.ts` (head and lines 270 to 330), `device-login.ts` (head and identity lines), `project-login.ts` (head and lines 235 to 300), `report-session.ts` (head); `cloud/src/tokens.ts`; `cloud/src/worker.ts` lines 225 to 274; `src/ports/authorization.ts`; grep hits in `docs/reference/cloud.md`, `cloud/src/dump.ts`, `cloud/src/issue-list.ts`, `cloud/src/lane-commands.ts`, `test/structure/team-boundary.integration.test.ts`; team commit log.
- Not read: the ask loop plan (not written yet); `forge-1458` code beyond commit 793d828b's title (no `forge-1458` string in code); the full `docs/reference/cloud.md` and `cloud/src/project.ts`.

COVERED 9 OF 9
