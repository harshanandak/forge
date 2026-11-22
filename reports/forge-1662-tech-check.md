Decisions needed: none. Fix the technical contracts below before cutting builder briefs. Keep the owner's first-pass scope.

# Verdict

- Phone ask loop: **FIX, 3 P1, 6 P2, 0 P3**.
- Brief and home: **FIX, 3 P1, 5 P2, 0 P3**.
- Teams and Slack: **FIX, 4 P1, 4 P2, 0 P3**.

P1 blocks building from the plan. P2 requires at least another PR, or risks that much rework. Counts are per affected plan; the shared terminal-answer and scheduling findings count once in each affected plan. These are plan defects, not claims that unbuilt code has already failed.

All repo evidence below is from the tracked `origin/main` at **34c6c47784fdfa3372a09f0855e23d89fb48dc5e**, read on 2026-11-22. I did not fetch, run tests, build, install, deploy, browse, or make web requests. Git history and source were read only. R2 means **pointed at the line**. Source-based consequences are identified as inferences. Estimates and supplied trial results are R1, **said so**, in this independent review. I did not reproduce those trials.

Plan citations use these names:

- Ask: `.overseer/reports/forge-1662-tech-ask-loop.md`.
- Home: `.overseer/reports/forge-1662-tech-brief-home.md`.
- Team: `.overseer/reports/forge-1662-tech-teams-slack.md`.

## 1. Repo facts

### Findings

| Id | Plan | Severity | What is wrong | Evidence with file and line | What to change |
|---|---|---|---|---|---|
| R-A1 | Ask | P1 | The plan mints an already-approved lane row, but the current consumer accepts only a pending row without a decision and consumes a relayed reply. The fallback to an existing lane approval page is also gone. The approval JSON does not say which choice grants or denies. Builders cannot connect the proposed phone answer to lane resume as described. | R2: Ask:57,110,195,231,282. `origin/main:cloud/src/lane-approval.ts:130` checks pending and no decision; :171 consumes a Relay and :181 records method relayed. `cloud/src/lane-commands.ts:108,165` parses and consumes that relay. Commit 43626a7e, PR 701, removes `cloud/src/auth/lane-browser.ts`. | Specify a separate verified-session approval decision and consumer, including deny, exact operation/scope, requester token/device/session, ask digest and current control incarnation/epoch. Preserve one single-use acceptance boundary in Project. Use a durable idempotent protocol between that boundary and the mailbox. Add Clerk begin options and verified authentication time explicitly; fail closed if fresh proof is unavailable. Remove the nonexistent browser fallback. |
| R-A2 | Ask | P1 | Adding ask operations to the known-operation list is insufficient. The command decoder obtains declarations from the work block, then requires the operation to exist in that manifest. Ask operations live in a different manifest. | R2: Ask:48,223. `origin/main:cloud/src/issue-commands.ts:65-82,145-149` exposes work declarations and checks `operations[op]`. `src/assembly/cloud-authority.ts:104-112` routes only work. | Define a block-aware command dispatcher with the ask manifest, input/output validation, context and effects. Keep work dispatch unchanged. Name its registration/composition files in slices 1 and 3a; do not merely append names or bypass validation. |
| R-A3 | Ask | P1 | The exact Board import recipe exports only the engine. The storage adapter being copied also imports Board's private SQL helpers and patched SQLite event store. Those imports still have no promised stable entry. | R2: Ask:207-208. Local trial `.overseer/spikes/forge-1761-board-on-do/storage.ts:1-3` imports `sql-D0MqINA6.mjs`, `trial-event-store.mjs` and `trial-engine.mjs`; `prepare.ts:12-18` patches two build files. These are trial facts, not remote repo facts. | Make the patched package export every required adapter dependency, or bundle one maintained adapter entry that exports them. Inventory all three imports and license notices. The hosted install/bundle check must exercise the production import paths, not the trial's direct node_modules paths. |
| R-H1 | Home | P1 | The main derivation assumes the tracker remains on the laptop, although the target journey starts with cloud-bound projects. Peer opens are local, generic cloud state cannot read work, and unsupported bound project writes refuse. The plan lacks an authoritative read path for current cloud work and a valid location for its local view writes. | R2: Home:32,58-70,213. `origin/main:src/assembly/levels.ts:507-523` opens local SQLite in the caller's namespace. `src/assembly/cloud-authority.ts:47-60,75-112` refuses unsupported project writes and does not serve board/tree/events. `cloud/src/state-access.ts:72-78` refuses `forge/work` even if configured. | Split local and cloud source adapters. Add bounded typed cloud reads/feed at Project for the admitted work facts; do not grant raw work state. Put device-local summary/share/cache records in declared device storage, or define their cloud operations. Test a bound project with an old local tracker so the home cannot silently show it as current. Budget those PRs in S2/S3/S8. |
| R-H2 | Home | P2 | A stored device registry exists, but it is not a block API for enumerating all projects. Peer lookup takes a known id/name, returns only the current block namespace, caps peers at eight, and exposes a device-store id rather than the shared manifest id in PeerLookup. Reusing it as is cannot enumerate and derive every project as S5 promises. | R2: Home:49,60,86,197,215. `origin/main:src/assembly/levels.ts:30-32,70-86,398-441,499-523` and `src/ports/state.ts:102-131`. | Add a bounded registry-list capability and a scoped peer feed/snapshot operation. Return both device registry identity and shared project identity. Page more than eight projects across calls. Do not expose filesystem roots to the block or phone. |
| R-T1 | Team | P1 | The plan calls the current lane path a server approval-id consumer that refuses a relayed quote. It does the opposite on this ref. Therefore protected team approvals cannot safely be implemented by the stated reuse alone. | R2: Team:90,94,171,191. `origin/main:cloud/src/lane-commands.ts:108-109,165-173`; `cloud/src/lane-approval.ts:74-86,130-137,171-193`. PRs 685 and 701 deliberately changed this path. | Depend on the corrected phone approval consumer from R-A1, then add current member/role checks at consumption. Enumerate which protected operations have an actual enforcing consumer. A Slack link or a boolean protected flag must never itself grant publish, merge, deploy or resume. |
| R-T2 | Team | P1 | The plan defers deciding how cloud code can use team implementations until T1. The existing boundary explicitly covers cloud and also rejects team build output imports. The separate build entry is not an exemption or an installed loader. | R2: Team:162-165,180,255. `origin/main:test/structure/team-boundary.integration.test.ts:88-109,283-288,402-500`; `test/structure/lib/imports.ts:187-195,261-264,335-338`. The historical team plan at `docs/work/2026-11-10-teams-phase1/plan.md:41` says to retain this rule. | Choose the composition before T1: public membership/storage contracts with team code importing public code, and a team-owned composition that injects the implementation. Name the entry, exports, deployment config and CI compile target. Do not weaken or exempt the boundary. |

### Claim-by-claim verification

These tables check the implementation-bearing existing-code assertions. Future file names in slice tables are proposals, not assertions that those files already exist. Paths below are all on the recorded remote ref unless explicitly called local trial. A TRUE entry establishes source text, not deployed behavior.

| Ask claim | Result | Evidence and qualification |
|---|---|---|
| cloudRoute currently routes only work | TRUE | R2: `src/assembly/cloud-authority.ts:104-112`. |
| command route checks admitted project and bearer shape before Project | TRUE | R2: `cloud/src/worker.ts:77-110`; token validity is checked later in Project. |
| Project and Worker already know arbitrary block commands | FALSE | R2: work manifest check in `cloud/src/issue-commands.ts:65-82,145-149`; R-A2. |
| report session uses owner-only Clerk proof | TRUE | R2: `cloud/src/auth/report-session.ts:97-110`. |
| cookie is __Host-forge_report and age is 900 seconds | TRUE | R2: `cloud/src/auth/report-session.ts:8,15`; `cloud/src/report-http.ts:1`. |
| session persistence stores only the deadline | TRUE | R2: `cloud/src/adapters/workers-oauth/report-session-store.ts:26-41`. |
| report wiring lives in configured Worker composition | TRUE | R2: `cloud/src/adapters/workers-oauth/compose.ts:170-197`. |
| report pages are no-store and script-src self | TRUE | R2: `cloud/src/report-http.ts:2-5,22-24`. The CSP is not a complete policy for the planned JSON-fetch app. |
| lane approval binds token, device, session, project, policy and control generation | TRUE | R2: `cloud/src/lane-approval.ts:95-114`. |
| lane request expires after 600 seconds | TRUE | R2: `cloud/src/lane-approval.ts:275-278`. |
| approved row can be consumed using today's lane path | FALSE | R2: `cloud/src/lane-approval.ts:130-137,171-193`; R-A1. |
| an existing lane browser page is a viable fresh-login fallback | FALSE | R2: deletion in remote history commit 43626a7e; current consumer is the relay path above. |
| Project has an existing receipt-maintenance alarm | TRUE | R2: `cloud/src/project.ts:367-395`; it exits when there is a v3 root. |
| default Worker entry returns 503 | TRUE | R2: `cloud/src/local-only.ts:1-18`; `worker.ts:274`; OAuth `compose.ts:370`. |
| example config points to OAuth compose and sets nodejs_compat | TRUE | R2: `cloud/wrangler.example.jsonc:9-11`. |
| agent block manifest supplies operation schema/context/effects/timeout metadata | TRUE | R2: `src/blocks/agent/forge.block.json:15-57`; wait input schema exists, 21 lines. This does not provide ask transport automatically. |
| preview can use the configured factory rather than closed default | TRUE, conditional | R2: factory at OAuth `compose.ts:170-197`. Named DO exports and config/preflight changes are still required, P-A1 below. |
| install manifest/icon/report-app code from PR B is already on main | UNVERIFIABLE as a future dependency | Remote ls-tree for `cloud/src/report-app.ts` and `app-assets.ts` returns no files. Ask itself calls PR B unmerged. Keep slice 9 responsible if it has not landed; absence search is R1. |

| Home claim | Result | Evidence and qualification |
|---|---|---|
| accepted state events have a store-wide SQL sequence | TRUE | R2: `src/core/state/index.ts:1612-1622`. |
| StateEvent JSON already exposes that SQL sequence | FALSE if relied on | R2: `schemas/state.json:30-43` has no sequence field and closes additional properties; S2 must add a feed envelope, not change this closed schema accidentally. |
| events(namespace,key?) returns an unpaged ordered namespace history | TRUE | R2: `src/core/state/index.ts:1568-1576`. |
| current block state is namespace-limited | TRUE | R2: `src/ports/state.ts:1-2`; peers preserve namespace at `levels.ts:517-521`. |
| history pages one key | TRUE | R2: `src/ports/state.ts:38-45,75-76`. |
| retired history can refuse CHECKPOINT_REQUIRED | TRUE | R2: `src/core/state/index.ts:1578-1595`. A cursor feed needs checkpoint baseline rules. |
| issue board/events/tree/lane control exist in the work manifest | TRUE | R2: `src/blocks/work/forge.block.json` operations; tree at :305, events at :249, control at :416. They are not all cloud-served. |
| check block owns receipt schema; assembly exposes forge.receipts | TRUE | R2: `src/blocks/check/schemas/receipt.json:4-14`; `src/assembly/providers.ts:211`. |
| decision.list and memory.proposals exist | TRUE | R2: `src/blocks/memory/forge.block.json:158-198`; proposals are device context, decisions project context. |
| device project registry stores name/root at project/id | TRUE | R2: `src/assembly/levels.ts:25-32,319-331`. |
| peer lookup is a reusable all-projects enumeration API | FALSE | R2: `src/assembly/levels.ts:70-86,499-523`; R-H2. |
| shared manifest identity and registry identity are interchangeable | FALSE | R2: `src/assembly/levels.ts:38-45,386-388,405-413,515-516`. Own store distinguishes projectId from identity.id; PeerLookup does not carry that shared id. |
| Worker admits one project for typed commands and state | TRUE | R2: `cloud/src/worker.ts:89-106`; `docs/reference/cloud.md:40`. Raw/admin routes are a stated exception. |
| adding forge/view to the exact namespace allowlist is permitted | TRUE | R2: `cloud/src/state-access.ts:62-78`; reserved namespaces are refused. |
| state transport sends once, refuses redirects, caps replies at 1 MiB | TRUE | R2: `docs/reference/cloud.md:168-172,178`. |
| only POST /app/seen can write seen records after that generic grant | FALSE | R2: `cloud/src/state-commit.ts:123-127` writes supplied entries throughout the granted namespace; N-H1 below. |
| current owner asks use autopilot-ask and never default on silence | TRUE | R2: `src/blocks/work/README.md:98`; it describes local lane asks, not the new mailbox. |
| report session covers all proposed app routes today | FALSE as an existing fact | R2: `cloud/src/auth/report-session.ts:29-44` handles sign-in, logout, callback and /app/; unknown /app children return 404. A1 correctly requires an extension. |
| six delivery skills exist | TRUE | R2: remote tree contains forge-build, forge-cut, forge-intake, forge-land, forge-loop and forge-review. Scheduling behavior outside Forge remains R1. |
| mock renderer has 2,193 lines | TRUE, local artifact | R2: counted the supplied HTML file; embedded view data starts at :428. It is not production source on origin/main. |

| Team claim | Result | Evidence and qualification |
|---|---|---|
| PersonDirectory binds a verified issuer/subject | TRUE | R2: `team/identity.ts:15-19`, 21 lines total. |
| directory is an in-memory store with revisioned member edits | TRUE | R2: `team/directory.ts:19-50,102-112`, 114 lines total. |
| roles are owner/admin/member and last owner is protected | TRUE | R2: `team/directory.ts:2,108`. The plan deliberately trims admin. |
| migration descriptions cover persons, bindings, orgs, memberships, default teams | TRUE | R2: `team/migrations.ts:15-39`, 42 lines total. They are descriptions, not an installed SQL store. |
| no current production caller wires the directory | TRUE within inspected paths | R2 for known definitions and tests; R1 for absence. Case-insensitive remote grep for OrganizationDirectory, team/directory and team/identity across src, cloud, team and test/team found definitions and test imports. |
| public imports from team build are refused | TRUE | R2: `test/structure/team-boundary.integration.test.ts:88-109`; this includes cloud. |
| AuthorizationPort exposes single-owner/team | TRUE | R2: `src/ports/authorization.ts:7-20`. |
| singleOwnerPolicy refuses team | TRUE | R2: `src/ports/authorization.ts:25-31`. |
| auth composition takes an optional team port | TRUE | R2: `cloud/src/auth/compose.ts:48-52,74-80`. |
| Worker never selects team at the current authorize call | TRUE | R2: `cloud/src/worker.ts:246`; no authority argument, so composition defaults single-owner. |
| fct-shaped requests skip that OAuth policy | TRUE | R2: `cloud/src/worker.ts:238-246`; typed commands also go directly to Project at :89-110. |
| token rows bind device/session but have no person | TRUE | R2: `cloud/src/tokens.ts:7-12,140-161`. |
| final token check is synchronous before write | TRUE as intended API contract | R2: `cloud/src/tokens.ts:136-140`. New cross-object awaits must not invalidate it. |
| device approval and mint both recheck owner | TRUE | R2: `cloud/src/auth/device-browser.ts:281-298`; `project-login.ts:251-271`. |
| approving identity is saved on challenge | TRUE | R2: `cloud/src/auth/device-login.ts:206`. |
| ready mode excludes live leases and unfinished dependencies | TRUE | R2: `cloud/src/issue-list.ts:40-42,134-171`. |
| lane resume refuses relays and consumes only an approved server id | FALSE | R2: `cloud/src/lane-commands.ts:108-109,165-173`; R-T1. |
| device tokens are absent from dumps | TRUE | R2: `cloud/src/dump.ts:1-2,44-76`. This alone does not prevent restored members logging in again. |
| backup needs only one table added | FALSE as a sufficient recipe | R2: current dump table whitelist at `cloud/src/dump.ts:44-76`; proposed person/binding/member data in Team:104-124 spans distinct records and references. A representation and validators are still needed. |
| Board waits require an awake object in the merged design | FALSE | Team:256 describes Board HTTP wait, but Ask:39,53,193 specifies a separate hibernating WebSocket and uses Board only for log positions. No extra cost finding for the discarded wait design. |

I found no additional source contradiction in the existing cookie name, session deadline, namespace allowlist, receipt ownership, ready filtering or directory role rules after the reads above. External push package compatibility, Clerk free-tier capacity and real Slack behavior remain UNVERIFIABLE without running or external access; they are assumptions, not passes.

## 2. Plans against each other

### Findings

| Id | Plan | Severity | What is wrong | Evidence with file and line | What to change |
|---|---|---|---|---|---|
| X-1 | Ask, Team | P2 | Ask accepts ordinary answers using a device token. Team says any device-token caller is refused and agents never answer for a person. An agent holds the same token, so marking that answer terminal does not prove a human answered. | R2: Ask:6,126-136,225; Team:31,138,185. This is a plan contradiction, not an observed exploit. | Set one rule before the first answer slice. Recommended contract: device tokens may propose/comment, human answers require a verified person session or linked Slack. If terminal answers stay, label them agent/device answers and exclude them from human-answer authority. Update both plans, schemas and the first-try assertion together. |
| X-H1 | Home | P1 | Provisional defaults and undo have no producing operation or state machine. The second answer that S13 relies on is refused by Ask's immutable first-answer-wins contract. No slice specifies when safe defaults execute, who executes them, or how reversal completion is proved. | R2: Home:37,75,162-170,223; Ask:114,136,145. Live issue forge-1762 explicitly requires defaults taken provisionally with undo. | Add a provisional-action record and explicit execute/acknowledge/reversal-request/reversal-result operations. Keep the original human answer immutable. Bind reversal to the original action, scope and current authority, with refused/uncertain states. Own the shared mailbox contract change in one lane. |
| X-H2 | Home | P2 | The home ask schema is not a projection of the planned ask API: short vs title, stops vs stopsWork, open vs pending, numeric default vs keyed option, and waitingSince vs createdAt. The ask.show example does not even return the fields needed to render a home card. | R2: Home:162-170,186-187; Ask:92-114,147-155. | Specify a versioned mailbox read/list result containing the stored question and required metadata, then one view projection. Do not add competing ask tables or make the home read Board tables. Budget that API work before S9. |
| X-T1 | Team | P1 | Active membership at answer time cannot be guaranteed by an asynchronously pushed mirror. A removed person can answer in the acknowledged mirror gap. Merely fetching membership before a mailbox await leaves another gap. This is ordinary write authority, which the brief never defers. | R2: Team:69,73,78,138,252; Ask:36-37,57 separates Project and AskMailbox. The failure case is explicitly admitted by Team:252. | Choose a single authority for the membership-sensitive answer acceptance. For example Project commits membership check and authoritative answer synchronously, and mailbox/Board are projections. Define handoff and removal ordering under the same boundary. A cached epoch without a final authoritative fence is insufficient. |
| X-T2 | Team | P2 | Team replaces the ask and answer shapes rather than extending them compatibly. It needs stable person ids, route, target, protected action semantics and membership epochs that Ask does not expose. | R2: Ask:94,106,114,125-130; Team:128-144. | Freeze a canonical versioned ask/answer contract before A1. Preserve issuer/subject proof, briefDigest, requester binding, acceptedAt/sequence and approval reference. Add the member person id, epoch and Slack provenance rather than replacing proof with a display name. Derive protected status on the server from the operation. |

### Every declared assumption

| Consumer assumption | Compared with Ask | Result and dependency |
|---|---|---|
| Home A1, owner session gates app routes | Ask:41,54-56,72,228 | Aligned intent. Not yet an exported session verification API; factor one from the request handler rather than have each route parse cookies. |
| Home A2, installable same-Worker shell with self scripts | Ask:40-42,196,229 | Partly aligned. Ask prioritizes server-rendered forms, no browser copy, and only a service worker initially. Home requires a JS renderer, JSON requests and local UI storage. Agree static asset routing and CSP, including same-origin connect permission, before S9/S10. |
| Home A3, ask and answer route bound to request/project/device/session | Ask:92-155 | Core intent aligned; wire shape is not, X-H2. Provisional resolution and superseding answers are absent and incompatible, X-H1. |
| Home A4, Worker can read mailbox without laptop | Ask:37,49,53 | Mailbox storage and internal fetch exist in the design, but only command calls through Project are specified. Add a bounded session-authorized list/read API, owner-scoped, without forwarding arbitrary browser authority headers. |
| Team A1, allowed answerers and immutable answer provenance | Ask:106,114,125-136 | Aligned for a team of one; person identity mapping and channel policy differ, X-1/X-T2. |
| Team A2, Board in one mailbox DO per project | Ask:37-38,191 | Aligned. Forge, not Board middleware, remains answer authority. Membership needs X-T1. |
| Team A3, owner phone session based on report session | Ask:41,72,194 | Aligned for owner. Making sessions per member needs binding a server-stored verified person and epoch; the current backend stores a number only. |
| Team A4, web push updates and ladder 0/5/15/30 | Ask:20,51,58,233-235 | Same ladder. Team says one notification per ask, Ask uses one tag per person across asks at :179. Retain one per person to satisfy ten asks/four threads as one notification. No new finding beyond X-T2 and N-A2. |
| Team A5, agent waits and wakes | Ask:53,59,227 | Aligned. Team's awake-HTTP-wait risk at :256 is stale; keep the hibernating socket. |

### Required field reconciliation

| Need | Ask actually specifies | Required shared decision |
|---|---|---|
| Who may answer | Array of kind/person id, only owner accepted | Use one stable person-id set with explicit expansion rules for team selection. Snapshot eligibility separately from routing. |
| Route and current target | Neither in stored ask | Add personal/team and current target in the shared contract; choosing a channel must not grant answer permission. |
| Protected kind | question/approval/memory-proposal/decision-proposal plus approval op/scope | Team uses question/publish/merge/deploy/resume and a protected boolean. Separate semantic ask kind from protected operation; compute the latter server-side. |
| Provenance | verified issuer/subject, proof, session digest/device, digest, accepted time | Team's by/person, memberEpoch and Slack ids extend this; they must not erase the verified identity or bound request. |
| State and losers | pending/answered/withdrawn/expired; losing caller gets ASK_CLOSED | Team calls state open and treats loser as a comment, not error. Store the comment but return a truthful typed outcome agreed by both. |
| Safe default and undo | defaultSafe flag, no autonomous execution | Home needs the separate action/reversal state machine in X-H1. |
| Per-person seen | Not in Ask | Home owns seen markers; Team A2 must depend on that contract or define a smaller ask-only seen marker explicitly. |

No additional mismatch was found in the choice to isolate Board behind Forge reads, pin Board 0.54.0, keep protected answers off Slack, or keep cloud model calls out. I compared both plans' full assumption lists and the three JSON shape sections.

## 3. Slice sizes

| Id | Plan | Severity | What is wrong | Evidence with file and line | What to change |
|---|---|---|---|---|---|
| S-A1 | Ask | P2 | Nineteen PRs treats contract, patched engine, command routing, phone auth, approval protocol and recovery as one PR each despite missing work at those boundaries. | R2 for inspected files/history below; estimates R1. Ask:220-240. | Plan 25-39 PRs with the splits below. High end is ordinary implementation uncertainty, not hardening deferred by the owner. |
| S-H1 | Home | P2 | The 17-21 total omits bound-project adapters, enumeration and protected seen storage, and gives undo two PRs without an execution protocol. The claimed sum is also off: the table's own PR column adds to 19-22, not 17-21. | R2: Home:211-225; arithmetic over its table. | Plan 25-36 PRs. Make source adapters and action protocol explicit before page work. |
| S-T1 | Team | P2 | Five team PRs cannot cover SQL identity/membership, browser join, tokens, composition, synchronous authorization and safe recovery at the stated small-PR target. The team-first phone row has a missing dependency. | R2: Team:180-196; source sizes and comparable history below. | Plan 22-35 PRs, keeping SQL/identity, browser flow, token fencing, composition and recovery reviewable separately. |

Measured target and distribution, supplied by the brief: target 150 added non-test lines, median 122, p75 219; security cap 330. I accept those measurements as R1 rather than rerun their measurement script. I read file line counts and `git log origin/main --since=2026-11-08` for the touched paths, then inspected comparable commits with `git show --numstat`. Historical examples sometimes exceed the current target; they establish scope, not permission to exceed the cap.

| Comparable | Remote change | Added non-test lines inspected | Why it matters |
|---|---|---|---|
| Session | PR 730 (928ca7c1) | 240 across session, backing store, HTTP, composition and CI | One small owner session alone consumed a security PR. |
| Approval request | PR 536 (99f224a6) | 256 | Request/binding creation without the whole browser or consume journey. |
| Approval consume | PR 545 (b27482dc) | 142 | Consumer plus lane transition, separate from request and browser PRs. |
| Device browser | PR 436 (517e6808) | 558 | Browser state and callback protections spread across six source files plus docs. Use as a split-size warning. |
| Team directory | PR 377 (bb46aa76) | 178 | In-memory rules and migration descriptions, no SQL, join or token wiring. |
| Team build | PR 381 (6b4bcf16) | 21 | Only build separation; no working team composition. |
| State admission | PR 551 (1e8d9bb7) | 199 | Namespace policy, authenticated routes and protocol wiring. |
| State read | PR 554 (a81c77f0) | 266 | Bounded reads/version pins, without the write side. |
| State commit | PR 555 (0241c439) | 279 | CAS, replay and admission, without the read side. |
| Remote client | PR 567 (e3592cb2) | 263 | A single remote adapter and transport integration. |
| Export | PR 629 (89a202f3) | 275 | Read-only verified-backup export and block wiring. |
| Paged dump | PR 341 (74b53a4d) | 450 | Paging alone touched dump, Project, store and docs. Not a model for a 330-line PR. |
| Issue list | PR 621 (793d828b) | 200 | Indexed cloud list, dump/index integration and rendering. |
| Proposal list | PR 329 (832b6852) | 241 | A single grouped list operation, schema, manifest and docs. |

File sizes read on the remote ref: work entry 7,131; work manifest 611; state owner 2,631; levels 543; providers 1,199; cloud client 320; cloud authority 325; Project 1,317; Worker 274; command handler 385; issue list 197; lane approval 295; lane commands 253; token module 169; report session 130; report store 44; device browser 454; device login composition 341; dump 1,109; state access 86; receipt schema 222; team directory 114; identity 21; migrations 42. The trial adapter is 75 lines, preparation 20 and Worker 59. New ask/view files have no existing size. Page comparison uses the supplied 2,193-line mock; there is no current production home page to count.

Each row below judges the original PR count and line range. Revised lines are planning allowances for the entire slice, excluding tests, not a per-PR allowance. Split each security PR before 330; normally aim near 150. Shared fixes are charged once within each plan's rows, not as extra unlisted PRs.

### Ask slices

| Slice | Plan PRs / lines | Review, revised PRs / lines | Size evidence and split |
|---|---|---|---|
| 1 contract | 1 / 160-230 | Low, 2-3 / 280-450 | Six operations with schemas/docs plus routing. Agent manifest alone is 62 lines for four operations; Proposal list is 241 for one operation. Separate contract from transport registration. |
| 2 Board | 1 / 140-220 | Low, 2-3 / 260-480 | Trial glue is already 154 lines before production exports, patch, mailbox, binding/migration, outbox interface and CI. Split import adapter from DO wiring. |
| 6 preview | 1 / 30-60 | Conditional, 1-2 / 80-180 | Factory exists, but exports, profile-specific preflight, isolation and deploy instructions do not. Compare State admission. |
| 3a create/show/list | 1 / 180-260 | Low, 2-3 / 300-520 | Project/385-line command decoder, new records/replay and bounded listing. Compare Issue list and State commit as separate changes. |
| 3b withdraw/mirror | 1 / 100-150 | Plausible, 1 / 120-180 | Narrow transition plus idempotent issue-comment outbox if 3a already supplies replay. |
| 4 answer | 1 / 180-260 | Conditional, 1-2 / 180-320 | First-wins transaction, losers/provenance and shared channel policy. Compare Approval consume. |
| 5a socket server | 1 / 140-210 | Conditional, 1-2 / 180-300 | New route does not match Worker's current route regex; auth, backlog, hibernation and detach need integration. Remote client is 263 for one adapter. |
| 5b wait client | 1 / 120-180 | Plausible, 1 / 130-200 | Reuse cloud credential transport, finite tool deadline and cursor result. |
| 7 phone ask | 1 / 200-290 | Low, 2-3 / 300-500 | Session extraction/return binding and form write protection, then one page. Compare Session's 240 lines before question UI. |
| 9 install/assets | 1 / 70-130 | Conditional, 1-2 / 100-240 | One PR if PR B supplies manifest/icons/assets; two if it does not. Do not count an unmerged prerequisite as free code. |
| 8 list/take-all | 1 / 160-240 | Conditional, 1-2 / 200-360 | Grouped rendering plus a bulk action with per-ask digest and partial outcomes. Compare Proposal list. |
| 13 approval | 1 / 160-260 | Low, 2-3 / 300-550 | Fresh proof/session plumbing and request/consume transaction are different reviews. Current approval request and consume were 256 and 142 separately. |
| 10a subscription | 1 / 120-170 | Plausible, 1 / 130-190 | After shared app/auth/asset routes settle. Explicit bounds included. |
| 10b sender | 1 / 150-230 | Conditional, 1-2 / 180-340 | Adapter plus Worker compatibility and truthful failed/uncertain outcomes. Handwritten crypto fallback costs the second PR. |
| 11 ladder | 1 / 150-220 | Conditional, 1-2 / 180-320 | Persistent due rows, multiplexed alarms and bounded send work; preserve Board scheduler tasks. |
| 12a presence | 1 / 130-190 | Conditional, 1-2 / 150-300 | Time-zone/overnight calculations, read results and ladder changes. Table row alone understates rule code. |
| 12b controls | 1 / 130-190 | Plausible, 1 / 130-190 | Pure forms on the settled presence API. |
| 14 recovery | 1 / 150-240 | Low, 2-3 / 280-500 | Snapshot/export and restore validation/fencing across two DOs. Compare Export and Paged dump. |
| 17 instructions | 1 / 30-60 | Plausible, 1 / 30-80 | Existing loop skill 36 lines, session fragment 5. Record the exact waiter/answer behavior. |

### Home slices

| Slice | Plan PRs / lines | Review, revised PRs / lines | Size evidence and split |
|---|---|---|---|
| S1 contract | 1-2 / 150-220 | Low, 2 / 250-400 | Nested project/item/event/ask/summary/seen schemas and reference. Receipt schema alone has 222 lines. Split core document from action/seen inputs. |
| S2 feed | 1 / 150-250 | Low, 2-3 / 280-500 | Core checkpoint-aware feed plus trust/provider and cloud adapter. Compare State read/Remote client. |
| S3 derive | 2 / 250-400 | Low, 3-4 / 400-650 | Block shell and authoritative local/cloud facts, then derived state/progress/stage. Work sources span 7,131-line entry and cloud variants. |
| S4 headlines | 1-2 / 180-300 | Plausible, 1-2 / 180-300 | Fixed mappings and since-cursor envelope, after feed baseline semantics settle. |
| S5 all/share | 1 / 120-200 | Low, 2-3 / 250-450 | Registry-list/identity capability and approved share config are separate from peer derivation. Levels currently offers no enumeration operation. |
| S6 summary | 2 / 250-380 | Conditional, 2-3 / 280-480 | Prepare token/window plus per-sentence citation validation and placeholders. Three PRs if schemas/limits do not fit. |
| S7 schedule | 1 / 60-120 | Plausible, 1 / 60-120 | Template only, no new scheduler. Harness setup remains a stated assumption. |
| S8 push | 2 / 200-320 | Conditional, 2-3 / 280-480 | Bound storage/transport, allowed snapshot keys, export/restore and command reference. Compare State admission and Remote client. |
| S9 read/seen | 1-2 / 200-330 | Low, 2-3 / 280-500 | Bounded project/mailbox aggregation and separately protected seen mutation. Compare State read and Session. |
| S10 all home | 2 / 250-400 | Conditional, 2-3 / 300-500 | Data integration then rendering/action links under production CSP. Mock is a 2,193-line design artifact. |
| S11 project home | 2 / 280-420 | Conditional, 2-3 / 300-500 | Core project state then since/wrong/paused/action panels. No production page exists to reuse wholesale. |
| S12 timeline | 1 / 150-220 | Conditional, 1-2 / 180-320 | Renderer and bounded history boundary/seen marker. Define retained-history cutoff truthfully. |
| S13 default/undo | 2 / 220-360 | Low, 3-4 / 400-650 | Action execution contract, authoritative reversal request/result, then list UI. Reusing the immutable answer route cannot do it. |

### Team slices

| Slice | Plan PRs / lines | Review, revised PRs / lines | Size evidence and split |
|---|---|---|---|
| T1 membership | 1 / 150-230 | Low, 2-3 / 280-500 | Public contracts/composition, then SQL identity/member store and list. Directory 178 lines supplied only in-memory rules. |
| T2 invite/join | 1 / 180-260 | Low, 2-3 / 300-520 | Invite transaction, then browser state/Clerk callback and operation docs. Compare Device browser and Session. |
| T3 tokens/login | 1 / 200-300 | Low, 2-3 / 280-500 | Token migration/backfill and membership fences, then device approval/mint. Existing tokens 169 and browser 454 lines. |
| T4 commands/claims | 1 / 180-280 | Low, 2-3 / 280-500 | Typed/raw/state/OAuth authority must agree, then holder rendering. Worker, Project and list are distinct paths. Compare State admission and Issue list. |
| T5 removal/recovery | 1 / 170-280 | Low, 2-3 / 300-550 | Removal/revoke/claim release, then safe dump/restore without reinstating old authorization. Compare Export and State commit. |
| A1 answer authority | 1 / 220-320 | Low, 2-3 / 280-500 | Canonical schema/provenance then authoritative membership-fenced acceptance. A mirror is not a substitute. |
| A2 member phone | 1 / 200-300 | Low, 2-3 / 300-500 | Member session proof/epoch, then per-person push/settings/seen. Compare Session before per-person UI. |
| A3 handoff | 1 / 150-230 | Conditional, 1-2 / 180-320 | Atomic eligibility/routing record then CLI/forms. Preserve protected-owner policy on the new target. |
| A4 backup | 1 / 160-260 | Conditional, 1-2 / 180-320 | Alarm routing plus sleep/loop refusal and truthful target state. Requires A2 and A3. |
| A5 Slack/link | 1 / 180-280 | Low, 2-3 / 260-480 | Signed webhook/DM code binding, then linking screen/manifest/setup. Trial tested outbound DMs and existing-thread replies, not the complete new-person link journey. |
| A6 delivery/answers | 1 / 220-330 | Low, 2-3 / 300-520 | Sync/routing and then Forge answer acceptance/provenance/edits. The 67-line trial excluded this product policy. |
| A7 protected | 1 / 150-250 | Conditional, 1-2 / 180-320 | One PR only if corrected phone consumer and member checks already exist. Slack refusal and human action link then remain narrow. |
| J journey | 1 / 40-100 | Conditional, 1-2 / 40-120 | Tests excluded from line cap; fixture composition/setup still takes code. Two PRs if fixture transport needs its own change. |

These estimates do not add a native app, telephony, full restart matrices, accessibility pass, shared memory or a cloud model. Board fallback, if triggered, adds about two ask PRs as the plan itself assumes; it is not silently included in the totals.

## 4. Never-deferred list and first pass

| Id | Plan | Severity | What is wrong | Evidence with file and line | What to change |
|---|---|---|---|---|---|
| N-A1 | Ask | P2 | First-pass recovery promises history and cancellation, but does not define the verified export/restore unit across Project, mailbox authority, outbox and Board projection. Simply adding a mailbox admin export is not a verified backup. | R2: Ask:37,237,244; `origin/main:cloud/src/dump.ts:44-96` covers Project tables with a transactional watermark, not another DO. Trial `storage.ts:5-36` holds Board separately. | Specify authoritative tables, version, bounded pages, consistency watermark/freeze or reconciliation rule, validation and post-restore readback. Cancel open asks, fence grants/wait cursors, drop subscriptions and prevent restored outbox rows sending old side effects. Include the minimal hosted round-trip case now; defer the broad failure matrix only. |
| N-A2 | Ask | P2 | The owner-visible ladder promises a loud time-sensitive step and silent notification updates as facts, while its own risks say the loud step may be only a normal alert. Delivery accepted by a push provider also does not prove a phone sounded. | R2: Ask:20,58,234 versus :253,281. Platform behavior itself is unverified in this review. | State what Forge can request and record at each step, with sent/failed/uncertain provider results. Make loud/time-sensitive and replacement-on-phone explicit unproven outcomes until measured. Keep ordinary web push in first pass; do not promise a native priority level or buy telephony. |
| N-H1 | Home | P1 | seen is declared writable only by the signed-in viewer, yet it shares a namespace granted to generic device-token state/commit. An agent can submit a CAS entry for seen/owner using that same granted namespace. CAS ensures one serial writer, not the required human authority. | R2: Home:51,70,74,180; `origin/main:cloud/src/state-access.ts:70-78`; `cloud/src/state-commit.ts:123-127`. Inference: no per-key actor restriction is added by the proposed config-only grant. | Keep seen outside the device-writable namespace, or add server-owned key-family policy and a typed session-only seen operation. Bound supplied cursors to an admitted snapshot and viewer/project; restore under that policy. |
| N-H2 | Home | P2 | The required per-sentence citation check is not expressible by the shown payload, which has arrays of plain strings and one flat cites list. A builder must invent how each sentence is associated with evidence; a global nonempty cites list cannot enforce CITE_MISSING per sentence. | R2: Home:69,130-132,172-178. | Define structured summary lines with their own cites, or one exact inline citation grammar with a parser. Reject unknown/missing per-line citations and bind every line to the prepared window. Keep semantic fairness labelled unproven; presence of a citation does not establish the sentence is true. |
| N-T1 | Team | P1 | Bumping the epoch and revoking old tokens on restore does not stop an old backup from reinstating a member who was removed after that backup. They can obtain a new token through the now-active restored membership. Tokens excluded from dump do not solve this. | R2: Team:30,78,126,172,184,206. `origin/main:cloud/src/dump.ts:1-2,44-76,81` distinguishes server-local epochs from imported records. Failure case is a plan-based inference: backup active member, remove, restore old member list, log in again. | Preserve nonrollbackable removal fences outside the imported membership state, or restore non-owner memberships as inactive and require explicit owner reapproval. Restore must not grant access just because a historical member row says active. Test new login as well as replay of an old token. |

| Never-deferred item | Ask first pass | Home first pass | Team first pass |
|---|---|---|---|
| Owner approval checked by server | Intent present, blocked by R-A1 and the terminal distinction | Share uses an existing relayed-approval shape. That is a trace of claimed approval, not verified human identity; route it through the corrected human approval service for off-device sharing. Undo needs X-H1. | Protected action policy present, blocked by R-T1 and X-T1. |
| One authoritative write | Ask/answer transaction exists; grant acceptance still needs a cross-object protocol | CAS snapshots/seen exist; key authority needs N-H1 and source authority R-H1 | Project transaction is sound intent; mailbox membership mirror violates it at acceptance, X-T1. |
| Device and session identity | Requester binding and session proof included; final approval consumer must preserve them | Source device/session plus viewer marker included; distinguish trusted holder from supplied label | Person/epoch added; final synchronous checks required on every command family. |
| Project scope | Project and mailbox scoped in design | Multi-project aggregation needs shared-id mapping and per-project authorization, R-H2 | Membership must be project-local in join, Slack map and every consuming action. |
| GitHub merge proof | No new merge executor specified; must not reinterpret answer as merge proof | Landed requires verified receipt or verified cloud close; source must be current, R-H1 | Existing merge verifier should remain authoritative; human answer cannot replace it. |
| Verified backup and restore | Included late in first pass but incomplete, N-A1 | S8 includes restore case. Add bounded seen policy and cursor epoch/reset semantics when source history is replaced. | Included but old membership can reactivate, N-T1. |
| Size limits | Input, pending asks, subscriptions and presence bounded. Also cap page sizes, late-answer/history growth and alarm/outbox batches in their slice contracts. | 1 MiB document, 256 KiB/project, 500 items/200 events specified. Aggregate must page/truncate at total size and say so. | Invites, names and handoffs have limits. Set team/member/link cardinalities and per-request removal/restore work bounds before the schema PRs. |
| Truthful result states | Stored answer versus minted/spent approval must be distinct; N-A2 covers push claims | Do not label reversal complete until an authoritative result exists, X-H1. Preserve stale/truncated age/history. | A later answer/comment and removed member must have explicit outcomes; no mirror-gap success. |
| Hosted CI and independent per-PR review | Retained | Retained | Retained |

The three plans retain the allowed deferrals: extra edge-state UX, broad restart/reconnect matrices, real-phone proof, light mode/accessibility, and docs beyond command reference. Keeping real-phone proof deferred is allowed, but a deferred observation cannot be advertised as verified behavior.

Essential journey gaps: the first phone try needs corrected routing, a usable preview and a human answer boundary; the returning-owner screen needs current cloud data and an actual provisional-action producer; the team handoff needs member-fenced answer acceptance and a functioning member session. Team's visible holder name is only a first pass on forge-1169. The live epic also requires dependents and isolated competing attempts/evidence-based selection. Team:207-229 defers the attempt queue/transfer work, so do not mark the whole epic complete from this plan. That is a scope-status qualification, not a demand to add the whole epic to this train.

No additional first-pass omission was found for snooze choices, one-night sleep, initial chat link, no cloud model calls, Slack personal/team delivery, protected Slack refusal, or the two home-page levels. I checked the issue bodies for forge-1761, forge-1762, forge-1763 and forge-1169 against the slices and Left for later lists.

## 5. One build order

| Id | Plan | Severity | What is wrong | Evidence with file and line | What to change |
|---|---|---|---|---|---|
| B-1 | Ask, Home, Team | P2 | The advertised parallel lanes contain dependencies and shared-file edits. Ask wave 1 puts Board and preview on the same config; wave 5 puts list and subscription on ask-app.ts. Team runs A2 beside T1 although A2 depends on T1, and A1 beside T4 although its own exclusion forbids it. Home runs S4/S5/S8 together with the view block package still being edited, without assigning entry/manifest/schema ownership. | R2: Ask:221-222,230-232,242; Home:213-227; Team:180,185-186,196. | Use the merged waves below with explicit file owners. A lane owns one PR. Shared schema/composition/config changes merge before dependent lanes start. New sub-PRs within a row run sequentially unless file-disjoint ownership is documented. |

See Merged build order below for the complete schedule. Blocks, not dates, determine the next wave. The cloud owner journey is a predecessor, not a fourth parallel lane. The preview is its isolated owner rehearsal alternative. No new first-pass feature is being made to wait for the deferred stability matrix.

## 6. Trying it before the cloud launch

| Id | Plan | Severity | What is wrong | Evidence with file and line | What to change |
|---|---|---|---|---|---|
| P-A1 | Ask | P2 | A default export of createConfiguredWorker alone is not a complete deploy recipe. The entry needs the named Durable Object classes, the config main must change, and preflight currently rejects any non-example main. The configured factory also exposes the full rehearsal API, not just owner phone asks. Finally an already-bound checkout cannot simply log in to a new preview origin. | R2: Ask:202,222,267; `origin/main:cloud/src/adapters/workers-oauth/compose.ts:46-48,69-79,170-213`; `cloud/wrangler.example.jsonc:9,42-57`; `cloud/scripts/preflight.mjs:34-43,147-150`; `docs/reference/cloud.md:55`. | Specify a separate rehearsal profile with exact entry and required named class exports, including AskMailbox. Give it a narrow preflight contract, isolated resources/secrets and an explicit allowed-route inventory. Use a new unbound test project identity/checkout or a separately designed binding migration; never remove a live binding to make login succeed. Keep standard entry closed. |

**Judgment:** the separate preview choice is compatible with the current factory and the owner-rehearsal exception in forge-1676. It is not deployable or proven owner-only merely by adding the stated ten-line file. This is R2 architectural evidence, not a successful deployment.

What must be deployed or configured:

1. A distinct Worker name and approved rehearsal entry, exporting Project, CodeRedemption, RegistrationLimiter, GrantState and the new AskMailbox. Retain the standard closed default exports.
2. Its own PROJECTS, ASKS, redemption, limiter and grant-state resources and migrations, plus a distinct existing OAuth KV namespace. Do not bind it to production DO namespaces or reuse OAuth KV accidentally. The example currently names four DO bindings and an explicit existing KV id.
3. Nonsecret issuer/client/origin/project configuration for the preview origin, including Clerk callback registration, owner subject, state namespace policy and issue prefix. Load credentials through approved secret mechanisms without printing them. Initial auth requires the existing login HMAC/admin secrets; protected GitHub operations also require the configured GitHub App/private key and policy. Push later adds VAPID material.
4. A fresh unbound checkout/identity and login whose command origin matches that preview. A phone link alone does not make the agent's CLI target the new Worker. The cloud contract explicitly refuses conflicting origins for an existing binding.
5. One end-to-end hosted check of create, human answer, wait resume, expired/refused state and export/restore before calling it usable. Protected resume additionally needs R-A1's corrected enforcing consumer. Real-phone device matrix remains a follow-up.

What it exposes: by source, createConfiguredWorker serves report sign-in/callback plus device login, typed command/state routes, OAuth registration/authorization/token/revocation paths, raw lease routes and admin routes through createWorker. Public login and protocol initiation do not require the report cookie. Typed commands and state are constrained to FORGE_CLOUD_PROJECT; raw leases and admin routes accept other project names, as `docs/reference/cloud.md:40` explicitly says. Those paths have their own token checks, but that differs from a copy that only the owner's browser session can open. Decide and record the rehearsal route inventory in the technical profile; do not claim every path is gated by the phone cookie.

Zero paid spend is **UNVERIFIABLE** from this ref and local trials. The supplied local Board bundle is 401,024 gzip bytes, and Board plus Slack 725,699, both excluding Forge's full entry and source maps. They do not prove the final Worker size, free CPU allocation, aggregate account request/storage quotas or provider behavior. Keep the preview on the free plan, use hibernating sockets, enforce retention/storage/send budgets and treat budget refusal as a clean result. Before enabling push, verify the chosen push library in hosted CI. Do not silently accept a paid plan to make Board or a package fit. The owner must authorize the actual deploy; this review deploys nothing.

Reverse path: delete only the distinct preview Worker after retaining a verified export if its data is wanted; keep a resource ledger for any separate KV/DO resources and credentials. Revoke preview tokens and sessions. Deleting a Worker must not be described as a verified backup, a guaranteed resource purge, or a rollback of an already-executed protected action.

## Corrected totals

| Plan | Planned PRs | Corrected low-high | Reason |
|---|---|---|---|
| Phone ask loop | 19, or 21 if two split | **25-39** | Separate manifests/routing, full Board adapter exports, real approval consumer, phone auth and cross-object verified recovery. |
| Brief and home | 17-21 stated; its table is 19-22 | **25-36** | Add authoritative cloud/local adapters, registry capability, protected seen writes and a real default/reversal protocol before UI. |
| Teams and Slack | 13 | **22-35** | Split SQL/composition, join, token fencing, membership-safe answers and restore; trial Slack glue does not include person authority. |
| All three | 49-53 stated, or 51-55 with ask's contingency | **72-110** | Arithmetic sum of every revised slice row. Shared changes have one owner; no extra integration PR is added on top. |

These are R1 planning estimates. The high end is not a schedule promise or a requirement to expand scope. The lower end assumes successful reuse of Board and web-push, a usable owner rehearsal, and no need to change upstream auth behavior. Existing cloud-launch work, Board fallback, owner waiting time and the explicitly deferred hardening are outside these totals.

## Merged build order

Use Ask's slice numbers, Home's S numbers and Team's T/A numbers with the plan name attached. A range such as Ask 2 means all corrected sub-PRs for that slice. Maximum three builders run at once. A wave finishes its dependencies before the next starts. Empty slots stay empty if filling them would duplicate a writer.

| Wave | Lane 1 | Lane 2 | Lane 3 | Exit condition |
|---|---|---|---|---|
| 0 | Cloud owner rehearsal predecessor, outside these totals | Shared interface decisions folded into Ask 1 | Empty | Entry/resource/binding contract agreed; canonical ask fields include future team and home needs. No code starts from incompatible shapes. |
| 1 | Ask 1 contract and block-aware route registration | Ask 2 Board adapter/package exports/engine | Empty | Both merge. Ask 2 owns cloud package/lock/config; no preview config edit in parallel. |
| 2 | Ask 6 preview profile/entry/preflight | Empty | Empty | Isolated profile can target the approved rehearsal. Standard default remains closed. |
| 3 | Ask 3a records and Project dispatcher | Ask 9 install/assets | Empty | Creation/read contracts and shell merge. Keep assets out of auth/composition files in this wave. |
| 4 | Ask 3b withdrawal/issue outbox | Ask 5a server socket | Empty | Records/outbox owner and mailbox/socket owner use the merged interface, no shared-file edits. |
| 5 | Ask 4 answer acceptance | Ask 5b client wait | Empty | Ordinary human answer and waiter work; channel policy X-1 settled. |
| 6 | Ask 7 phone session/forms | Empty | Empty | First non-protected question can be tried via the rehearsal. |
| 7 | Ask 13 protected decision and consumer | Ask 8 list/take-all | Ask 17 instructions | Approval lane owns auth/answer/lane files; UI lane owns ask-app only and uses the merged session interface. |
| 8 | Ask 10a subscription/asset changes | Ask 14 verified export/restore | Empty | Both auth-sensitive writes and recovery pass hosted checks. No Worker routing edit by subscription lane. |
| 9 | Ask 10b push sender | Empty | Empty | Worker-compatible sender and truthful delivery states merge. |
| 10 | Ask 11 ladder | Empty | Empty | One multiplexed alarm implementation, bounded due work. |
| 11 | Ask 12a presence/back time | Empty | Empty | Sleep/snooze semantics merge before controls. |
| 12 | Ask 12b controls | Empty | Empty | Ask first pass is ready; Home and Team now start side by side as the owner requested. |
| 13 | Team T1 public contracts/team composition/SQL members | Home S1 view schemas | Home S2 feed core contract | Team T1 owns team/cloud composition; S2 owns state/providers. Share no edits to providers until interfaces settle. |
| 14 | Team T2 invites/join | Home S2 cloud feed adapter | Empty | Team join composition and home feed Project route edits serialize internally if they share Project; do not edit it in both lanes. Use a feed-only PR first, then Project wire-up after join wire-up. |
| 15 | Team T3 tokens/member device login | Home S3 local/cloud derivation | Empty | Home consumes merged feed, edits block files only while token lane changes auth. |
| 16 | Team T4 command/claim authority | Home S4 event headlines | Home S5 registry/share | Home S4 owns events.ts; S5 owns registry, share and manifest. S3 entry registration must already be frozen. |
| 17 | Team T5 removal/recovery | Home S6 summary checks | Empty | Membership recovery and summary contract merge; no push Project edit here. |
| 18 | Team A1 authoritative answers | Home S7 schedule template | Home S8 snapshot/push client only | A1 owns Project/mailbox authority. Home's cloud routing/config/restore part of S8 waits until the next wave. |
| 19 | Team A2 member sessions/settings/push | Home S8 cloud snapshot storage/policy/restore | Empty | A2 owns session/assets/push; S8 owns snapshot state. Serialize any common composition file. Seen schema and person binding must be agreed now. |
| 20 | Team A3 handoff | Home S9 phone JSON/seen routes | Empty | A3 owns mailbox/handoff form; S9 owns view-http and final app route registration. One composition owner applies both registrations. |
| 21 | Team A4 backup escalation | Home S10 all-projects page | Empty | Shared app/navigation registration is frozen; home page is separate from handoff form. |
| 22 | Team A5 Slack/link screen and webhook | Home S11 project page | Empty | Split link screen from project page; one asset/composition PR owner. |
| 23 | Team A6 Slack delivery/answer adapter | Home S12 timeline | Empty | Shared answer contract is frozen; timeline is read-only. |
| 24 | Team A7 protected Slack refusal and consumer membership check | Empty | Empty | Protected route gate cannot race with A6 or a Home action write. |
| 25 | Home S13 provisional execution, reversal protocol and UI | Empty | Empty | One mailbox/Project writer owns this new action protocol. Original answers stay immutable. |
| 26 | Team J full two-person journey, including Home seen/default interactions | Empty | Empty | Hosted first-pass cross-feature evidence. Failed item blocks its own exit, not unrelated reads or report work. |

Wave 14 and waves 19-22 deliberately name composition serialization inside the wave. If the builder cannot keep the named files disjoint, move that sub-PR to the immediately following slot; lane cap is a ceiling, not an instruction to edit the same file twice. This schedule favors clear ownership over filling three slots.

Never run these writer pairs together:

- Ask Board and preview on wrangler config; Ask create/withdraw/answer/presence on records; list/subscription/presence controls on ask-app; push/Slack package work on cloud package and lock; restore/socket/new route work on Worker composition.
- Ask approval and Team protected/member authority work on lane-approval, lane-commands, tokens, report session or Project.
- Team T4, A1, A7 and Home S13 on authoritative command/answer acceptance. Team removal/recovery and Home cloud recovery on dump/Project.
- Team handoff, escalation and Slack import whenever they change the mailbox state machine. Work in separate adapter files only after the core transition contract is frozen.
- Home schema/manifest registration and any other lane changing the same schema/entry. Home S10/S11 on shared page assets/navigation; S12 and S13 only overlap after splitting timeline from project-action panels.

Blocking contracts: Ask's corrected session/read/answer interfaces block Home S9 and Team A1/A2; member identities and authoritative membership fence block team answers; Home's person-scoped seen contract blocks claiming per-person last-look as complete; provisional execute/reversal protocol blocks the undo UI. Protected answers depend on the fixed enforcing consumer, not merely on a rendered approval button.

## What I read

- The review brief and original planning brief, completely.
- All three plan reports, with line numbers, including assumptions, data shapes, slices, later lists and risks.
- Remote ref recorded above. Read source and selected sections from cloud Worker/Project, typed commands, state admission/commit, token handling, lane approvals/commands, report HTTP/session/backing store, OAuth composition, Clerk upstream, device browser/login/mint, dump, example config and preflight. No local repo source was used as evidence.
- Remote state owner/events/checkpoint behavior, state/identity/authorization ports, levels/registry/peer behavior, providers, tracker and state schemas, work manifest/docs/README, memory manifest, check manifest/receipt schema, agent manifest/wait schema, hello-block manifest, writing-a-block reference, and cloud contract sections on binding, routes, state transport and namespace policy.
- Remote team identity/directory/migration descriptions, team-boundary test and its import scanner, and the earlier team phase-one plan's composition/acceptance boundaries.
- Remote path listings for team, app assets and delivery skills. Case-insensitive remote searches for directory callers, approval consumers, current owner checks, ready lease filtering, state admission and scoped capabilities. A zero-hit was treated as R1, not proof of absence.
- Git log on the touched paths since 2026-11-08 and numstat/source history for the comparable commits listed in check 3, including removal of lane-browser in PR 701.
- Read-only issue show results for forge-1662, forge-1761, forge-1762, forge-1763, forge-1169 and forge-1676, using the brief's runtime and session. No issue writes or claims.
- Local Board DO and Slack trial reports; DO preparation and storage adapter source; mock v7 line count and embedded data. Trial success claims remain supplied evidence, not my execution evidence.
- Read-only source search in the untrusted Board clone's sync/chat-provider.ts and sync/slack.ts to inspect new-message and DM plumbing. I did not install or execute anything in that clone. Nightmail was not needed for any proposed slice or claim and was not opened.

No tests, builds, installs, deploys, browser calls or web requests were run. No secrets, .env files or agent-secret directories were opened. Only this report was written. Source findings reached R2; deployed correctness, zero paid spend, real-phone sound and real Slack behavior remain unverified.

COVERED 6 OF 6
