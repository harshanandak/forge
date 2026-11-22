Decisions needed: approve the consolidation boundary, notification routing, and decision-page policy. All three channels are in scope.

- Build one request core for GitHub Mobile, Telegram, and Slack, keeping the question, options, evidence, and accepted answer with the work item.
- Use pending, answered, denied, expired, and canceled as the public request states.
- Offer one `forge issue wait <id> --request <request>` command with a durable cursor.
- Merge the local owner-ask batch and bound-lane ask into that core.
- Keep claims, dependency checks, lane execution records, and protected approvals in their present authority roles.
- Keep shared resume behind Forge owner sign-in and its transactional approval consumer.
- GitHub Mobile can deliver direct-mention pushes; use a private decision-inbox repository and Forge links. [GitHub Mobile][Gmobile]
- GitHub environment reviewers work on Mobile, but private-repository required reviewers need Enterprise. [Mobile deployments][Gmobiledeploy] [Environment limits][Genv]
- GitHub comment replies are the best optional native answer route; reactions and synthetic deployment approvals add friction.
- Slack is the team route: issue threads, choice buttons, a details modal, and explicit member mapping.
- Telegram is a thin personal route: private bot chat, bound choice callbacks, replies, and the same Forge page.
- Send one notice and at most one reminder per request, sharing Forge's existing project alarm.
- Generate temporary HTML from a fixed Forge template and agent-supplied data, with the form outside untrusted content.
- Put diagrams, diffs, tables, charts, evidence, consequences, and a deadline into that page when useful.
- MCP elicitation can reuse the request; MCP Apps can later reuse its renderer in supported hosts.
- Borrow immutable answer snapshots from Linear and request-scoped interactions from the protocol examples.
- Leave remote-runner selection to the separate lane; an answer event never grants a lease or dispatch permission.
- Evidence is rung 2, source and documentation only. Sizes are estimates. No implementation or live delivery is verified.

# Forge decisions away from the laptop, research round 2

Research for forge-1662. Date: 20 November 2026. The added channel and visual-page scope is included.

## Basis and limits

I read the three requested reports first: [Board research](/E:/Personal-Projects/forge-new/.overseer/reports/forge-1662-board-research.md), [simplification audit](/E:/Personal-Projects/forge-new/.overseer/reports/forge-1662-forge-simplify-audit.md), and [lead direction](/E:/Personal-Projects/forge-new/.overseer/reports/forge-1662-way-forward.md). Round 1 is orientation, not proof for this report's new claims.

All code citations below refer to `origin/main` (93c1db8fa1a340846fd7abd77d25c96bc86aa456), read with `git show`, `git grep`, and `git ls-tree` in `E:/Personal-Projects/forge-new`. The ref was not fetched or changed. Immutable GitHub links identify that exact source. This does not establish the deployed version, installed App grants, repository visibility, phone configuration, or live team membership.

Evidence rung 2 throughout: lines and primary documentation. No tests, builds, runtime probes, browser sessions, forks, subagents, commits, issue mutations, or credential reads. The only requested write is this report. Safety proposals below have not been exercised. “Proposed” commands are designs, not available commands. Implementation sizes count non-test lines, including schemas and command metadata. They are planning ranges, not measured diffs or promises of labor time.

The missing checkout-local `loop` skill was not installed, because this task forbids repository changes. I read the tracked delivery `forge-loop` instead. It states that Forge does not watch and the harness wakes the agent. [templates/delivery/skills/forge-loop/SKILL.md:9][Floop]

## Part A. Streamline what Forge already has

### Inventory and overlap count

There are nine requested patterns. The table counts distinct mechanisms with a relevant job, including derived views. It does not equate all of them with duplicate code. For example, a lease and a dispatch permit must remain different. Local/cloud implementations of one operation count as one mechanism unless their stored model or public behavior differs.

| Board pattern | Existing Forge mechanisms, exact commands and source | Count | Where overlap matters |
| --- | --- | ---: | --- |
| Conversation on the work item | Plain comments: `issue comment`, `issue comments`. Structured call/checkpoint comments: `issue call`, `issue checkpoint`, `issue resume`. Lane action journal: `lane next`, `lane record`, `lane status`. Queued owner asks and replies: `lane record` with `ownerChannel`, `reply`, or `request`. Attempt notes: `attempt note`. [work/entry.cts:6770][Fcomments] [work/README.md:35][Fwork] [work/entry.cts:3200][Fasks] [work/forge.block.json:597][Fworkmanifest] | 5 | The first two already share comment storage. Asking has spread into two more stores. Attempt notes belong to optional competing work. |
| Claim with lease | Issue lease: `issue claim`, `renew`, `release`. Attempt lease: `attempt reserve`, `release`. Collaborative participant leases: `issue invite`, `join`, `leave`. Generic state/raw cloud lease engine under the typed commands. [work/README.md:15][Fwork] [work/README.md:102][Fparticipants] [cloud/issue-claim.ts:61][Fclaim] [cloud/issue-lease.ts:59][Frenew] | 4 | Three subject types share a lease engine. The raw route is transport plumbing, not an alternative issue claim. Bound lanes hold a copy of the grant, not a second valid claim. |
| Dependencies | `issue dep` writes `dependsOn`; `issue ready`, `blocked`, `board`, `tree`, `lint`, and claim preflight derive from the graph. Parent edges organize epics separately. [work/entry.cts:817][Fgraph] [work/README.md:59][Fdeps] [cloud/issue-list.ts:40][Flist] | 2 | Dependency and parent are different relations. Read views are not separate dependency authorities. |
| Status and waiting | Issue `open/closed`; derived ready/blocked/stale; local owner-ask states; bound progress `pending/ask/answer`; shared approval states; lane stop/control epochs; local freeze. [schemas/tracker.json:11][Fstatus] [work/entry.cts:3220][Faskshape] [bound-lane-state.ts:20][Fboundstate] [cloud/lane-approval.ts:28][Fapprovalshape] [work/lane-control.ts:1][Fcontrol] [work/entry.cts:4184][Ffreeze] | 7 | Human waiting is duplicated in local asks, bound asks, and the presentation of approval requests. Stop, freeze, and issue completion must retain their meanings. |
| Typed message data | Tracker/comment contracts; call/checkpoint payloads inside comments; local `Ask`/`Gate` structures; bound result JSON with a checked progress shape; memory decision records. [schemas/tracker.json:243][Fcommentshape] [work/entry.cts:6824][Fcheckpoint] [work/entry.cts:3214][Fgateshape] [bound-lane.ts:337][Fboundrecord] [memory/index.cts:3130][Fdecision] | 5 | These are fixed application types. Forge does not need Board's general user-registered schema service for one question/answer format. |
| Watch or wake on event | `agent wait` chooses T3, Monitor, or foreground `gh pr checks`; the `watch-block` value also exists in adapter schema but falls through to gh behavior in the handler. `issue events` and state history read accepted events. Lane `next` returns `wait` or `pause` rather than subscribing. [agent/entry.cts:81][Fwait] [agent/schemas/adapter.json:6][Fadapter] [work/entry.cts:6914][Fevents] [loop/watching.md:3][Fwatching] | 3 | Three categories, with three operational PR delivery branches inside the first. Event history is storage. A wait action is workflow output. Neither is a durable agent wake subscription. |
| Scheduled follow-ups | Local owner routing offers a new numbered batch after a 30-minute window when invoked again. Cloud project alarm already wakes receipt maintenance. [work/entry.cts:3200][Fasks] [work/README.md:96][Fowner] [cloud/project.ts:334][Falarm] | 2 | The first is a repeated ask throttle, not an autonomous reminder. The second is real scheduling plumbing, currently for maintenance. Use it rather than a second project scheduler. |
| Owner asks and approvals | Local batched owner channel; bound journal `ask/answer`; generic runtime `APPROVAL_REQUIRED` with a relayed quote; shared browser approval with server-checked identity. Attended terminal consent and the narrow unattended admission policy are entry paths into runtime trust, not phone identity. [work/entry.cts:3486][Fownerroute] [bound-lane.ts:366][Fboundanswer] [assembly/approval.ts:45][Frelay] [cloud/auth/lane-browser.ts:110][Fbrowser] [assembly/approval.ts:164][Fattended] | 4 | Ordinary question collection is duplicated. Consent collection can share a UI model, while proof strength and exact action consumers stay distinct. |
| Memory and decisions | `memory add/search/show` and rule/proposal review; `decision propose/adopt/list`; issue comments/checkpoints containing task-specific choices. [memory/forge.block.json:11][Fmemorymanifest] [memory/index.cts:3130][Fdecision] [work/entry.cts:6824][Fcheckpoint] | 3 | A task answer should not become a standing rule automatically. Existing `decision.*` means durable adopted decisions, not a temporary inbox. |
| Total pattern-to-mechanism incidences | The same mechanism appears in more than one row. | 35 | 26 incidences beyond one per pattern. This is an overlap inventory, not 26 deletions. |

The strongest consolidation target is **three stores for a human question**: local `autopilot-ask`, bound progress `ask`, and runtime approval-request presentation. Only the first two can be retired as independent question authorities. Shared approval proof is a distinct security record.

The historical shepherd is not the current PR watcher in this ref. The tracked loop says the harness wakes the agent; current `agent.wait` returns instructions. Searches covered `shepherd`, watch, wait, subscribe, webhook, notify, alarm, and event terms across current source and delivery skills. I found receipt and OAuth alarms, but no current decision notification adapter in that searched path. That is a bounded static finding, not a runtime absence claim. [forge-loop/SKILL.md:26][Floop] [agent/entry.cts:81][Fwait] [cloud/project.ts:334][Falarm]

### One winner per pattern

All commands in the “after” column are proposals unless marked keep. Do not add a new top-level `decision request` family. Preserve `decision propose/adopt/list` for standing decisions.

| Pattern | One streamlined mechanism and winner | Before → after | Merge/remove and rough lines added / removed |
| --- | --- | --- | --- |
| Conversation | The issue timeline wins. Add typed request and answer events beside existing comments. Views render them as conversation. | `issue comment`, checkpoint comment, ask in `lane record`, answer in journal → `issue ask <id> --input <brief>` and `issue comments <id>` including request/answer entries. Keep plain comment. | Reuse append numbering, actor/time and receipted writes. Retire ask-body copies from journals. +120-220 / -40-90. |
| Claim | The existing state lease engine wins. A lane references its issue grant. | Keep `issue claim/renew/release`. Attempts and participants remain optional commands. | No new question lease. Preserve cleanup reservations. Normalize internal adapters and docs only. +0-40 / -0-60. No deletion of fences. |
| Dependencies | `dependsOn` wins for prerequisites. Parent remains grouping. | Keep `issue dep`, `ready`, `blocked`. Waiting for a person becomes a request projection in ready/claim admission. | Do not make fake blocker issues for every question. Add explicit unresolved request check. +60-100 / -0-20. |
| Waiting states | One request lifecycle wins for human waiting. Lane status derives `waitingOn` from it. | `queued/sent/held/done`, bound `ask.answer`, approval-status prose → public five-state request and `issue show` with `waitingOn`. | Keep approval internals `approved/stale/spent` and lane stop/freeze separate. +100-160 / -100-180. |
| Typed data | One fixed `QuestionV1`/`AnswerV1` schema wins. | Free text plus several inline JSON shapes → one brief and one answer validator for CLI, MCP, page, and adapters. | Remove bespoke batched `1A 2B` parsing after migration. No schema registry. +100-150 / -70-130. |
| Wake | A cursor-based `issue wait` wins for answers. Existing harness PR watcher wins for PRs. | `lane next` again, comments read again, manual quote relay → `issue wait <id> --request <request> --after <cursor>`. | Retire owner-channel session monopolization. Add a narrow subscription, not general topic watchers. +180-280 / -60-120. PR fallbacks stay until capability proven. |
| Follow-up | The existing project alarm wins. One bounded due item per request. | Repeated numbered owner message every 30 minutes → one notice, one reminder, then visible expiry/hold. | Combine receipt maintenance and decision deadlines under the earliest due alarm. +70-120 / -40-80. |
| Owner ask | The common request wins for collection. The existing cloud approval consumer wins for protected action. | `ownerChannel`, `reply/source`, `request/replaces`, bound `ask/answer` → `issue ask`; mapped answer through page/channel; protected `lane resume --approval <id>` stays. | Replace local owner routing and bound ask bookkeeping with request references. Do not merge local quote trust into browser authentication. +80-140 / -300-480. |
| Memory | Issue answer is the evidence. Memory/standing decision is explicit promotion. | Retype answer as comment, proposal and memory → accepted answer links to optional `decision propose`, then existing `adopt`; device `memory add` for lessons. | Add provenance/source-request reference. Do not auto-adopt or build cloud memory sync here. +30-60 / -0-30. |

Total order of magnitude for this consolidation: **+740-1,270 / -610-1,190 non-test lines**. These row ranges describe allocation of one implementation, not independent libraries to add. Net could be -450 to +660. Core UI and channel adapters are additional and listed later. Keep a compatibility reader and short-lived aliases for old records. Removal follows migration and caller review.

Deletion anchors are real spans, not assumed savings. Local owner routing occupies much of `entry.cts:3200-4071` (872 lines). Bound progress is `bound-lane.ts:287-422` (136 lines), of which only ask handling overlaps. The entire 437-line runtime approval module is not disposable. Cloud approval (235 lines) and browser flow (432 lines) protect another boundary. [work/entry.cts:3200][Fasks] [bound-lane.ts:287][Fboundprogress] [assembly/approval.ts:1][Fapproval] [cloud/lane-approval.ts:1][Fcloudapproval] [cloud/auth/lane-browser.ts:1][Fbrowserall]

### Concrete decision core

This is the proposed contract. It extends the issue authority with bounded communication. It does not move the lane journal into the cloud.

```text
QuestionV1
  id, version=1, project, issue, optional lane
  requester: device + session + agent/run reference
  kind: question | protected-action
  brief: title, what, whyNow, options[{key,label,consequence}], default
  evidence[{label,url,commitOrRevision}], optional visual data
  answerSchema: small fixed subset for choice/text/number/boolean/date
  binding: briefDigest, issueRevision, optional head, operationDigest,
           optional controlIncarnation + controlEpoch, designated responder(s)
  createdAt, expiresAt, remindAt, reminderUsed
  state: pending | answered | denied | expired | canceled
  answer?, sequence, optional approvalRequestReference

AnswerV1
  request, briefDigest, choice?, fields?, comment?, outcome
  actor: Forge principal + platform + stable platform subject
  evidence: delivery/message/review id + receivedAt
  acceptedAt, sequence

Delivery
  request + channel + destination + external message id
  phase: initial | reminder | terminal-update
  state: pending | sent | failed | uncertain
```

Use `forge/work` records and the existing project transaction/receipt path. A typed request is not a text comment that an agent later interprets as authority. The same transaction appends a readable timeline projection. Existing cloud comments accept exactly `{id, body}` today. Extending that schema and cloud handler is required; smuggling JSON into `body` would evade typed admission. [cloud/issue-comment.ts:26][Fcloudcomment] [cloud/command-write.ts:62][Fcommandwrite]

1. Agent calls proposed `issue ask`. A required work claim, if applicable, and project are checked. The client idempotency key plus brief digest returns the same request on retry. A changed brief creates a new request and cancels the old one. A question has no authority to change its own protected operation.
2. Authority stores request, accepted event, readable timeline entry and outbound delivery intent atomically. Message posting happens after commit. Delivery failure does not lose the question or change its answer state.
3. Proposed `issue wait` reads the request first. If terminal, return immediately. If pending, register against its accepted sequence, then reread before blocking. This closes the answer-before-subscribe race. A WebSocket subscription can use the existing Worker/project authority, with a bounded reconnect and replay cursor. Cloudflare documents hibernating WebSockets, but Forge needs new handlers and client wiring. [Cloudflare WebSockets][CFws]
4. An adapter authenticates its delivery and produces a normalized answer candidate. Only the core checks responder authorization, exact request, digest, head/revision, deadline and `pending` state. Accept once with compare-and-swap. Repeated delivery of that answer returns its prior result. A conflicting answer gets the already-accepted answer, never a last-writer-wins replacement.
5. The committed answer event wakes the subscribed process or a registered harness continuation. A dead terminal is not resurrected by a WebSocket. Persisted answers remain readable after restart. No bespoke harness wake API has been proved here; the remote-runner lane must supply that integration contract.
6. Before action, the runner rechecks current issue ownership, generation, head and control. An expired or released claim must be reacquired. An answer does not renew it. A protected answer references a separate current Forge approval; the existing consumer spends it with the protected mutation.

One-time use has two meanings. The core accepts one terminal answer. A protected operation also consumes its own approval once. Reading an answer through `issue wait` must not consume it, since reconnects need readback. Reserve a continuation receipt keyed by request, accepted answer sequence and operation digest before dispatch. Repeated wakes reconcile that receipt and the existing dispatch result. They do not launch another action. A crash between an arbitrary external effect and its receipt still needs that effect's own idempotency or reconciliation. Do not describe this design as universal exactly-once execution.

Recovery must preserve the same boundary. Export compact settled question/answer history as evidence. On restore or project incarnation change, cancel pending requests, discard delivery/wake credentials, and require fresh protected approval. Do not replay old outbox entries into three phone apps. Extending typed work records means updating dump/import validation and capacity accounting too. These are new implementation obligations, not verified existing request behavior. The current approval model already binds incarnation/epoch and checks expiry. [cloud/lane-approval.ts:45][Fapprovalstatus]

Proposed minimal public verbs: `issue ask`, `issue answer`, `issue wait`, `issue cancel-ask`, and request readback through `issue show/comments`. Channels and browser use the same answer operation internally. Local mode stores the same types locally. Cloud-bound mode writes only to the project authority. Do not use the unwired generic shared-record provider as an excuse to add a second writer. [assembly/cloud-record-state.ts:24][Frecordstate] [assembly/cloud-authority.ts:48][Fauthority]

State rules:

| Event | Result |
| --- | --- |
| Valid selected answer or completed form | `pending → answered` |
| Explicit rejection of requested consent | `pending → denied` |
| Deadline reached | `pending → expired`; hold the work |
| Requester cancels, brief replaced, issue closes, or bound context invalidates | `pending → canceled`, with reason |
| A user merely dismisses a modal or closes a page | Stay pending |
| Late answer, old page, stale head, changed epoch, replay | Refuse or show the existing terminal state |

“Default” recommends a choice. It does not mean silence approves. A request may explicitly offer “hold”; record that as an answered choice whose consequence is continued hold. Do not add an ambiguous sixth waiting state. Block new ordinary claims for an issue waiting on a human unless the request explicitly says it is advisory. Otherwise a lease expiring while the owner is away can invite another agent to repeat the blocked work.

One reminder is shared across channels. Proposal: ordinary deadline 24 hours, reminder after 2 hours, pending cap 20 per project and 1 blocking request per issue/lane. Protected approval remains its current 10-minute authorization. A long-lived question page can offer the owner a fresh protected request after checking that the underlying action is still current. It must never silently extend an old grant. All values here except the existing 10-minute approval are proposed defaults. [cloud/lane-approval.ts:204][Fapprovalttl]

Forge's project already owns an alarm for receipt maintenance. Multiplex `min(receipt deadline, next delivery retry, reminder, expiry)`. Never let a notification overwrite maintenance scheduling. Cloudflare supports one alarm per object, at-least-once execution, and retries. The handler must re-read request state and a durable reminder marker. [cloud/project.ts:334][Falarm] [Cloudflare alarms][CFalarm]

One logical reminder is achievable. Exactly one visible external message across a crash is not generally provable from these APIs. A POST can succeed before its response is lost. Keep `uncertain` delivery visible; reconcile provider state where possible and avoid blind retries that spam. Core answer and action idempotency must remain correct even when a notice duplicates.

## Part B. Decisions through GitHub, concretely

### B1. A private comment that opens Forge

Recommend B1 as GitHub's first implementation. The owner receives a normal mention and follows the Forge link. GitHub Mobile documents direct-mention pushes and issue/PR collaboration. That establishes the product route, not delivery on this owner's phone. [GitHub Mobile][Gmobile]

**Where it goes.** Proposed default: one new private repository, `harshanandak/forge-decisions`, with one GitHub issue per Forge issue that has questions. Example title: `Forge: forge-1662, decisions`. Store the numeric GitHub repository id and issue number in project notification settings. Create it once, then post one comment per request there. The Forge issue remains the work authority; the GitHub issue is only its notification thread. Creating/commenting on issues is supported by GitHub's issue APIs. [Issues API][Gissues] [Issue comments API][Gcomments]

Neither that private repository nor a GitHub issue numbered 1662 is verified to exist. Do not confuse Forge's id with GitHub's issue number. Do not send private briefs to the public source repository by fallback. If the work already has a private PR and the intended recipients have access, an explicitly configured PR comment may replace the inbox target. PR conversation comments use the issue-comment API. [Issue comments API][Gcomments]

Example proposed comment:

```text
@owner-login Forge needs one decision: keep the old API for one release?
Why now: the implementation is ready; compatibility is the remaining choice.
A Keep it for one release. More code now, fewer client changes. Recommended.
B Remove it now. Smaller change, breaking upgrade for clients.
Default: A. No reply keeps this request waiting.
Evidence and form: https://<forge-host>/requests/<opaque-id>
Deadline: 21 Nov, 13:00 IST. Request: <short-display-code>.
```

The URL is a locator, never a pre-authenticated approval or a bearer token. In B1's earliest delivery-only slice it may be today's `/lane-approval/<request>` for a current resume. The full version links to the longer-lived question page; protected approval is created or refreshed only after owner sign-in and fresh context checks.

**Permissions need a code change.** GitHub's comment-create endpoint accepts installation tokens with Issues write or Pull requests write. Use Issues write for the decision-inbox repository. The App installation must include that selected repository. [Issue comments API][Gcomments] [Installation tokens][Ginstall]

Forge's current credential helper narrows to one admitted numeric repository and requests only Actions, Checks, Contents, Metadata and Pull requests read. It rejects returned non-read permissions. Merely granting the App more access will not make that helper post. Add a separate notification credential capability requesting only the destination repository and Issues write. Keep merge-evidence credentials read-only. A second destination repository needs a separate configured repository admission. [cloud/github-app-credential.ts:17][Fghcred] [cloud/github-app-credential.ts:89][Fghmint] [cloud/github-app-credential.ts:141][Fghread] [cloud/github-app-credential.ts:181][Fghvalidate]

**Limits.** Installation tokens have a base REST limit of 5,000 requests/hour, or 15,000 for Enterprise Cloud organization installations. General secondary content limits are 80 writes/minute and 500/hour, with lower endpoint limits possible. Honor response headers and retry guidance. One initial comment and one reminder are far below these limits for the proposed 20-question cap. The last sentence is a sizing inference, not a capacity test. [GitHub REST limits][Grate]

**Exact return flow.** `issue ask` commits request → outbox posts mention comment → phone opens question/approval page → owner completes Forge sign-in → Forge checks request and form binding → answer commits and emits event → `issue wait` receives event and re-fetches answer → agent rechecks lease/head/control → protected action uses the existing approval consumer. GitHub is outbound only in B1. No comment webhook is required to return the answer, and no Actions job is started.

### B2. GitHub-native answers and approval

An authenticated GitHub account is attributable to that account. It does not establish that a human was holding the phone. GitHub exposes API operations for comments, reviews, and deployment approval. A user token available to an agent can act as that user. Keep this distinction explicit when comparing it with Forge's separate owner browser sign-in. [Comments API][Gcomments] [Reviews API][Greviews] [Workflow run APIs][Gruns]

| Route | Identity and binding | Replay and delivery | Free text and cost | Verdict |
| --- | --- | --- | --- | --- |
| Environment required reviewer | GitHub records reviewer identity. Map one immutable Forge request to repo id, workflow id/digest, run id, attempt, environment id, requested head and expiry. The run's head may be the dispatch branch, so it is not automatically the requested work head. | `deployment_review` webhook, followed by REST approval-history readback. Compare numeric approver id. First matching live request wins; rerun/new attempt needs new mapping. Do not infer approval from job success or deployment status. | Review UI accepts a comment. Up to six reviewer users/teams, any one can release a job. Private required-reviewer environments require Enterprise. Workflow setup and runner execution add cost; platform wait and Forge expiry differ. [Environments][Genv] [Review UI][Greviewdeploy] [Review webhook][Ghooks] [Review history][Gruns] | Use for a real release/deployment the owner already reviews. Poor general inbox. |
| PR review | Review includes user, commit id, state, body and submission time. Bind specific repo/PR/review to request digest, exact requested head and deadline. `APPROVED` alone does not distinguish two unrelated Forge asks on the same PR. Require request marker or a dedicated request check. | `pull_request_review` webhook; re-fetch review and current PR head. Refuse dismissed, wrong-user, wrong-head, old or spent evidence. Replay is harmless only because Forge stores a one-time acceptance. | Review body supports text. PR needed. Reviewing through API adds no Actions run of its own. [Reviews API][Greviews] [Webhooks][Ghooks] | Useful when the question is genuinely approval of that code head. Do not create empty PRs for product questions. |
| Exact slash reply in comment | Proposed `/forge answer <request-code> A` plus optional details. GitHub comment has a numeric author id. Core maps it to an approved Forge responder. Store the exact accepted body snapshot and brief digest. | `issue_comment` created webhook, signature checked, then re-fetch comment/repo. Validate installation, private destination issue, author, creation/update times and request. Ignore edits/deletes as new authority. No auto-execution of text. | Natural free text after the command. No workflow job. Needs inbound webhook and Issues read subscription; B1 already needs Issues write. [Comments API][Gcomments] [Comment webhooks][Ghooks] [Webhook validation][Gverify] | Best optional GitHub-native answer. Ordinary questions only by default. |
| Reaction on a request comment | REST exposes reacting account and reaction id. A new immutable bot comment per request can bind a reaction to that request. A generic thumbs-up elsewhere cannot. | No dedicated reaction event appears in the current documented webhook catalog. Use bounded reconciliation polling if this route is chosen. Addition/removal races and reaction creation time require care. This is a static catalog finding, not a tested delivery guarantee. | Fixed emoji choices, no explanation or required fields. REST reads add work; no Actions job. [Reaction API][Greactions] [Webhook catalog][Ghooks] | Reject for first slice. Less explicit than a typed answer and harder to receive. |

For an environment route, the App needs Actions write to dispatch a trusted workflow, Actions read to read approval history, and Deployments read for `deployment_review`. Configure only the owner as reviewer if only the owner may approve. Disable administrator bypass and restrict deployment branches. Prevent-self-review interacts with the trigger actor; do not turn it on without checking the App-triggered run's actor. These are setup requirements, not verified settings. [Workflow dispatch][Gdispatch] [Workflow review history][Gruns] [Webhook catalog][Ghooks] [Review UI][Greviewdeploy]

A concrete workflow design would take nonsecret inputs `{request, project, head, briefDigest, expiresAt}` and reference a fixed `forge-decision` environment. The Worker stores the resulting run mapping before accepting any review. After approval it re-fetches history, workflow identity, attempt and requested context. The job should only acknowledge the decision and finish. It must not hold a broad Forge token or directly resume arbitrary lanes. A generic success callback is insufficient proof of who approved.

GitHub permits up to 30 days waiting on an environment approval and 35 days total workflow duration. Forge should still enforce its own shorter request expiry and cancel unused runs. Private hosted runner execution consumes included compute or incurs charges. Do not promise a fixed number of “free Actions minutes”; current billing docs describe shared included compute and runner rates. [Actions limits][Glimits] [Actions billing][Gbilling]

### Owner setup for the recommended GitHub route

These are instructions for a later implementation, not actions taken here.

1. Create private `forge-decisions`, enable Issues, and grant only intended decision participants access. Record its numeric repo id. The proposed per-work-item issue is created on the first request. Do not subscribe every repository event. [Create a repository][Gcreate] [Issues API][Gissues]
2. Edit the existing Forge GitHub App to add Issues read/write and install it on that selected repository. Approve the updated installation permissions. Keep its existing source-repository evidence access. The Worker change must mint the separate narrow notification token described above. [App permission changes][Gpermissions] [Installation tokens][Ginstall]
3. Set notification configuration to that repo, owner login for display/mention, and numeric GitHub user id for mapped answers. No raw App key belongs in config or a brief. B1 needs only the outbound capability. Add webhook secret and `issue_comment` only for native replies. [GitHub webhook validation][Gverify]
4. Install GitHub Mobile and sign in to the account with private-repo access. In Profile → Settings → Notifications on iOS, or Configure Notifications on Android, enable Direct mentions. Keep the repo out of Ignore; participating/@mentions is enough. Enable the OS notification permission and inspect Working Hours. GitHub's inbox guide also calls for Email and On GitHub delivery settings. [Notification setup][Gnotify]
5. During validation, request one harmless ordinary answer, tap the push, sign into Forge and submit. Verify accepted actor, request and timeline entry, the waiting agent's result, duplicate refusal, and no protected action. Then test an expired link and a changed head. None of these trials occurred in this research.

Proposed incremental size: GitHub B1 adapter **+140-240 lines**, plus **+60-120** for permission/installation setup and destination mapping. Native comment answers add **+130-220**. Environment approval adds about **+300-500** plus workflow/configuration, so defer it until a genuine deployment needs it. These ranges exclude the common core and page.

## Part C. Slack for teams, plus Telegram on the same core

### Slack transport and app setup

Use an HTTP interaction URL on the Forge Worker. Socket Mode is an alternative delivery transport using a reconnecting outbound WebSocket and an app-level token. It replaces HTTP event/interactivity delivery when enabled. It is not something to enable “against” the same HTTP Request URL. Slack documents dynamic socket URLs, granular permissions, and no public Marketplace listing for Socket Mode apps. For an already public Worker endpoint, HTTP avoids a persistent socket manager. [Slack Socket Mode][Ssocket] [HTTP event URLs][Shttp]

Proposed setup:

1. Create an internal Slack app from a manifest for the team's workspace. Set Interactivity to `https://<forge-host>/integrations/slack/interactions`. Leave Socket Mode off. Install with a bot token stored as a Worker secret. This is setup design; no app was created. [Slack app manifests][Smanifest] [Interactivity][Sinteract]
2. Minimum bot scope is `chat:write`. Invite the bot into the chosen channel, including private channels. Do not ask for `chat:write.customize`; Forge messages should visibly come from Forge. `views.open` lists no extra method scope. [chat:write][Sscope] [chat.postMessage][Spost] [views.open][Sopen]
3. Add `im:write` only if the app opens personal DMs via `conversations.open`. Do not request channel/DM history merely to support buttons and submitted modals. Raw thread-reply ingestion would add `channels:history`, `groups:history` or `im:history` and corresponding message subscriptions. Keep that out of the minimum route. [conversations.open][Sdm] [Message event scopes][Smessage]
4. Plain buttons and modal submissions use Interactivity. They do not require the Events API. If app mentions or raw replies are later enabled, configure a separate `/integrations/slack/events` Request URL, sign-check it and answer the URL-verification challenge. [Interactivity][Sinteract] [HTTP event URLs][Shttp]

### Message, form, and exact return flow

Post one root message per Forge issue/lane conversation. Each question is a thread reply with a visible short request code and immutable brief version. Persist `(teamId, channelId, rootTs, questionTs, requestId)`. Slack uses `thread_ts` to post replies. Use a plain `text` fallback for notifications/accessibility and Block Kit for choices. [chat.postMessage][Spost]

Proposed layout:

```text
Forge / project / issue / request code
Question and why now, 2-4 sentences
Options and consequences; recommended default; deadline
[Choose A] [Choose B] [Reply with details] [Open visual brief]
```

Choice buttons carry a short opaque interaction id, not trusted action arguments. “Reply with details” receives a `block_actions` payload, obtains its `trigger_id`, then opens a modal with a choice field and multiline text input. Put only an opaque interaction reference in `private_metadata`. On `view_submission`, read `view.state.values` and pass a normalized answer candidate to the core. Slack's modal guide documents this lifecycle, a 3-second trigger lifetime, and field values. [Actions payload][Sactions] [Modals][Smodals]

On each callback, verify `X-Slack-Signature` using HMAC-SHA256 over `v0:<timestamp>:<raw body>`. Check timestamp skew within five minutes and use constant-time comparison. Do this before parsing or trusting any fields. The Slack signing secret authenticates Slack's assertion, not project membership. [Slack signing][Sverify]

Slack requires an HTTP acknowledgment within 3 seconds. The fast path is signature check, identity/request lookup, durable answer acceptance, and acknowledgment. Open a details modal promptly; do not wait for an agent or GitHub fetch. If acceptance cannot commit quickly, retain a durable ingress receipt or return a clear retry error. Never show “answer accepted” merely because an in-memory background promise was started. [Slack interactivity][Sinteract]

Choice → signed HTTP callback → mapped member → request checks → atomic answer/timeline/event → update the Slack question to show who answered → wake the same `issue wait`. Other channel copies become terminal. A late Slack click after an answer in Telegram returns the existing result, without changing it.

### Identity and team routing

Use `(enterpriseId if present, teamId, userId)` as the platform identity key. Do not trust display names, channel membership, email text, or the person who installed the app as proof of project ownership. The interaction payload supplies user/team context. [Slack action payload][Sactions]

Proposed linking is explicit. A signed-in Forge person starts “Connect Slack”. Use Slack OIDC in a separate linking flow and record the returned stable workspace/user identity against that Forge principal. Validate state, issuer, audience and nonce. Slack documents Sign in with Slack and separates its identity scopes from ordinary app OAuth scopes. For a one-owner internal pilot, an owner-approved explicit mapping can replace full linking UI, but label that as a manual trust setup. [Sign in with Slack][Soidc]

Routing is a small project table, not a new permission engine:

| Question type | Proposed destination and responder rule |
| --- | --- |
| Product/scope choice | Named issue owner in project channel, or configured project owner |
| Code-review question | Designated reviewer for that lane/head |
| Team operational question | Named current on-call person or explicit role mapping |
| Secret, customer detail, sensitive evidence | Private DM with short brief and authenticated Forge link |
| Shared resume, deploy, publish, policy adoption | Owner notification, then Forge owner sign-in for the action |

The core snapshots the authorized responder set at creation and rechecks current membership on answer. Removed members lose answer rights even if a Slack button remains. A Slack channel is never a grant. An explicit owner reassignment cancels/reissues the request rather than silently accepting the next person who speaks.

For protected actions, Slack shows “Review in Forge” rather than a direct approving button. A Slack choice can record advice or “I will review”, but it cannot set the cloud approval to approved or clear `lane.control`. Forge's present cloud route rejects relayed quote/source and consumes only the server-issued approval id. Preserve that behavior. [cloud/lane-commands.ts:107][Fcloudresume] [cloud/lane-commands.ts:178][Fconsume]

### Slack limits, Board comparison, and smallest slice

Free Slack permits 10 third-party/custom apps. It exposes 90 days of message/file history, with older-than-one-year data subject to deletion. Thus Slack cannot be Forge's answer archive. Paid Slack changes retention/administration, but no paid Workflow Builder is required for this custom-app design. Customer app-install policy may still require admin approval. [Slack free limits][Sfree] [Slack app approval][Sapproval]

Budget about one posted message per second per channel and respect `429`/`Retry-After`. Slack says all plans receive the same method rate tier. The current history/replies method pages list Tier 3 and require appropriate history scopes and pagination. I could not establish the older non-Marketplace exception from these current pages, so it is not a sizing premise here. Submitted forms still avoid broad history access and repeated reads. [Slack rate limits][Srate] [History method][Shistory] [Replies method][Sreplies]

Board's Slack implementation is broader. It maps Slack channels to Board channels. New threads, replies, edits, deletes, reactions and files sync both ways. It uses Chat SDK/Vercel Connect in the application's deployment and avoids echoing its own posts. Private channels map by id. Forge needs only a root-thread mapping, notifications and answer ingestion. Copying full sync would add message editing, attachment retention and cross-platform ACL problems unrelated to decisions. [Board sync][Bsync]

Board's documented agent-in-Slack guide and watcher example show the split worth borrowing: synced human message, stored event, deployed callback, supplied agent compute. The watcher guide discusses retries and idempotent writes. Forge should store the answer before wake, then let its runner decide what work is still valid. Do not make posting a Slack message equivalent to granting execution. [Board Slack guide][Bslack] [Board watcher implementation guide][Bwatch]

Smallest Slack slice after the core/page: one workspace, one configured private channel, explicit mappings for two members, two choice buttons, one details modal, link button, signed HTTP callbacks and terminal message update. No history subscriptions, slash commands, file upload, broad Slack sync or Socket Mode. **+260-420 lines** for adapter and modal; **+100-180** for team identity linking/routing setup. A manual owner-approved mapping pilot can reduce the latter. This includes free text, so it is more useful than notification-only Slack.

### Telegram is another adapter, not another inbox

Use one personal bot created with BotFather and a private chat the owner has started. Pair it through a signed-in Forge page using a short-lived one-time `/start` linking nonce. Record stable user id and chat id, not username. Telegram supports bot deep links and private-chat interactions. [Bot features][Tfeatures] [Bot FAQ][Tfaq]

Post the same short brief with inline choice callbacks, “Reply with details”, and an HTTPS Forge-page link. Callback data is limited to 64 bytes, so store a short interaction reference server-side. Use `setWebhook` over HTTPS with `secret_token`; verify `X-Telegram-Bot-Api-Secret-Token` before reading updates. Deduplicate `update_id`/callback id, check `from.id` and chat/message mapping, and answer the callback promptly. For text, require a reply to the exact question message or an explicit request code. Update data is held no longer than 24 hours by Telegram, so persist it on receipt. These are documented API constraints. [Telegram Bot API][Tapi]

Protected Telegram actions also open Forge sign-in. Do not put credentials in the webhook URL or use a forwarded message as identity. No Telegram Mini App is needed for the first slice. Current Telegram features include richer web interfaces; those are a separate runtime to secure, not a reason to duplicate Forge's page. [Bot features][Tfeatures]

Proposed adapter size **+180-300 lines**, plus **+50-100** for pairing UI. Bot API use at this volume does not need paid broadcast features. Telegram's FAQ recommends about one message/second in one chat, 20/minute in groups, and about 30/second for free bulk sending. Our one-owner route is nowhere near bulk traffic. [Bot FAQ][Tfaq]

### What all three adapters share

Shared code owns brief validation/rendering data, request state, expiry, responder authorization, duplicate handling, action binding, timeline events, outbox/retries, reminder cap and wake cursor. Adapters own only external identity verification, destination mapping, message/form formatting and candidate extraction.

| Piece | Proposed non-test size | Replaces or avoids |
| --- | ---: | --- |
| Consolidated core, timeline and waiting | +740-1,270 / -610-1,190 | Local owner batch, bound ask and manual answer relay |
| Fixed decision page | +220-360 | A separately generated/deployed app per decision |
| GitHub notice plus setup | +200-360 | Manual phone pings and pasted approval URL |
| Optional GitHub comment answers | +130-220 | Relaying a GitHub reply into the agent chat |
| Slack buttons/modal plus team setup | +360-600 | Dedicated team polling, broad conversation sync |
| Telegram callbacks/replies plus pairing | +230-400 | A second custom mobile form or bot-specific request store |
| Total for all channels and basic page | +1,880-3,210 / -610-1,190 | Estimated net +690-2,600 lines; remote compute and optional rich HTML sandbox excluded |

All three channels are supported. Default routing should still send each request through its preferred destination, with optional copies explicitly configured. Do not ring three apps by accident. One reminder budget applies to the request as a whole, not once per adapter. If initial delivery genuinely fails, use an owner-configured fallback destination and record why.

## Part D. Better ideas that reduce Forge's job

### Product and implementation evidence

These sources describe mechanisms, not independent proof that one product makes better decisions. The last column is my design judgment.

| Source | Verified pattern | What Forge should borrow |
| --- | --- | --- |
| Linear agent interaction and best practices | Agent sessions distinguish working, awaiting input and completion. An elicitation activity asks a person; a later prompt activity continues the session. Linear recommends immutable Agent Activities over editable comments for reconstructing input. [Agent interaction][Linteraction] [Best practices][Lbest] | Store an immutable accepted answer and render it in the issue timeline. Do not re-interpret a later-edited Slack/GitHub comment as a fresh answer. Keep issue workflow and agent waiting separate. |
| GitHub Copilot | Current paid cloud sessions can continue across GitHub web/mobile and local clients. The older coding agent works through issue assignment, PRs and comments. The product changed in October 2026, so a design based only on older PR behavior would miss current mobile steering. [Copilot current/older models][Gcopilot] | Put the decision in existing work context and deep-link the exact request/session. No custom Forge native mobile app. Do not assume Copilot's session infrastructure can wake arbitrary Forge agents. |
| Devin | Web and Slack thread messages can sync bidirectionally. Session threads accept follow-up interaction. [Devin Slack][Devin] | Bind a conversation to work once, then route the answer to that work. Full transcript sync is optional; the bound request is enough for Forge's first slice. |
| Factory | Slack mentions run through organization agent profiles; personal DMs use personal identity/connectors. Setup includes account matching and controlled profile access. [Factory Slack][Factory] | Keep team routing explicit. Avoid silently spending a person's credentials when a shared channel answers a question. Do not copy automatic email matching as the sole Forge ownership proof. |
| Amp | CLI sound notifications can announce completion or blocked input. Its Windows app notifies when a thread is ready for a next message. [Amp settings][Amp] [Amp Windows][AmpWindows] | Capability-based notification delegation: reuse a host that can alert and return to a thread. A local sound is not evidence for durable remote wake or mobile approval. |
| Cursor cloud agents | Slack threads carry follow-ups with team controls. Current release notes specifically keep pushes for questions/approvals while removing routine turn-finished pushes. [Cursor Slack][Cursor] [Cursor release notes][CursorNotes] | Make human-needed requests the high-signal notification class. Put routine progress into the existing issue/thread without paging the owner. |
| Claude Code Remote Control | Local sessions can be continued remotely. Mobile pushes can cover needed decisions and permission prompts; connected local execution and mobile control are distinct. [Remote Control][ClaudeRemote] | Let a supported harness collect ordinary answers using the same request id. Keep Forge's cross-project action approval independent. A remote interface does not make an offline machine execute. |
| Codex Remote and Cloud | Remote engineering docs show phone diff review, inline comments, and scoped approval prompts. Cloud docs describe delegated cloud work. These are different execution locations. [Remote guide][CodexRemote] [Codex Cloud][CodexCloud] | Offer a harness handoff when it already gives the owner a good mobile decision UI. Retain the common request for audit and cross-harness use. No universal cross-vendor resume API was verified. |
| HumanLayer current source | The approval table binds organization, session, host, owner and tool input. The resolver checks session access, records responding user/comment, treats resolved requests idempotently, and updates session state in a transaction. [Approval table][Htable] [Resolver source][Hresolve] | Borrow the transaction boundary and explicit responding actor. Do not import its whole application or equate an idempotent response with proof of exact-once external execution. |

### Protocol ideas

**MCP elicitation should be an agent-side view of the same request.** Use form mode for ordinary structured choices. Use URL mode for the authenticated Forge page. The current 2026-07-28 spec carries `elicitation/create` inside `InputRequiredResult`; the client retries with `inputResponses`. URL acceptance means willingness to visit, not completed approval. It permits flat primitive form fields and forbids secrets through form mode. Negotiate client capabilities and protocol version. [MCP elicitation][MCPelicit]

Do not hardcode a 2025-only callback design. The primary Everything server implementation explicitly separates 2025 elicitation requests from the 2026 `input_required` result and retry. Forge already documents era-aware MCP framing in its dependency ledger. Reuse the adapter boundary; do not write a second MCP transport. [Everything implementation][MCPexample] [docs/dependencies.md:28][Fdependencies]

**A2A's input-required state is a useful interoperability mapping.** The task model includes an input-required interruption and messages continue an existing task context; streaming and push delivery are separate operations. Map an external input-required task to a Forge request and map the accepted answer back. Do not adopt an A2A server, agent discovery or task authority merely to ask one person a question. [A2A specification][A2A]

**CIBA is a design analogy, not the first implementation.** It separates the device requesting work from the device authenticating the user and offers poll, ping and push modes. A binding message helps a person recognize the request. Actual adoption needs an identity provider supporting CIBA and a registered client. This research did not verify that Forge's current identity provider supports it. Keep the existing browser OAuth approval and add a recognizable short request code. [OpenID CIBA][CIBA]

**GitHub Event Streams may retire a polling branch later.** `gh event listen` arrived in CLI 2.105.0 on 18 November 2026. It waits for PR reviews, state/head changes, conflicts and completed check suites. It is preview/waitlisted. Earlier events are not replayed, so attach then reread current PR state. Use it only when available as an adapter alternative; it cannot replace Forge's durable answer cursor. [GitHub announcement][Gstream] [CLI manual][Gstreammanual]

Ranked simpler ideas: immutable request/answer snapshots; one request shared with harness elicitation; high-signal notifications only; conditional use of existing PR streams. Defer a general A2A gateway, CIBA provider work, native mobile app, workflow engine and broad chat sync. None is needed for the agreed five states and one answer.

## Part E. Framing and visual decision pages

### What existing products establish

| Product or interface | Verified runtime capability | Fit for Forge |
| --- | --- | --- |
| Claude Artifacts | Interactive tools and pages; current storage can be personal or shared. Paid web/Desktop storage persists across sessions. Shared storage warns the user. New and legacy artifact storage differ. Claude Code can publish a live private interactive page. [Artifacts guide][Artifacts] | Useful model for visual context, but artifact storage is another authority. Do not store Forge approval there. Mobile storage parity and a public generic API to mint Forge pages were not established. |
| v0 | Working branches get preview URLs; publishing updates the Vercel production deployment. [v0 deployments][v0] | Good for developing a renderer or an illustrative prototype. Deploying a new app per question adds build, auth and lifecycle work. Use one renderer instead. |
| Board inspector | Local `vb inspect` runs while the CLI runs. The packaged inspector can be mounted in an application and reached from a phone. Its deployed handle acts as the app; a chosen profile is not visitor authentication. [Inspector implementation guide][Binspect] | Borrow deep links, context beside conversation and fixed application UI. Add Forge's authenticated person boundary. Do not expose a privileged handle as a public decision UI. |
| Slack Block Kit/modals | Structured components, choices, plain text inputs and submitted state. [Slack modals][Smodals] | Fast compact forms in the existing team app. Complex diffs/diagrams link to the common page. |
| GitHub check runs | Markdown summary/text, image references, details URL and external id. Up to three requested-action buttons appear after check completion and send a webhook. Third-party checks cannot set Actions-only `waiting/pending/requested` states. [Checks API][Gchecks] | Useful PR-specific evidence summary and page link. Do not mark a decision check successful merely to expose buttons. Requested-action button support in GitHub Mobile was not verified. |
| MCP Apps / UI resources | Interactive HTML, forms and charts inside supported MCP hosts; `ui://` resources and sandboxed iframe delivery. Host integration has CSP/resource metadata and mediated tool calls. [MCP Apps overview][MCPapps] [Official Apps API/security docs][MCPappdocs] | Reuse the same fixed renderer/schema later. This is a host capability, not universal mobile delivery, hosting or owner identity. Avoid maintaining a separate legacy MCP-UI format first. |

### Recommended hosting and rendering

Make the decision core produce a short-lived page at `https://<forge-host>/requests/<opaque-id>`. The agent produces a validated brief and visual data. Forge produces the HTML. One deployment serves every request. This fulfills the temporary-page idea without deploying agent-written applications.

| Host option | What it would need | Recommendation |
| --- | --- | --- |
| Forge Worker, fixed template | Existing owner sign-in, bounded request read, template and submit handler | First slice. Same binding and authority as the request. +220-360 lines. |
| Static page on separate asset origin | Private evidence access, expiry, authenticated callback and request lookup | Later for large visual assets. Static files alone cannot authenticate an answer. +100-200 beyond basic page for controlled private assets. |
| Claude/v0/other artifact host | Separate publishing, viewer access, external storage policy and authenticated Forge callback | Optional evidence authoring. Do not depend on it for answer state or protected approval. Integration size unverified. |
| Arbitrary agent HTML runtime | Separate origin, sandbox, CSP, input/output bridge, asset validation, access control | Defer. About +300-600 lines beyond basic page, with more review burden. |

For the basic page use server-rendered HTML and a native HTML form. No JavaScript is needed to collect a choice, text, date, number or checkbox. Render charts with trusted template code from numbers and labels. Render diagrams from a bounded nodes/edges format. Diffs are escaped text in `<pre>` with trusted styling. Show tables as cards or responsive tables. Images need safe media validation and an accessible description. The renderer does not fetch arbitrary evidence URLs.

A temporary page is temporary access, not deletion of the decision. On terminal state or expiry, disable the form and show a dated receipt. Retain the compact question/answer and evidence identifiers with the issue. Proposed retention: terminal request/answer for the issue's lifetime, rendered media 7 days after settlement, capped at 256 KiB brief JSON plus explicitly sized image assets. Preserve a digest and source link if media expires. These are policy defaults, not existing storage behavior.

### Bind the form and keep agent content out of authority

The existing lane browser already emits `no-store`, `X-Frame-Options: DENY`, a restrictive CSP and escaped HTML. Extend that trusted-shell approach. Do not insert arbitrary agent HTML into the authenticated page. [cloud/auth/lane-browser.ts:61][Fpage]

Proposed submission checks:

1. Authenticate the Forge person and their project/request rights. The URL alone reveals no private brief. A bot/link-preview GET must not approve, spend, refresh or create an authorization.
2. Display canonical project, issue/lane, exact action, revision/head, expiry and current actor in trusted chrome. The agent cannot rewrite this header, button target or form action.
3. Bind a CSRF token and one-time form nonce to browser session, request id, brief digest and request revision. Re-read request and current action context on POST. Reject a stale tab.
4. Validate choice and typed fields on the server. Accept once with CAS and append the immutable answer. Never trust hidden head/action fields supplied by the page.
5. For a protected action, reauthenticate as required and follow the existing server approval flow. Record the question result and approval reference atomically where possible, but consume authority only with the protected operation.

CSP controls resource execution and fetching. It does not make misleading text truthful. Use both technical isolation and a fixed trusted header/form. Proposed basic-page policy: `default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`. Serve local CSS from a fixed path. Add a separate narrow OAuth navigation path using the existing auth flow, not an agent-supplied form endpoint. [CSP specification][CSP]

If raw visual HTML later becomes essential, render it on a separate content origin in an iframe with `sandbox` and no allowances initially. No scripts, forms, popups, top navigation, downloads or parent access. Give the content response its own restrictive CSP and `Referrer-Policy: no-referrer`. Keep the real answer form outside it. Never combine same-origin agent content with `allow-scripts` and `allow-same-origin`. HTML's sandbox flags document why that combination can defeat the boundary. [HTML iframe standard][HTMLsandbox]

Interactive evidence can later use a reviewed fixed script with bounded data or an MCP Apps sandbox. Never give arbitrary HTML a tool-call bridge that can approve or resume. If a bridge is needed, enumerate read-only operations and validate `postMessage` source and schema. Do not treat a message from the frame as a user decision. The official MCP Apps documentation uses sandboxed frames and host-mediated communication; it is a useful implementation reference. [MCP Apps docs][MCPappdocs]

Phishing controls are practical. The trusted shell says “Agent-provided evidence” around content. It never requests passwords, API keys, wallet actions or downloads through the brief. External links show their real host and open deliberately. Source claims remain untrusted even when the page is visually polished. A fixed template lowers executable risk; human misunderstanding remains a risk and needs clear evidence and consequences.

### Phone behavior and the brief standard

Design target: readable at 360 CSS pixels; title, consequence of waiting, options and submit visible before long evidence. Use 44-pixel minimum touch targets as a design choice, explicit labels, large text, no hover-only controls, and details sections for long diffs. Give every chart a text/table alternative. Preserve entered text after validation errors. Show explicit accepted/expired/stale state after submission. Include “Open in browser” when an in-app browser cannot complete sign-in. These are acceptance criteria to test on actual iOS/Android later, not claimed live behavior.

A good brief answers one decision. It gives enough context to choose without rereading a terminal transcript. It distinguishes observed facts from assumptions. It says what happens if the owner does nothing. For irreversible actions, consequences and reverse path are visible before the form.

Small proposed brief template:

```yaml
title: Keep the old API for one release?
what: The new endpoint is ready. We need a compatibility policy before merging.
whyNow: Two clients still use the old endpoint. Their upgrade dates are unknown.
observed:
  - The two call sites are linked below at the reviewed commit.
assumptions:
  - Both clients can upgrade within one release cycle.
options:
  - key: keep
    label: A. Keep both for one release
    consequence: More maintenance now; avoids forcing an immediate client upgrade.
  - key: remove
    label: B. Remove the old endpoint now
    consequence: Smaller API; both clients must upgrade before deployment.
default: keep
defaultReason: Client readiness is not yet verified.
requiredFields:
  - choice
optionalFields:
  - rolloutDate
  - notes
evidence:
  - label: Exact call-site diff
    url: <reviewed-commit-url>
visual:
  type: table
  columns: [Choice, Client changes, Maintenance]
  rows: [[Keep, Later, One release], [Remove, Before deploy, Lower]]
deadline: <absolute-time-with-timezone>
onNoAnswer: Hold this issue. Send at most one reminder.
binding: <server-filled project/issue/head/digest, never agent authority>
```

Use letter labels for the reader, stable semantic choice keys for the protocol, and the full choice text in the receipt. “A” must not become an enduring identifier after options change. Require fresh consent if consequences, evidence-bound head, scope or options change.

## Ranked plan, streamline first and add second

All six steps are research recommendations. The user's agreed states, three channels, one wait command and one reminder are already requirements. No choice below reopens them.

| Rank | Scoped step and rough size | Replaces | Owner decision needed |
| ---: | --- | --- | --- |
| 1 | Agree and implement the fixed request/answer contract, issue timeline projection and migration reader. About +350-550 / -250-400 lines of the Part A allocation. | Independent local/bound ask models and numbered batch replies. | Whether a task answer can ever adopt a standing rule automatically. Recommend no. |
| 2 | Add request admission to claim/ready, one cursor wait, alarm multiplexing and delivery outbox. Remaining core about +390-720 / -360-790. | Manual reads/quote relay and repeated owner reminders. | Deadline/reminder and runner behavior after laptop disconnect. Recommend 24h, 2h, persist until runner returns. |
| 3 | Add fixed authenticated visual page and native form, +220-360. | Per-question generated/deployed apps; expands current narrow approval presentation. | Fixed data-driven pages first or arbitrary HTML sandbox now. Recommend fixed template. |
| 4 | Add GitHub Mobile notice and Telegram adapter, combined +430-760. | Manual personal pings and duplicate request stores. | Private GitHub inbox location and preferred personal delivery, with all channels still available. |
| 5 | Add Slack team mapping, issue threads, buttons/modal, +360-600. Optional GitHub slash answers +130-220. | Dedicated owner-chat session and cross-chat answer relay. | Ordinary mapped-member answers in channel versus browser-only. Recommend channel answers for ordinary questions. |
| 6 | Integrate existing harness elicitation and the remote-runner slot after that lane's findings. Conditional +80-180 for a supported MCP adapter; runner work unsized here. | Repeated harness-specific question formatting. | Whether an unattended runner is required now. Recommend persist answers and connect a runner only after its lifecycle/authority contract is settled. |

Do not add these estimated totals to optional HTML sandbox or environment-approval estimates as if every design were selected. First review a patch against the source spans. Required tests and live phone trials are outside these non-test line estimates.

## Open questions for the owner

1. Ordinary answers: **A** mapped members may answer questions in Slack/Telegram/GitHub, while protected action needs Forge sign-in; **B** every answer opens Forge. Default **A**.
2. Page runtime: **A** fixed Forge template with typed visual data; **B** also allow isolated raw HTML immediately. Default **A**. Both can show visual context; the second adds a content runtime to maintain.
3. GitHub destination: **A** a private `forge-decisions` repo with one issue per Forge work item; **B** an explicitly selected existing private repository; **C** private PR only, with no GitHub notice before a PR exists. Default **A**. Its existence and installation access need setup verification.
4. Routing: **A** Slack for team questions, Telegram for personal questions, GitHub for PR-related questions; **B** copy every request to all three; **C** GitHub personal primary, Slack team primary, Telegram fallback. Default **A**. All three remain supported.
5. Time: **A** 24-hour ordinary expiry and one reminder after 2 hours; **B** 1-hour expiry and one reminder after 15 minutes; **C** project-set expiry with the same one-reminder cap. Default **A**. Expiry holds work; silence grants nothing.
6. Durable knowledge: **A** answers stay on work and require explicit promotion to a standing decision/memory; **B** every accepted answer automatically proposes a standing decision. Default **A**.
7. Media retention: **A** keep compact question/answer with the issue, expire rendered media after 7 days; **B** retain all visual assets for the issue lifetime. Default **A**, with durable source links and evidence digests.

Valid replies are labels, combinations, or short names. Defaults are design recommendations, not approval to deploy or grant protected authority.

## How Forge changes

One request follows the work through every channel. Issues own scope and conversation. Lanes own execution progress. The owner approval module owns protected authorization. Standing decisions and memory consume selected lessons. The runner consumes an answer event only after rechecking its right to work.

```text
Agent / supported MCP host
        |
        | issue ask (one brief + visual data)
        v
Forge issue authority
  issue + comments + typed request/answer + accepted sequence
  pending -> answered | denied | expired | canceled
        |
        +---- outbox + one reminder, sharing project alarm
        |          |
        |          +--> GitHub Mobile mention / optional exact comment reply
        |          +--> Telegram private bot choice / text reply
        |          +--> Slack issue thread / choice / details modal
        |                         |
        |                 verified answer candidate
        |                         |
        +<--- same core checks request, person, binding, expiry, one-time use
        |
        +---- fixed Forge decision page + trusted form
        |          |
        |          +--> protected action: existing owner sign-in + approval record
        |                                        |
        |                                existing transactional consumer
        |
        +---- issue wait(request, cursor) -> persisted answer/event
        |                                        |
        |                              local harness / REMOTE RUNNER SLOT
        |                              recheck lease + head + control
        |                                        |
        |                                  existing lane execution
        |
        +---- explicit promotion -> decision propose/adopt or device memory
```

| Existing piece | Final role | Merge, remove, or add |
| --- | --- | --- |
| Issue comments and checkpoint comments | Readable work timeline with typed question/answer entries | Merge presentation and append plumbing; retain plain comments and checkpoint semantics. |
| Local owner batch and bound-lane ask copies | References to one issue request | Remove independent state and `#message 1A 2B` parser after migration. |
| Local lane journal/registry | Execution facts, worktree, action counters, request id | Keep local. No new shared full journal. |
| Issue lease, dependencies, lane control, dispatch | Existing authority to perform work | Keep. Add unresolved-request admission; answer never replaces a claim or stop check. |
| Generic relayed consent | Local auditable consent entry path | Reuse common brief/collection where possible; keep its explicit weaker trust label. |
| Cloud owner approval | Authenticated protected permission bound to action/epoch | Keep current identity checks and transactional consumption. Common request references it. |
| `decision propose/adopt/list` | Standing rule/decision lifecycle | Keep names and explicit adoption. Add source-request provenance. |
| Device memory | Durable lessons and preferences | Keep local retrieval/adoption rules. Shared-memory sync remains a separate decision. |
| `agent wait` and harness PR watches | PR event adapters | Keep current capability-based route. No revived shepherd daemon. |
| GitHub, Telegram, Slack | Delivery and normalized answer candidates | Add three thin adapters, one routing table and one shared outbox. |
| Decision page | Visual context and a trusted form for the exact request | Add one reusable Worker renderer. No page app deployment per request. |
| Remote runners | Execute valid continuations | Reserved for the separate research lane. Needs run id, cursor, idempotent wake receipt, lease/epoch checks and offline behavior. No provider selected here. |

Coverage: **9 OF 9 Board patterns; B1 and all 4 B2 routes; 3 OF 3 requested channels; 8 named product families plus HumanLayer; MCP elicitation, MCP Apps, A2A and CIBA; Part E hosting, binding, sandboxing, phone criteria and brief template; one convergence diagram/table.** Written artifact readback is the completion evidence for this research. No implementation, installed grants, phone push, protected resume or runner wake is claimed verified.

<!-- Primary source definitions. Forge references are immutable to the inspected ref. -->

[A2A]: https://a2a-protocol.org/latest/specification/
[Amp]: https://ampcode.com/docs/cli/settings
[AmpWindows]: https://ampcode.com/docs/apps/windows
[Artifacts]: https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them
[Binspect]: https://raw.githubusercontent.com/vercel/board/main/packages/board/docs/03-guides/02-inspector.md
[Bslack]: https://vercel.com/docs/board/guides/agents-in-slack
[Bsync]: https://vercel.com/docs/board/concepts/sync
[Bwatch]: https://raw.githubusercontent.com/vercel/board/main/packages/board/docs/01-board/06-watchers.md
[CFalarm]: https://developers.cloudflare.com/durable-objects/api/alarms/
[CFws]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[CIBA]: https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
[CSP]: https://www.w3.org/TR/CSP3/
[ClaudeRemote]: https://code.claude.com/docs/en/remote-control
[CodexCloud]: https://learn.chatgpt.com/docs/cloud
[CodexRemote]: https://developers.openai.com/blog/mastering-codex-remote-for-engineering
[Cursor]: https://cursor.com/docs/integrations/slack
[CursorNotes]: https://cursor.com/docs/release-notes/cloud-agents
[Devin]: https://docs.devin.ai/integrations/slack
[Factory]: https://docs.factory.com/delegations/slack
[Fadapter]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/agent/schemas/adapter.json#L6
[Falarm]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/project.ts#L334
[Fapproval]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/assembly/approval.ts#L1
[Fapprovalshape]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/lane-approval.ts#L28
[Fapprovalttl]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/lane-approval.ts#L204
[Fapprovalstatus]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/lane-approval.ts#L45
[Fasks]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/entry.cts#L3200
[Faskshape]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/entry.cts#L3220
[Fattended]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/assembly/approval.ts#L164
[Fauthority]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/assembly/cloud-authority.ts#L48
[Fboundanswer]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/bound-lane.ts#L366
[Fboundprogress]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/bound-lane.ts#L287
[Fboundrecord]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/bound-lane.ts#L337
[Fboundstate]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/bound-lane-state.ts#L20
[Fbrowser]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/auth/lane-browser.ts#L110
[Fbrowserall]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/auth/lane-browser.ts#L1
[Fcheckpoint]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/entry.cts#L6824
[Fclaim]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/issue-claim.ts#L61
[Fcloudapproval]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/lane-approval.ts#L1
[Fcloudcomment]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/issue-comment.ts#L26
[Fcloudresume]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/lane-commands.ts#L107
[Fcommandwrite]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/command-write.ts#L62
[Fcomments]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/entry.cts#L6770
[Fcommentshape]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/schemas/tracker.json#L243
[Fconsume]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/lane-commands.ts#L178
[Fcontrol]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/lane-control.ts#L1
[Fdecision]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/memory/index.cts#L3130
[Fdependencies]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/docs/dependencies.md#L28
[Fdeps]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/README.md#L59
[Fevents]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/entry.cts#L6914
[Ffreeze]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/entry.cts#L4184
[Fgateshape]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/entry.cts#L3214
[Fghcred]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/github-app-credential.ts#L17
[Fghmint]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/github-app-credential.ts#L89
[Fghread]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/github-app-credential.ts#L141
[Fghvalidate]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/github-app-credential.ts#L181
[Fgraph]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/entry.cts#L817
[Flist]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/issue-list.ts#L40
[Floop]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/templates/delivery/skills/forge-loop/SKILL.md#L9
[Fmemorymanifest]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/memory/forge.block.json#L11
[Fowner]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/README.md#L96
[Fownerroute]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/entry.cts#L3486
[Fpage]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/auth/lane-browser.ts#L61
[Fparticipants]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/README.md#L102
[Frecordstate]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/assembly/cloud-record-state.ts#L24
[Frelay]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/assembly/approval.ts#L45
[Frenew]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/issue-lease.ts#L59
[Fstatus]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/schemas/tracker.json#L11
[Fwait]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/agent/entry.cts#L81
[Fwatching]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/templates/delivery/skills/forge-loop/watching.md#L3
[Fwork]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/README.md#L35
[Fworkmanifest]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/forge.block.json#L597
[Gbilling]: https://docs.github.com/en/billing/concepts/product-billing/github-actions
[Gchecks]: https://docs.github.com/en/rest/checks/runs
[Gcomments]: https://docs.github.com/en/rest/issues/comments
[Gcopilot]: https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github
[Gcreate]: https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository
[Gdispatch]: https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
[Genv]: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
[Ghooks]: https://docs.github.com/en/webhooks/webhook-events-and-payloads
[Ginstall]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
[Gissues]: https://docs.github.com/en/rest/issues/issues#create-an-issue
[Glimits]: https://docs.github.com/en/actions/reference/limits
[Gmobile]: https://docs.github.com/en/get-started/using-github/github-mobile
[Gmobiledeploy]: https://github.blog/changelog/2021-04-01-reviewing-deployments-on-github-mobile/
[Gnotify]: https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications
[Gpermissions]: https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration
[Grate]: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
[Greactions]: https://docs.github.com/en/rest/reactions/reactions#list-reactions-for-an-issue-comment
[Greviewdeploy]: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments
[Greviews]: https://docs.github.com/en/rest/pulls/reviews
[Gruns]: https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#get-the-review-history-for-a-workflow-run
[Gstream]: https://github.blog/changelog/2026-11-18-wait-for-pull-request-events-with-github-cli/
[Gstreammanual]: https://cli.github.com/manual/gh_event_listen
[Gverify]: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
[HTMLsandbox]: https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox
[Hresolve]: https://raw.githubusercontent.com/humanlayer/humanlayer/main/apps/riptide-api/src/orpc/api/approvals/resolve.effect.ts
[Htable]: https://raw.githubusercontent.com/humanlayer/humanlayer/main/packages/db/src/tables/approvals.ts
[Lbest]: https://linear.app/developers/agent-best-practices
[Linteraction]: https://linear.app/developers/agent-interaction
[MCPappdocs]: https://apps.extensions.modelcontextprotocol.io/api/documents/Overview.html
[MCPapps]: https://modelcontextprotocol.io/extensions/apps/overview
[MCPelicit]: https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
[MCPexample]: https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/everything/tools/trigger-url-elicitation.ts
[Sactions]: https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/
[Sapproval]: https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace
[Sdm]: https://docs.slack.dev/reference/methods/conversations.open/
[Sfree]: https://slack.com/help/articles/115002422943-Usage-limits-for-free-workspaces
[Shttp]: https://docs.slack.dev/apis/events-api/using-http-request-urls/
[Shistory]: https://docs.slack.dev/reference/methods/conversations.history/
[Sreplies]: https://docs.slack.dev/reference/methods/conversations.replies/
[Sinteract]: https://docs.slack.dev/interactivity/handling-user-interaction/
[Smanifest]: https://docs.slack.dev/app-manifests/
[Smessage]: https://docs.slack.dev/reference/events/message/
[Smodals]: https://docs.slack.dev/surfaces/modals/
[Soidc]: https://docs.slack.dev/authentication/sign-in-with-slack/
[Sopen]: https://docs.slack.dev/reference/methods/views.open/
[Spost]: https://docs.slack.dev/reference/methods/chat.postMessage/
[Srate]: https://docs.slack.dev/apis/web-api/rate-limits/
[Sscope]: https://docs.slack.dev/reference/scopes/chat.write/
[Ssocket]: https://docs.slack.dev/apis/events-api/using-socket-mode/
[Sverify]: https://docs.slack.dev/authentication/verifying-requests-from-slack/
[Tapi]: https://core.telegram.org/bots/api
[Tfaq]: https://core.telegram.org/bots/faq
[Tfeatures]: https://core.telegram.org/bots/features#deep-linking
[v0]: https://v0.app/docs/deployments
