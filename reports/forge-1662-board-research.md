Decisions needed: choose the phone channel, answer format, expiry, and escalation. Section 6 gives defaults.
- Borrow Board's conversation and wakeup patterns. Keep Forge as the work authority.
- Board launched on 18 November 2026. It is experimental and currently free. [Launch][Blaunch] [Terms][Bhome]
- Board has task leases, dependencies, typed message data, grants, watchers, and scheduled posts. [Concepts][Bconcepts]
- Board's documented approval flow uses a person's reply and an agent's judgment. It is not equivalent to Forge's owner-only resume. [Approval guide][Bslack] [Forge][Fcommands]
- Forge already creates ten-minute browser approval links for shared lane resume. [Source][Fapproval]
- The cheapest first Forge integration sends a notice through an existing phone app and opens that approval page.
- Use GitHub Mobile first if the owner already uses it. Phone installation and notification settings remain unverified. [Capabilities][Gmobile]
- Add a Telegram or Slack adapter when answers must return directly as free text. Both need request binding and duplicate handling. [Telegram][Tapi] [Slack][Sactions]
- ntfy supports HTTP action buttons. Pushover offers links and acknowledgement, not arbitrary custom approval buttons. [ntfy][Npublish] [Pushover][Pactions]
- A small mobile web inbox is a later option. A native Forge app is unnecessary for the first release.
- Keep the full lane journal on the device. A bounded reply mailbox would be an explicit addition to the approved cut list. [Cut list][Fcut]
- Codex, Claude Code, Cursor, and current HumanLayer already offer remote interaction patterns worth studying. They do not supply a universal Forge approval transport. [Codex][Oremote] [Claude][Cremote] [Cursor][U mobile] [HumanLayer][Hreadme]
- Vercel's security swarm and v0's “over 50% of PRs” are vendor claims. I found no published measurement that independently establishes them. [Launch][Blaunch]
- Evidence is primary documentation and static source reading, rung 2. No tests, builds, browser sessions, live approval trials, or code changes were performed.

# Board and phone decisions for Forge

Research for forge-1662. Written on 20 November 2026.

## 1. Scope, evidence, and recommendation

Use Board as design evidence for communication. Do not replace Forge's kernel or add a general chat platform to Forge.

Start with a notification containing a short decision brief and an authenticated Forge link. Use an app the owner already checks. GitHub is the first candidate because this project already uses GitHub, but I did not inspect the owner's phone. A plain reply adapter is a second step. A custom mobile web inbox is third.

The security boundary belongs in Forge. An app delivers the question and the answer. It must not mint permission to resume a stopped lane, merge, deploy, or publish merely because someone clicked a notification.

**Evidence rung 2:** I read the tracked `origin/main` snapshot in `E:/Personal-Projects/forge-new`, commit `93c1db8fa1a340846fd7abd77d25c96bc86aa456`. I used `git show origin/main:<path>`, `git grep ... origin/main`, and `git ls-tree`. I did not fetch, switch branches, inspect local source edits, invoke Forge mutations, or claim the issue. The cut-list brief is the one expressly requested local-file exception. This research does not prove what is deployed.

External documentation is evidence of a published contract, not proof of live behavior. Public Board server code is evidence for that implementation, not proof that Vercel's hosted service runs identical code. Safety claims below rung 4 remain unproven in operation. Recommendations and size estimates below are my judgment.

I fetched the overview and all 15 pages beneath it in the current Board documentation navigation: concepts index, eight concept pages, guides index, two guides, access, CLI, and SDK. That is 16 pages in total. I also read the launch post, changelog, npm registry metadata, repository README, skill source, and relevant package docs and source. No package or skill was installed.

## 2. What Board actually provides

### Data model

| Object | Published behavior | Primary source |
| --- | --- | --- |
| Team and board | A Vercel team owns boards. General is the default. Each board has separate channels, grants, and an ordered event log. Names have 1 to 64 characters, exclude slash, and match without case. | [Boards][Bboards] |
| Channel | A stable lowercase path such as `dev` or `security/incidents`. First post creates it. A trailing slash selects a subtree. Explicit creation supports a private channel. | [Channels][Bchannels] |
| Thread | One root plus replies, one level deep. Replies retain root `re` and optional exact `replyTo`. It belongs to its root's channel. | [Threads][Bthreads] |
| Message | Markdown, author, labels, reactions, attachments, structured `blocks`, source, `noSync`, revision, and creation time. IDs are opaque and also usable as event cursors. | [Threads][Bthreads] |
| Label | A string key/value. Root labels make replies match filters too. Conditional writes use `--if` or `--if-unset`. Labels do not expire. `board.*` is reserved. | [Labels][Blabels] |
| Task | A thread with server-maintained state, an owner, optional assignee profile, prerequisites, and an expiring claim. States are `waiting`, `ready`, `claimed`, `blocked`, `completed`, `failed`, and `canceled`. | [Tasks][Btasks] |
| Dependency | `--needs <id>` delays readiness until completion. Failed or canceled prerequisites do not release dependents. A batch can reference other tasks by its own keys. | [Task package docs][Btaskdocs] |
| Typed data | JSON Schema registered by name/version. Writes validate data; reads return parsed `{schema, version, data}` blocks. Versions are immutable. Built-ins include `git-commit@1` and `vercel-deployment@1`. | [Message package docs][Bmessagesdocs], [CLI][Bcli] |
| Grant | Channel-pattern permissions for principals. Exact channel beats longest subtree, which beats wildcard. At that pattern, a specific principal beats a group, which beats everyone. Ties add permissions. Team role/app scopes still cap them. | [Access][Baccess] |
| Actor | A verified credential's principal, optionally with a named profile. `--as fixer` changes attribution. Ordinary profiles inherit the principal's permissions. They are not separate accounts. | [Actors][Bactors] |
| Event | An ordered change with cursor, type, time, payload, message, and actor. Reads and waits can continue from a cursor. | [Events][Bevents] |

A label such as `state=approved` is data. It is not automatically a protected authorization record. Board reserves its own task labels, but applications must define what their other labels mean. [Labels][Blabels]

### Claims and double claims

The agent runs `vercel board tasks claim <id>` or `vercel board tasks claim --ready <channel>`. The queue route selects ready work, with labels and trusted owner filters. The documentation promises one winner when two workers claim the same task. The loser receives `task_claimed`. The documented lease maximum is five minutes; agents must renew. [Tasks][Btasks]

The SDK claim contains `task`, `epoch`, `token`, and `until`. Public server source increments the epoch and stores a token hash. A claim's writes check state, epoch, unexpired time, and the token. A stale claim fails with `claim_lost`. That explains fencing in the public implementation. Hosted-service race behavior was not tested. [Server task code][Btasksource]

`vercel board tasks run <id> -- <cmd>` claims, renews, and settles around a child command. Lost ownership stops the command. Completion follows exit zero; failure follows other exit codes. This is useful runner convenience, but completion is still a reported outcome. [Task package docs][Btaskdocs]

### Wakeups and work with no listener

| Situation | What happens | Source |
| --- | --- | --- |
| Local agent is waiting | `wait` blocks for one matching event. `tail` keeps following. Pass the question's message ID as `--after` to include a reply that arrived before waiting began. | [Events][Bevents] |
| Deployed watcher | `board({watch:{...}})` registers reviewed code and filters. Vercel matches stored events and wakes the deployment route. Its callback starts or resumes whatever agent compute the application supplies. | [Watcher package docs][Bwatchdocs] |
| No local listener, registered deployment exists | Vercel can wake that deployment. No laptop process needs to remain open for event matching. This does not imply that Board itself runs the coding agent. | [README][Breadme], [Slack guide][Bslack] |
| No listener and no deployed watcher | Messages remain available to read. There is no documented automatic resurrection of an ended coding-agent session. `wait` alone only receives while running. | [Events][Bevents], [Skill][Bskill] |
| Scheduled follow-up | `schedule` stores a future post, once or repeating. A scheduled post can trigger a watcher. Posting a reminder and executing a follow-up are separate steps. | [Schedules][Bschedules] |
| Callback retry | A throwing watcher callback is retried. Same-order posts get derived IDs; parallel writes need explicit IDs. Cross-watcher loops still need application care. | [Watcher package docs][Bwatchdocs] |
| Custom/local board | Local callbacks need their process alive. `BOARD_URL` does not give an arbitrary server Vercel's hosted wakeup behavior. | [Watcher package docs][Bwatchdocs] |

Watchers register on first use or through a registration request after deployment. The guide uses `vercel curl /api/board/watchers -X POST`. Application wakeups need their own deduplication. The eve example uses the event cursor as its idempotency key. The sandbox example explicitly says duplicate delivery can start two runs because it ignores that key. [Slack guide][Bslack]

### Human participation and approvals

Slack messages, replies, reactions, edits, deletes, and files can sync both ways. GitHub pull requests and issues become Board threads. GitHub comments and reviews arrive as replies; PR state, review state, and head appear as labels. Outbound GitHub replies are disabled by default. New Board roots do not automatically create GitHub issues or PRs. Linear mappings can work both ways. Sync runs in the user's deployment with Chat SDK adapters and Vercel Connect. [Sync][Bsync]

For approval, the agent can call `tasks block <id> "question" --kind awaiting_approval`. This ends its claim. A person answers in the thread. The task owner calls `tasks unblock <id>`. The task owner may itself be an agent profile. This is a useful waiting state, not a separate owner-authenticated approval ceremony. [Task package docs][Btaskdocs]

The Slack guide tells the agent to check the answer's author. For irreversible steps it recommends a place with verified identity, such as a GitHub review, because a person's agents can use that person's credentials. This is an explicit limitation in Vercel's own design guidance. [Approval guide][Bslack]

There is a web viewer. `npx @vercel/board inspect` serves a local viewer. The package also exports `inspector()` from `@vercel/board/inspect` for a deployed route, including phone browsers. A deployed inspector uses the handle given to it, not an independently verified visitor identity. Its docs require protection in front of it. Do not use a visitor-chosen profile as proof that the owner answered. A native Board mobile app was not established by the inspected sources. [Inspector package docs][Binspect]

### Authentication, access, storage, and maturity

People use `vercel login`. Deployments use project OIDC identity. Apps are limited by app scopes. Ordinary local coding agents use the person's credential. A profile cannot turn those credentials into independent human identity. [Actors][Bactors]

A new board broadly admits team people, project deployments including previews, and installed apps, within role/scope limits. Permissions include `read`, `post`, `react`, `label`, `sync`, and `manage`. Owners can change grants. Board grants stop at external-platform boundaries. [Access][Baccess]

A narrowed SDK handle can restrict channel permissions. `sandboxPolicy()` can keep the credential outside a Vercel Sandbox and bind its outgoing profile and restrictions. A local agent holding the unrestricted underlying credential remains a different trust case. [SDK][Bsdk], [Sandbox guide][Bswarm]

Hosted Board stores data in the United States, with encryption at rest and in transit and no region selector. Synced platforms keep copies. Published limits include 10,000 text characters and ten attachments of up to 100 MB each. Rate limits are shared by a login/deployment's profiles; an exact universal numeric request rate is not stated. All plans can use it. It is experimental, free for now, and subject to the Public Beta Agreement. Future charging and API/limit changes remain possible. [Overview][Bhome], [Changelog][Bchange]

Task limits include small atomic batches, bounded queue scans, and 30-day retention of task changes in the event feed while task state and threads remain. A single write supports 15 tasks, or 14 with an idempotency key; other attached data consumes the budget. Large plans are split and can be partly visible. [Tasks][Btasks]

The public package has a local backend and protocol/conformance tooling. A local SQLite Board is a different deployment choice from Vercel's hosted service. It does not by itself provide hosted wakeups, recovery commitments, or feature parity. [Local board docs][Blocal], [README][Breadme]

### Exact CLI and SDK names

The day-to-day loop is small: `read`, `post`/`reply`, `tasks claim`, `tasks complete`, and `wait`. The full interface is materially larger.

The current source catalog contains 26 top-level entries including `help` and legacy hook entries. This is a count of source entries, not 26 independent workflow concepts. The hosted CLI reference omits some package/local tooling. [CLI catalog][Bcatalog]

| Group | Exact command names after `vercel board` |
| --- | --- |
| Identity and discovery | `whoami`, `actors`, `channels`, `channels create` |
| Conversation | `read`, `post`, `reply`, `edit`, `delete`, `react`, `label`, `download` |
| Task work | `tasks`, `tasks create`, `tasks claim`, `tasks run`, `tasks renew`, `tasks release`, `tasks complete`, `tasks fail`, `tasks block`, `tasks unblock`, `tasks reopen`, `tasks assign`, `tasks needs`, `tasks cancel` |
| Time and events | `schedule`, `schedule cancel`, `schedules`, `tail`, `wait` |
| Typed data and access | `schemas`, `schemas create`, `grants`, `grants create`, `grants update`, `grants explain`, `grants revoke` |
| External conversation | `sync`, `sources`, `sources <key> read`, `inbox`, `typing` |
| Support | `conformance`, `hooks uninstall`, `help` |

Names above are documented in the [CLI reference][Bcli] and [package CLI reference][Bclidocs]. `delete` has aliases `rm` and `del`. Common controls include `--json`, `--as`, `--name`, `--scope`, `--url`, `--after`, `--label`, `--idempotency-key`, `--if-revision`, and `--no-sync`. Package tooling includes `npx @vercel/board inspect` and `npx @vercel/board serve`. [Package CLI reference][Bclidocs]

The main SDK exports `board()`, `block()`, and `createTasksInChunks()`. The documented handle methods are listed here by name, rather than repeating their signatures. [SDK][Bsdk], [Package API reference][Bapidocs]

- Identity and mount: `as()`, `sandboxPolicy()`, `fetch()`.
- Messages: `post()`, `reply()`, `edit()`, `delete()`, `react()`, `label()`, `upload()`, `download()`, `posted()`.
- Time: `schedule()`, `schedules()`, `cancelSchedule()`.
- Schema: `createSchema()`, `schemas()`, `schema()`.
- Read and events: `messages()`, `threads()`, `thread()`, `channel()`, `channels()`, `createChannel()`, `actors()`, `me()`, `discovery()`, `events()`, `wait()`, `poll()`.
- Tasks: `tasks.create()`, `tasks.createMany()`, `tasks.list()`, `tasks.claim()`, `tasks.held()`, `tasks.block()`, `tasks.unblock()`, `tasks.reopen()`, `tasks.assign()`, `tasks.needs()`, `tasks.cancel()`. Held claims expose `renew()`, `release()`, `complete()`, `fail()`, and `block()`.
- Grants: `createGrant()`, `createGrants()`, `updateGrant()`, `grants()`, `explain()`, `revokeGrant()`.
- Sync and plumbing: `sync()`, `linked()`, `typing()`, `inbox()`, `readSource()`, `joinSource()`, `syncImport()`, `syncReceipt()`, `syncThread()`, `syncFind()`, `syncCopies()`, `inboxPush()`, `inboxNext()`, `inboxAck()`, `register()`, `watchers()`, `matches()`, `ack()`, `request()`.
- Embedded CLI: `vb()` from `@vercel/board/cli`. Viewer: `inspector()` from `@vercel/board/inspect`. [Embedded example][Bslack], [Viewer][Binspect]

Some plumbing methods are in the package reference but not the shorter website reference. This inventory describes observed documentation, not a guarantee that every listed method works on every backend.

The npm page returned HTTP 403. The primary npm registry metadata was readable. It reported `@vercel/board` version `0.53.0`, repository `vercel/board`, Node `>=22.18`, bins `vb` and `board`, and three direct runtime dependencies: `zod`, `jose`, and `@vercel/oidc`. The website SDK reference says it covers `0.50.0`. No installed Vercel CLI version was inspected. [Registry][Bnpm], [SDK][Bsdk]

The skill's source is `skills/board/SKILL.md` in `vercel/board`. Its install command is `npx skills add vercel/board --skill board`. It warns that the Vercel CLI's bundled Board version can lag the newest package. Outside a project containing the package, `npx vb` can select an unrelated npm package. Use `npx @vercel/board`. [Skill][Bskill], [README][Breadme]

### Claims, contradictions, and missing evidence

| Claim or disagreement | Finding |
| --- | --- |
| Security agent swarm | Vercel says it uses Board to coordinate vulnerability analysis and fixes. This is a first-party account. The inspected announcement provides no complete findings dataset, remediation outcomes, or evaluation protocol. [Launch][Blaunch] |
| v0 software factory | Vercel says it rebuilt the factory on Board and that it merges over 50% of PRs. The population appears to be v0's factory context. Do not expand it to all Vercel PRs or all engineering work. No denominator, time window, attribution rule, or independent audit was supplied. [Launch][Blaunch] |
| Evidence beyond prose | Public swarm/factory templates show implementation patterns. They do not establish the production PR percentage or security effectiveness. [Swarm][Bswarm], [Factory][Bslack], [Repository][Breadme] |
| Lease duration | Launch example uses `tasks renew <id> --lease 1h`. Task docs and SDK say five minutes maximum. Sources disagree. Use the current detailed limit for design; actual acceptance of the launch command is unverified. [Launch][Blaunch], [Tasks][Btasks] |
| GitHub “two-way” sync | General descriptions say two-way. Detailed sync docs deliberately default GitHub to inbound only. Outbound delivery requires configuration. This is a qualification, not evidence that GitHub cannot sync out. [Changelog][Bchange], [Sync][Bsync] |
| Read/search | Skill says hosted `read` requires a channel/thread and has no board-wide search. Website CLI docs describe broader no-channel reads and filters. Versions/backends differ; this research did not run the commands to settle it. [Skill][Bskill], [CLI][Bcli] |
| Watcher count | Website SDK says 32 per deployment. Package watcher docs mention 64 per registration and 256 per board. These are different stated scopes, with version drift possible. Do not use either as a tested capacity promise. [SDK][Bsdk], [Watchers][Bwatchdocs] |
| Secondary criticism | The requested New Stack URL returned HTTP 403 and targeted search did not recover the article text. I cannot verify its specific claims or criticism. None is used as established fact. [Attempted article][Bsecondary] |
| Production safety and recovery | I did not establish a hosted Board owner-only approval contract, GitHub-verified close policy, or Forge-style restore contract. This is a bounded documentation finding, not proof that Vercel has no internal equivalents. [Docs index][Bconcepts], [API reference][Bapidocs] |

## 3. Shipping patterns for decisions on a phone

These are different layers. A push says “look here.” A callback says “this app reported an action.” Authorization says “this verified person permitted this exact operation.” Acknowledgement usually proves attention, not approval.

The integration costs below are engineering judgments. They include returning the decision to Forge. An existing mobile interface alone does not wire itself to Forge's waiting lane.

### Product comparison

| Product | What the owner sees and can answer | Request binding, expiry, and replay | Integration cost and free text |
| --- | --- | --- | --- |
| GitHub Mobile with Actions environments | Push for deployment review, run/environment status, approve or reject. Review UI can accept a comment. | Review belongs to a workflow run and named pending environments. Required-reviewer policy is server-side. Gate wait limit is 30 days. Forge still needs to bind run ID, environment, commit, and request revision. | Existing app. Low extra work for real deploy approvals. More work to turn arbitrary design questions into workflows. Comments support text, but are not a general question form. [Mobile launch][Gdeploymobile], [Review][Greview], [Limits][Glimits] |
| GitHub Mobile with a question comment | Issue/PR discussion with context, links, mention push, and an ordinary text reply. | Bind to repo, discussion, parent comment, author, and one Forge request. Reject stale/edited/repeated replies in the bridge. A comment has no application decision TTL by itself. | Small notice-only integration. Medium for a secure return bridge. It can use a notification thread without making GitHub a second tracker. Free text works. [Mobile][Gmobile], [Notifications][Gnotify] |
| Slack custom interactive message | Decision brief, buttons, links, and a modal/text reply. | `block_actions` identifies user, team, container, action, and app-supplied value. Verify Slack HMAC over the raw body and reject old timestamps. The five-minute signature freshness check does not make business actions single-use. Forge must consume its own request once. | Medium. Slack app, OAuth/scopes, webhook endpoint, and owner mapping. No own phone app. Free text through modal submissions or thread replies. [Payload][Sactions], [Request verification][Sverify], [Modals][Smodals] |
| Slack Workflow Builder approvals | A workflow can pause at a message button, restrict who clicks, expire the button, and disable after one click. Forms can collect an answer. | Workflow instance carries variables to later steps. Configure button audience, expiry, and single-click behavior. A custom step/webhook still needs a binding to Forge's request. | Low setup if the workspace already has paid Workflow Builder. Medium return integration. Forms handle free text. Paid plan required for Builder. [Workflow setup][Sworkflow], [Forms][Sforms], [Plan availability][Sguide] |
| PagerDuty | An incident page with details, acknowledge/resolve, notes, and configured custom action buttons on mobile. | Bind incident ID and action to one Forge request. Acknowledge can be undone and is not approval. Custom action POSTs carry incident data. Generic v3 webhook signatures are documented, but that does not prove custom-action requests have the identical signature contract. Verify by authenticated readback or route to Forge sign-in. | Medium to large. Existing PagerDuty app and incident configuration. Notes can carry free text; custom buttons alone cannot. Incident handling adds concepts Forge does not need for ordinary questions. [Mobile][Dmobile], [Custom actions][Dactions], [Webhook behavior][Dbehavior] |
| ntfy | A notification with text/link and up to three actions. `view` opens a page; `http` sends a configurable request. | An HTTP action is not a verified human identity assertion. Bind to a short-lived, single-use request and require owner sign-in for authority. Deleting a notification is not revoking the server request. | Small for notification plus browser link. More for direct decisions. Free-text input needs a linked page. Free hosted use or self-hosting; anonymous topic secrecy is weak access control for sensitive content. [Actions][Npublish], [Service/pricing][Nhome] |
| Pushover | Notification text, supplementary URL, acknowledge, and repeated emergency alerting. | Emergency send returns a receipt. Callback includes receipt and acknowledgement metadata. Retry expiry stops notifications, not necessarily the application's authorization. Read the authenticated receipt API before trusting a callback as attention evidence. | Small alert/link adapter. App is a one-time $4.99 per platform; pricing page lists 10,000 monthly messages free per user. Free text needs a browser page. Arbitrary custom action buttons are not supported in the inspected support answer. [API][Papi], [Receipts][Preceipts], [Pricing][Ppricing], [Actions][Pactions] |
| Telegram bot | Bot message with context, inline buttons, and reply text. | `callback_data` binds a compact value. `CallbackQuery` has sender and query ID. Webhooks can carry `X-Telegram-Bot-Api-Secret-Token`. Allowlist numeric owner/chat IDs; consume a Forge nonce once; deduplicate updates. No decision TTL is supplied by an inline button. Updates may be retained for only 24 hours. | Small to medium if Telegram is already used. Bot plus HTTPS endpoint, or a persistent long-poll bridge. Free text works with a reply to the exact question. Ordinary messaging is free within limits. [Bot API][Tapi], [FAQ][Tfaq] |
| Web push and a Forge web inbox | OS notification opens a request page. Supported platforms can expose action buttons. The page can show context and a text box. | Notification `data` and action IDs route the click. They do not authenticate the person. Use an owner session, request ID/version, CSRF protection, TTL, and one transactional decision. Push subscription expiry and decision expiry are different. | Medium to large. Own web UI, service worker, subscription registration, push sending, and authentication. No native app store build. Free text on the page. [Notification standard][Wnotification], [Push standard][Wpush] |
| CIBA and number matching | A trusted authentication device asks the person to authorize, with a binding message/code linking the transaction. | CIBA uses opaque `auth_req_id`, `expires_in`, client binding, and poll/ping/push modes. Successful redemption invalidates the request. Number matching reduces blind approval of unsolicited pushes. Neither is a general free-text answer protocol. | Large if adopted as a new identity system. Use the security ideas in Forge's existing owner sign-in first. Identity-provider/authenticator support is required for actual CIBA. [CIBA specification][Aciba], [Microsoft number matching][Anumber] |

GitHub allows up to six required users/teams and needs only one of them to approve. Self-review prevention is optional. On Free, Pro, and Team, required reviewers are limited to public repositories. Private-repository protection therefore needs a plan check before selecting this design. [Environments][Genvironments]

PagerDuty currently has a Free tier and paid incident plans. The retrieved pricing table does not settle entitlement to every custom-action feature for the owner's account. Its custom incident action docs cap three actions per service. Price the actual chosen feature before implementing. [Pricing][Dpricing], [Custom actions][Dactions]

ntfy's current publishing page describes `http` as POST by default and permits custom method, headers, and body. Platform support and behavior should be acceptance-tested on the owner's phone. An official repository issue reports that iOS `clear:true` does not dismiss an HTTP-action notification as expected. This is a maintainer-hosted issue report, not a reproduced finding here. [Publishing][Npublish], [Issue][Nissue]

WebKit documents push for Home Screen web apps on iOS/iPadOS 16.4 and later, with permission requested after user interaction. Apple Developer Program membership is not required for that web route. Notification actions have browser compatibility limits. Do not promise inline approval or notification free-text input across all phones. Fall back to opening the page. [WebKit][Wwebkit], [Compatibility documentation][Wmdn]

“Rings the owner” needs a product choice. Ordinary push and an actual phone call are different. Pushover emergency retries, ntfy call features, and PagerDuty escalation are available patterns, but none establishes a guarantee that this owner's phone will sound through its Focus settings. [Pushover priority][Papi], [ntfy calls][Npublish], [PagerDuty pricing][Dpricing]

### Existing tools for coding agents

| Tool | Verified useful pattern | Cost, binding, and limits |
| --- | --- | --- |
| Codex / ChatGPT Remote | Phone can steer connected-host work, review results, and handle permission requests. It supports free-text follow-up and approval context. | Cheapest immediate operational trial if the owner already has access. Requires paired host/account and an awake online host for local work. Published product docs do not establish a generic Forge callback API or exact TTL/replay contract for phone approvals. [Remote guide][Oremote], [Setup][Osetup] |
| Claude Code Remote Control | `claude remote-control`, `claude --remote-control`, and `/remote-control` let web/mobile steer a local session. Outbound HTTPS avoids opening an inbound laptop port. | Requires supported signed-in subscription and a running local process. Supports conversation and permission interaction. Session continuity is useful, but is not portable Forge approval evidence. Per-action TTL/replay details were not established. [Remote Control][Cremote] |
| Cursor mobile and Remote Control | Current iOS product supports agent inbox, follow-ups, review, and notifications when input is needed. Remote Control keeps tool work on the computer while the agent loop moves to the cloud. | Uses Cursor accounts and supported paid access. Laptop must remain online for local tools. Current documentation binds sessions to account/machine, but no generic Forge request-answer API was established. Android has a web/PWA path. [Mobile docs][U mobile], [Cloud entry points][Ucloud] |
| HumanLayer | Current repository has shared agent sessions, web/desktop clients, a daemon, and an approval record linked to session, host, tool input, and person. Its resolver checks authenticated organization/session access and records decision/comment. | Existing product to study, not a tiny SDK dependency to drop into Forge. Current code gives useful ID and authorization patterns. It does not establish phone alert delivery or an approval expiry guarantee. Free-text comments are stored. [README][Hreadme], [Approval table][Htable], [Resolver][Hresolve] |

HumanLayer needs special care. Search still surfaces historical `require_approval` and `human_as_tool` examples for Slack/email. The repository's merged cleanup PR says the SDKs were removed in September 2025. Its current README describes a different agent-control product. Do not budget a new integration from old examples without confirming a supported API. The separate site `humanlayer.systems` must not be assumed to be this same product. [Historical indexed page][Hhistorical], [Removal PR][Hremove], [Current README][Hreadme]

These remote products can let an owner answer an agent immediately. An agent relaying that text still cannot substitute for Forge's browser-proven owner authorization when shared resume requires it.

## 4. Forge compared honestly

### What the inspected Forge snapshot does

The eight `src/blocks/*/forge.block.json` catalogs declare **82 operation entries**. This includes 46 in work and 18 in memory/decisions, plus accounts, agent, checks, cloud login, project detection, and export. This is a catalog-entry count, not a comparison to Board's top-level command count. Local declarations also do not prove cloud support. [Work catalog][Fwork], [Memory catalog][Fmemory], [All blocks][Fblocks]

The relevant commands include `forge issue create`, `show`, `comment`, `claim`, `renew`, `release`, `ready`, `dep`, `link`, and `close`; `forge lane start`, `next`, `record`, `control`, `dispatch`, `stop`, and `resume`; and `forge decision propose`, `adopt`, and `list`. The work block documents the same declared operations through CLI and MCP. [Catalog][Fwork], [Work README][Freadme], [Memory][Fmemory]

`agent.wait` is a PR monitoring workflow command. Its inspected schema takes PR/sweep controls. It is not evidence of a generic “wait for owner's answer” endpoint. [Wait schema][Fwait]

Cloud lane resume currently has a distinct flow:

1. Requesting resume without an approval creates an approval request and URL.
2. Request lifetime is 600,000 ms. It binds project, scope, control incarnation/epoch, owner-policy identity, and requesting device/session/token.
3. Browser GET shows project, affected scope, stop state, and expiry. It does not itself approve. The preview is available to someone holding a valid request link.
4. POST uses a signed cookie-bound ticket. Browser callback verifies owner identity and consumes browser state/code through replay guards.
5. Resume accepts the approval request ID, rejects caller-supplied quote/source as cloud proof, and consumes the approved record with the control transition and receipt. Expiry and changed control state invalidate old authority. [Approval records][Fapproval], [Browser][Fbrowser], [Resume][Fcommands]

The existing preview lacks an agent's decision brief, alternatives, proposed operation/diff, and free-text form. That follows from the HTML it renders. Reusing it for richer phone decisions needs deliberate context and access changes. Sensitive context should be behind sign-in; the current preview's link-readable metadata must not quietly grow into a private transcript. [Browser rendering][Fbrowser]

There are two owner-question paths to distinguish. The local work-block documentation describes numbered owner-channel replies and safe hold defaults. The bound coordinator stores its progress and ask/answer on the device, validates its reservation and current head, and records an answer in the pending action result. Neither is a generic authenticated phone gateway. [Work README][Freadme], [Bound progress][Fbound], [Reply input schema][Frecord]

Forge's cloud claim route puts issue checks, acquisition, and receipt in one transaction and rejects stale replayed grants. Its default TTL is one hour. The server close coordinator verifies GitHub merge evidence under policy before committing receipted close. An explicit `withoutReceipt` close also exists, so “all closes require a verified merge” would be false. [Claims][Fclaim], [Verified close][Freceipt], [Close exception][Fclose]

Restore targets an empty project, establishes a global stop, and removes pending lane approval/browser authority. The docs require readback and fresh owner resume. This is a recovery and permission boundary, not merely an export button. [Restore code][Fproject], [Cloud runbook][Fcloud]

### Capability table

“Simpler” means simpler for the named job, as judged from these contracts. It does not mean fewer total implementation lines.

| Capability | Vercel Board | Forge at inspected ref | Who is simpler, and why |
| --- | --- | --- | --- |
| Basic agent conversation | Channels, flat threads, replies. [Threads][Bthreads] | Issue comments and lane records. [Work][Fwork] | Board for free-form conversation. |
| Work authority | Thread/task owner, lease, task state. [Tasks][Btasks] | Typed issues, lease generation, replay receipts. [Claims][Fclaim] | Board has fewer work concepts. Forge has more explicit write fences. |
| Double-claim handling | One winner, expiring claim, epoch/token fencing. [Task code][Btasksource] | Transactional issue acquisition and generation checks. [Claims][Fclaim] | Similar required problem. No measured simplicity winner. |
| Dependencies | Tasks wait for completed prerequisites. [Task docs][Btaskdocs] | Issue dependencies and ready/blocked views. [Work][Fwork] | Board for a small task queue; Forge already has the needed issue model. |
| Status | Arbitrary labels plus reserved task state. [Labels][Blabels] | Typed issue/lane transitions. [Work][Fwork] | Board is easier to customize informally. Forge is clearer for enforced workflow. |
| Human input wait | Block task, ask in thread, unblock. [Task docs][Btaskdocs] | Local owner asks; separate shared resume approval. [Work][Freadme], [Cloud][Fcommands] | Board is easier for ordinary questions. |
| Owner-only resume | Not established in inspected Board contracts. [Approval guide][Bslack] | Browser-proven owner and transactional consumption. [Browser][Fbrowser] | Forge for preserving the owner/agent boundary. |
| Context on phone | Synced Slack/GitHub; deployed viewer. [Sync][Bsync], [Viewer][Binspect] | Existing narrow browser approval; no phone inbox established. [Browser][Fbrowser] | Board has more ready-made interaction paths. |
| Wake on event | Deployed watchers and event cursors. [Watchers][Bwatchdocs] | PR monitoring seam; device lane progression. [Wait][Fwait], [Bound lane][Fbound] | Board for durable cross-tool wakeups. |
| Future reminder | Scheduled messages. [Schedules][Bschedules] | No equivalent general scheduler established in the inspected catalogs. [Blocks][Fblocks] | Board for this feature. |
| Verified merge/close | Task completion and synced PR labels. No equivalent close proof contract established. [Task code][Btasksource], [Sync][Bsync] | GitHub evidence verification, plus explicit no-receipt path. [Evidence][Freceipt], [Close][Fclose] | Forge for code delivery authority. |
| Stop and dispatch fence | Task cancellation/held claims; not a global Forge spending brake. [Task docs][Btaskdocs] | Shared stop, owner resume, dispatch control. [Commands][Fcommands] | Forge for this job. Do not add a parallel control system. |
| Durable memory and decisions | Threads and structured blocks can carry content. [Messages][Bmessagesdocs] | Dedicated memory and decision commands. [Memory][Fmemory] | Board has fewer concepts. Forge has purpose-specific retrieval/adoption. |
| External sync | Slack, GitHub, Linear. [Sync][Bsync] | No matching conversation sync established by the catalog/source review. [Blocks][Fblocks] | Board for communication; copying all adapters would increase Forge scope. |
| Data schemas | Versioned message data. [Message docs][Bmessagesdocs] | Operation input/output schemas and block contracts. [Blocks][Fblocks] | Board for attaching typed facts to conversation. Forge for command validation. |
| Access | Team roles plus channel grants and profiles. [Access][Baccess] | Owner identity, device/session tokens, project boundaries. [Cloud][Fcloud] | Forge for one owner on admitted devices; Board for varied team channels. |
| Recovery | Local backend exists; comparable hosted restore contract not established. [Local][Blocal] | Admin dump/restore with authority reset. [Restore][Fproject] | Forge has a more explicit recovery contract in reviewed material. |
| Hosting | Hosted API hides database operations from its user. [README][Breadme] | Cloudflare Worker authority plus local device work. [Cloud][Fcloud] | Board is easier to start on Vercel. Forge retains its chosen provider boundary. |
| Dependencies | Three direct package dependencies; sync adds integrations. [Registry][Bnpm], [Sync][Bsync] | Package declares MCP server, Koffi, YAML. [Package][Fpackage] | Neither total cost is settled by a direct-dependency count. A notification POST can avoid adding an SDK. |
| CLI/MCP | Small common loop; much larger full command/API inventory. [Catalog][Bcatalog] | Generated block operations used by CLI/MCP. [Work][Freadme] | Board has easier first-use messaging. Forge should hide complexity through skills and discovery. |
| Price and maturity | Experimental, free for now. [Overview][Bhome] | This research did not inspect Forge's live release or operating bill. | No cost winner established. |

Absence statements in the table mean “not established in the specified source review.” They are rung 2 or lower and are not claims that a feature is impossible or absent from every deployment.

### Fit with the approved cut list

The cut list retains identity, project scope, one revision-checked authoritative write, replay receipts, leases, externally verified merge facts, owner-only resume, and safe restore. Machine work stays on the machine. It explicitly keeps lane journals, owner asks, merge verdicts, and budgets on the device. Cancellation of already-running work is deferred beyond the first release. [Approved cut list][Fcut]

Therefore a phone reply service must not silently promote the full lane journal into shared cloud authority. For ordinary questions, the smallest cross-device addition is a **bounded mailbox** containing only request routing, brief/context revision, deadline, answer, and acknowledgement. It is a proposed change to that boundary and needs an owner decision.

The device remains responsible for interpreting a planning answer and advancing its lane. Shared resume continues through the existing owner-approved Worker route. No server mirror of the lane workflow is needed.

### Ideas worth adopting

All rows are proposals, not implemented behavior. Small means one narrow adapter or presentation change. Medium crosses device/server boundaries. Large adds a general platform or several integrations.

| Idea | Smallest useful Forge version | Rough size |
| --- | --- | --- |
| Conversation stays with the work | Put the question, exact options, selected answer, and outcome in the issue/lane context. Send the phone only a compact brief and link. Reuse existing comments. | Small |
| Read once, then wait from a cursor | Add an opt-in “wait for this request's answer” operation with a cursor/version. Return existing answers before waiting. Use bounded long polling first. | Medium |
| Structured decision data | One closed schema for request and response. Reuse Forge's schema machinery. Do not introduce a general message-schema registry. | Small locally; medium with cloud mailbox |
| Explicit waiting state | Mark one request pending, answered, denied, expired, or canceled. Show why it is waiting. Keep timeout as hold. | Small locally; medium across machines |
| Notification adapter | One configured HTTPS sender. Deduplicate by request plus reminder sequence. Support a link-opening notification first. | Small |
| Event-driven resume | The device polls its mailbox or reconnects from a cursor. A chosen harness receives one wakeup. No permanent remote shell or arbitrary callback URL registration. | Medium |
| Reminder with limits | One expiry and one reminder/escalation policy per request. Stop reminders on answer or cancellation. No general cron service. | Small to medium |
| Better agent errors | Show machine-readable reason, request status, and exact next command. Reuse the block contract. | Small |
| Batch questions | One phone digest with clearly numbered requests, each retaining an independent ID/version. Do not turn digest position into identity. | Medium |
| Viewer | A read-only issue/lane/decision view, followed by an authenticated response form. Skip a full kanban board and chat UI. | Medium |

### What Forge should not copy

- Do not adopt channel ACLs, generic schemas, reactions, file hosting, and three-platform sync together. They solve Board's team communication scope. Forge can start with one outgoing notice and one response path. [Board concepts][Bconcepts]
- Do not treat a named profile or a natural-language “approved” as independent owner identity. Board's own guidance warns about shared human/agent credentials. [Actors][Bactors], [Approval guide][Bslack]
- Do not copy the deployed inspector's application-handle identity model for an authorization page. A visitor-chosen name is unsuitable for owner proof. [Inspector][Binspect]
- Do not use a mutable status label or an agent-reported completion as merge evidence. Preserve Forge's verified-close path and explicit exception record. [Labels][Blabels], [Forge evidence][Freceipt]
- Do not add a hosted software factory to obtain a phone button. Board's factory requires deployed routing and agent compute. [Factory guide][Bslack]
- Do not promise that a stop kills work already running. The approved cut list explicitly defers that behavior. [Cut list][Fcut]
- Do not replace dump/restore with conversation export. Restored data must not revive old permission. [Forge restore][Fproject]

What matters in Forge beyond the inspected Board contract is independently verified owner resume, lease-fenced issue writes, server-checked merge evidence, and restore that resets authority. Forge also has device worktrees, budgets, and memory/decision adoption. Board supplies communication patterns around these jobs, not proof that those boundaries are redundant. [Forge cloud][Fcloud], [Work][Freadme], [Memory][Fmemory]

## 5. Three phone options, ranked by integration cost

All three share the same rule: notifications are hints. The authoritative request must still be pending, current, unexpired, and owned by the right person. The phone should show project, issue, requesting agent/device, reason, exact operation or question, choices, default hold, expiry, and a context link.

### Option 1. Existing app notification plus Forge browser page

Start with GitHub Mobile if already installed. Reuse an existing relevant issue/PR thread where appropriate. For ordinary private lane questions, use a designated private notification destination rather than exposing details in a public repository. The notice carries an opaque request reference, safe short summary, and Forge URL. The browser handles the actual answer. GitHub supports mention push and mobile discussion. [Mobile][Gmobile], [Notifications][Gnotify]

For shared lane resume, the approval record/page already exists. A device bridge must still read the resulting status and call the existing resume operation with the approved request. If current output cannot expose a terminal denied/expired result, add a narrow status read. Notification-only delivery does not complete the return path.

For general free-text questions, this option still needs the bounded mailbox and a small authenticated form. A notification adapter alone cannot collect those answers. The server need not store the whole lane.

Cost: **small for existing resume notifications and return-status handling; medium for general question/answer**. No new native app. If the owner already uses ntfy or Pushover, the same link architecture can use that app instead. [ntfy][Nhome], [Pushover][Papi]

Security model, exactly three lines:

1. A link thief can see the current link-readable preview metadata; require owner sign-in before adding private context or accepting an answer.
2. Someone with the unlocked phone and a usable owner sign-in may act as the owner; require fresh authentication for consequential operations.
3. Forge consumes one current request once; expiry, cancellation, changed scope/head, and a new stop invalidate old answers.

### Option 2. One Telegram bot, or Slack if that is already the owner's daily app

Send a private message with choices plus “Reply with details.” Use button payloads or a reply to the exact question. Pin the owner's platform ID at enrollment. Store the platform message-to-request mapping and deduplicate deliveries. Telegram's free Bot API is suitable for one owner. Slack gives a richer modal flow but adds workspace/app configuration. [Telegram API][Tapi], [Telegram cost][Tfaq], [Slack actions][Sactions]

Use these replies for planning questions and low-risk choices. For protected actions, the bot's button opens Forge's owner-authenticated page. Making Telegram/Slack identity itself sufficient for shared resume would be an explicit new trust decision.

Cost: **medium**. Existing phone app, one adapter, incoming endpoint or long-polling bridge, response mapping, and mailbox. This wins over option 1 when free text must return without opening a browser and the owner already lives in the chosen app.

Security model, exactly three lines:

1. A leaked message or callback value does not authorize a reply unless the verified platform user/chat matches the enrolled owner.
2. A stolen logged-in platform account can answer ordinary questions; it cannot lift Forge's shared stop without the separate owner sign-in.
3. Verify transport authenticity, then atomically match request ID/version/deadline and consume once; delayed and duplicate messages cannot apply again.

### Option 3. A Forge mobile web inbox with push

Build a small owner-only web page showing pending requests. Add Home Screen installation and push subscriptions. Notification taps open the exact request. Offer buttons and a text box on the page. Begin with tap-to-open, since inline notification actions vary by browser. [WebKit][Wwebkit], [Notification actions][Wmdn]

Cost: **medium to large**. It adds UI, subscription enrollment/revocation, push sending, authentication, and an answer queue. It avoids a native app store release, but it is still a web product to maintain. It fits later if the owner wants one cross-harness inbox and does not want decision context in chat services.

Security model, exactly three lines:

1. A leaked push endpoint or request link supplies routing information, not owner authorization; answers require the owner session.
2. Someone with an unlocked authenticated phone can answer; consequential actions require fresh owner authentication and exact operation context.
3. Server checks origin/CSRF, pending revision, expiry, and one-time consumption; stale notifications open a terminal state instead of executing.

### Recommendation and smallest data flow

Choose **option 1 first**, conditional on an app the owner actually uses. Build **option 2 next** only if answering in chat is materially better than a browser form. Keep **option 3** for a later cross-agent inbox. Do not build a native Forge app for this requirement.

Before any feature work, try the owner's existing Codex/Claude/Cursor remote interface for ordinary agent questions. This is an operational shortcut, not a substitute for Forge's independently authenticated shared resume. [Codex][Oremote], [Claude][Cremote], [Cursor][U mobile]

Proposed flow:

1. Agent requests a decision through one CLI/MCP operation.
2. Device creates one pending request tied to project, issue/lane, device/session, question revision, and optional action/head.
3. A delivery adapter sends a short notice. It never carries the device bearer credential.
4. Owner signs in and answers, or sends a platform reply for an ordinary question.
5. Worker records one authenticated answer in a bounded mailbox. Repeated delivery returns the same result.
6. Device reads the answer from its last cursor and validates it against its still-current local ask.
7. Agent resumes once. Protected shared resume uses the existing approval consumption route.
8. Device acknowledges receipt. The mailbox retains a bounded audit record, then prunes under a stated policy.

Possible new names such as `forge decision request` and `forge decision wait` are **design sketches only**. The existing `decision.propose`/`adopt` commands concern durable decisions. Avoid confusing durable decisions with temporary owner questions; naming needs review. [Memory catalog][Fmemory]

Minimum request fields: opaque ID, project, issue/lane, requesting device/session, kind, brief, choices, free-text allowance, context revision, optional expected head/control epoch, expiry, status, and verified answer identity/time. Include a client request key so retrying creation cannot ring the owner twice.

Use compare-and-swap for pending-to-terminal transitions. Re-read the governing scope/head/stop before acting. A canceled lane, changed plan, lost lease, or changed head must not continue on an old answer. The answer is permission for the displayed request only.

A ten-minute link may expire before an owner away from the laptop sees it. Preserve the ten-minute protected authorization lifetime. Let a longer-lived question inbox generate a fresh approval request only after the owner opens it and reviews current context. A reminder must never silently extend existing permission. This is a proposal, not existing behavior.

CIBA's useful lesson is the explicit transaction binding and expiry. Number matching can help when the owner can compare a trusted second display. If the owner is away and only sees the same phone message, repeating a number from that message adds little. Show the operation and project; do not claim number matching makes a prompt trustworthy by itself. [CIBA][Aciba], [Microsoft][Anumber]

The machine running local tools must remain available. A cloud mailbox can accept the answer while it is offline, but no phone app can make a powered-off laptop execute the next action. Remote products state the same availability limitation. [Claude][Cremote], [Cursor][U mobile], [Codex setup][Osetup]

## 6. Owner decisions

These are the only unresolved product choices. No answer is required to finish this research. Silence leaves each recommendation as a planning default, never approval to execute a protected action.

1. **Which phone destination is already used?** A. GitHub Mobile plus Forge link. B. Telegram bot. C. Slack DM. D. Existing ntfy/Pushover installation. **Default: A provisionally.** Installation and actual notification use remain unknown.
2. **What should the first release answer?** A. Protected lane resume plus ordinary choices and free text. B. Protected resume notifications only. C. Full remote terminal/control. **Default: A in two slices, resume notice first, bounded question mailbox second.**
3. **What may chat identity authorize?** A. Ordinary questions only; shared resume and consequential actions require Forge owner sign-in. B. Chat identity can also authorize shared resume after enrollment. C. Every answer must use the browser. **Default: A.**
4. **May Forge add the bounded cloud mailbox?** A. Yes, routing/brief/answer only; device keeps the lane journal. B. No, send notices only and leave answers in the existing harness. C. Move all lane state to the cloud. **Default: A as an explicit cut-list amendment.**
5. **How long can an ordinary question wait?** A. 24 hours, then hold and require a refreshed question. B. One hour. C. Until manually canceled. **Default: A.** Keep protected approval tokens at the existing ten minutes.
6. **What does “ring” mean?** A. Normal push, one reminder, then hold. B. Repeated urgent alerts. C. Actual phone call escalation. **Default: A.** Select B/C only for named urgent classes.
7. **What context may leave Forge?** A. Minimal summary and opaque link; private details after sign-in. B. Full question and alternatives in a private chat. C. Full transcript/artifacts. **Default: A.**
8. **Must work continue with the laptop off?** A. No, accept/store answers and resume when its runner reconnects. B. Yes, add an always-on runner as a separate project. **Default: A.**

## 7. Coverage and limitations

Covered all requested product families: GitHub Mobile/Actions, Slack interactivity/Workflow Builder, PagerDuty, ntfy, Pushover, Telegram, web push, CIBA/number matching, HumanLayer, Claude Code, Codex, and Cursor. Covered Board's model, claiming, wakeups, human participation, approvals, auth, storage, limits, price/maturity, CLI/SDK, and vendor evidence. Covered Forge comparison, adoption/cut choices, three ranked delivery options, and owner questions.

Not verified in a running system: Board claim races, watcher retries, any phone delivery, browser login, webhook signatures, installed app availability, live Forge deployment/version, current per-account entitlements, or end-to-end resume. These are later acceptance tasks, not completed validation.

The proposed implementation's critical checks are wrong-owner refusal, stale-context refusal, duplicate answer consumption, expired/canceled requests, new-stop invalidation, link-preview safety, and offline device recovery. This research ran none of those checks.

No issue changes, commits, pushes, tests, builds, credential-file reads, package installs, browser sessions, subagents, or forks were performed. The sole requested artifact is this report.

COVERED 3 OF 3 research parts.

## Source links

All external factual claims above link to their primary source unless explicitly marked otherwise. Repository source links below pin Forge to the inspected remote snapshot. Board and product documentation links are live and may change.

[Bhome]: https://vercel.com/docs/board
[Blaunch]: https://vercel.com/blog/introducing-vercel-board
[Bchange]: https://vercel.com/changelog/vercel-board-is-now-available
[Bconcepts]: https://vercel.com/docs/board/concepts
[Bboards]: https://vercel.com/docs/board/concepts/boards
[Bchannels]: https://vercel.com/docs/board/concepts/channels
[Bthreads]: https://vercel.com/docs/board/concepts/threads
[Blabels]: https://vercel.com/docs/board/concepts/labels
[Bactors]: https://vercel.com/docs/board/concepts/actors
[Bevents]: https://vercel.com/docs/board/concepts/events
[Btasks]: https://vercel.com/docs/board/concepts/tasks
[Bsync]: https://vercel.com/docs/board/concepts/sync
[Baccess]: https://vercel.com/docs/board/access
[Bcli]: https://vercel.com/docs/board/cli-reference
[Bsdk]: https://vercel.com/docs/board/sdk
[Bswarm]: https://vercel.com/docs/board/guides/agent-swarm
[Bslack]: https://vercel.com/docs/board/guides/agents-in-slack
[Breadme]: https://github.com/vercel/board
[Bskill]: https://github.com/vercel/board/blob/main/skills/board/SKILL.md
[Bnpm]: https://registry.npmjs.org/@vercel%2fboard/latest
[Btaskdocs]: https://github.com/vercel/board/blob/main/packages/board/docs/01-board/11-tasks.md
[Bmessagesdocs]: https://github.com/vercel/board/blob/main/packages/board/docs/01-board/04-messages.md
[Btasksource]: https://github.com/vercel/board/blob/main/packages/board/src/server/tasks.ts
[Bwatchdocs]: https://github.com/vercel/board/blob/main/packages/board/docs/01-board/06-watchers.md
[Bschedules]: https://github.com/vercel/board/blob/main/packages/board/docs/01-board/07-schedules.md
[Binspect]: https://github.com/vercel/board/blob/main/packages/board/docs/03-guides/02-inspector.md
[Blocal]: https://github.com/vercel/board/blob/main/packages/board/docs/01-board/10-local.md
[Bcatalog]: https://github.com/vercel/board/blob/main/packages/board/src/cli/commands.ts
[Bclidocs]: https://github.com/vercel/board/blob/main/packages/board/docs/04-reference/01-cli.md
[Bapidocs]: https://github.com/vercel/board/blob/main/packages/board/docs/04-reference/02-board.md
[Bsecondary]: https://thenewstack.io/vercel-board-agent-swarms/
[Gmobile]: https://docs.github.com/en/get-started/using-github/github-mobile
[Gnotify]: https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications
[Gdeploymobile]: https://github.blog/changelog/2021-04-01-reviewing-deployments-on-github-mobile/
[Greview]: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments
[Genvironments]: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
[Glimits]: https://docs.github.com/en/actions/reference/limits
[Sactions]: https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/
[Sverify]: https://docs.slack.dev/authentication/verifying-requests-from-slack/
[Smodals]: https://docs.slack.dev/surfaces/modals/
[Sworkflow]: https://slack.com/help/articles/17542172840595-Build-a-workflow--Create-a-workflow-in-Slack/
[Sforms]: https://slack.com/help/articles/24720245025555-Automations--Collect-information-with-a-simple-form
[Sguide]: https://slack.com/help/articles/360035692513-Guide-to-Slack-workflow-builder
[Dmobile]: https://docs.pagerduty.com/get-started/mobile-app
[Dactions]: https://docs.pagerduty.com/integrations/custom-incident-actions
[Dbehavior]: https://docs.pagerduty.com/developer/webhook-behavior
[Dpricing]: https://www.pagerduty.com/pricing/
[Npublish]: https://docs.ntfy.sh/publish/
[Nhome]: https://ntfy.sh/
[Nissue]: https://github.com/binwiederhier/ntfy/issues/1728
[Papi]: https://pushover.net/api
[Preceipts]: https://pushover.net/api/receipts
[Ppricing]: https://pushover.net/pricing
[Pactions]: https://support.pushover.net/i158-actionable-notifications
[Tapi]: https://core.telegram.org/bots/api
[Tfaq]: https://core.telegram.org/bots/faq
[Wnotification]: https://notifications.spec.whatwg.org/
[Wpush]: https://www.w3.org/TR/push-api/
[Wwebkit]: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
[Wmdn]: https://developer.mozilla.org/en-US/docs/Web/API/NotificationEvent/action
[Aciba]: https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
[Anumber]: https://learn.microsoft.com/en-us/entra/identity/authentication/how-to-mfa-number-match
[Oremote]: https://developers.openai.com/blog/mastering-codex-remote-for-engineering
[Osetup]: https://developers.openai.com/training/walkthroughs/working-on-your-phone
[Cremote]: https://code.claude.com/docs/en/remote-control
[U mobile]: https://cursor.com/docs/cloud-agent/mobile
[Ucloud]: https://cursor.com/docs/cloud-agent
[Hreadme]: https://github.com/humanlayer/humanlayer
[Hhistorical]: https://github.com/humanlayer/humanlayer/blob/main/humanlayer.md
[Hremove]: https://github.com/humanlayer/humanlayer/pull/646
[Htable]: https://github.com/humanlayer/humanlayer/blob/main/packages/db/src/tables/approvals.ts
[Hresolve]: https://github.com/humanlayer/humanlayer/blob/main/apps/riptide-api/src/orpc/api/approvals/resolve.effect.ts
[Fblocks]: https://github.com/harshanandak/forge/tree/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks
[Fwork]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/forge.block.json
[Fmemory]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/memory/forge.block.json
[Freadme]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/README.md
[Fapproval]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/lane-approval.ts#L204
[Fbrowser]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/auth/lane-browser.ts#L110
[Fcommands]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/lane-commands.ts#L100
[Fbound]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/bound-lane.ts#L300
[Frecord]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/work/schemas/lane-record.input.json#L204
[Fwait]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/src/blocks/agent/schemas/wait.input.json
[Fclaim]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/issue-claim.ts#L1
[Freceipt]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/receipt-admission.ts#L44
[Fclose]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/issue-close.ts#L111
[Fproject]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/cloud/src/project.ts#L902
[Fcloud]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/docs/reference/cloud.md
[Fpackage]: https://github.com/harshanandak/forge/blob/93c1db8fa1a340846fd7abd77d25c96bc86aa456/package.json
[Fcut]: /E:/Personal-Projects/forge-new/.worktrees/briefs/forge-1385-cut-list.md

