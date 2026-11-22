Decisions needed: none

# At a glance

Counts cover only operations in the eight block manifests. Source inspection is evidence rung 2. Experimental is classified Half-built because the requested definition includes that label; it does not prove the command fails. Working means an operation doc and literal test reference exist; tests were not run. Unclear means the search did not establish those criteria.

| Family | Owner or agent capability | Commands | Working / Half-built / Switched off | Surprise |
|---|---|---:|---:|---|
| F1 Work tracking | Track issues, dependencies and history. | 17 | 0 / 17 / 0 | A board can explain blockers. |
| F2 Claims, leases and handoff | Assign work temporarily and carry context between sessions. | 9 | 0 / 9 / 0 | Issues can invite participants. |
| F3 Lanes and parallel attempts | Coordinate isolated and competing work. | 20 | 0 / 20 / 0 | Dispatch records intent without starting an agent. |
| F4 Checks, receipts and the merge gate | Run checks and inspect merge readiness. | 6 | 0 / 6 / 0 | Merge evidence can be checked. |
| F5 Memory and decisions | Store and retrieve knowledge and decisions. | 18 | 18 / 0 / 0 | Memory changes can be proposed. |
| F6 Guards and agent workflow | Guide agents through delivery. | 4 | 0 / 4 / 0 | Six workflow skills are included. |
| F7 Accounts, identity and sign-in | Manage repository identity choices. | 4 | 0 / 4 / 0 | Commit identity can be checked. |
| F8 Cloud and export | Sign in and export local records. | 3 | 0 / 3 / 0 | Cloud code exists behind a closed standard entry. |
| F9 Teams | Represent people and roles. | 0 | 0 / 0 / 0 | An in-memory directory exists. |
| F10 Extending Forge | Compose blocks and detect project features. | 1 | 0 / 1 / 0 | Blocks declare commands and schemas. |
| F11 Release, install and upgrade | Build and check releases. | 0 | 0 / 0 / 0 | Release readback journeys exist. |
| F12 Speed, footprint and platform support | Measure speed and supervise processes. | 0 | 0 / 0 / 0 | Windows supervision has dedicated code. |

## Half-built and switched off

1. **Switched off: standard cloud Worker.** `cloud/src/worker.ts:274` exports `local-only.ts`; `cloud/src/local-only.ts:11` says ?Cloud projects arrive with v3.? and line 15 returns HTTP 503. `docs/reference/cloud.md:3` places rehearsal and custom deployments outside the 0.0.1 supported boundary. The document describes the v3 launch proof.
2. **Half-built: lane budgets and scheduling.** `src/blocks/work/README.md:92` says no loop writes review and CI fix round counts, load holds are advisory, and device-wide lane and subscription window limits are not enforced. Finishing requires those counters and enforcement.
3. **Half-built: cloud update.** `docs/reference/cloud.md:244` says kind, parent and dependsOn changes via update are ?not supported in cloud yet?.
4. **Half-built: cloud claim.** `docs/reference/cloud.md:252` says reopen, reason, competing and collaborative issues are not supported in cloud yet.
5. **Half-built: cloud work parity.** `docs/reference/cloud.md:268` says other work operations on a bound project and lane.close are refused, and local receipt IDs cannot close a cloud issue.
6. **Half-built: cloud store reinitialization.** `docs/reference/cloud.md:274` says store reinit remains disabled. The intended completion path is unclear.
7. **Half-built: teams.** `docs/work/2026-11-10-teams-phase1/plan.md:30` says that plan proves no team runtime or live cloud journey; line 110 places guests, groups, hosted runners and external trackers in later phases. This is a plan statement, not proof of present absence.
8. **Half-built: experimental commands.** Each command in accounts, agent, check, cloud, project, store and work is marked experimental in its manifest. Individual lines appear in the tables. Promotion criteria are unclear.

## F1 Work tracking

| Command or feature | Plain meaning | Who calls it | State | Evidence |
|---|---|---|---|---|
| `issue.create` | Create: title, kind. | agent and person | Half-built | src/blocks/work/forge.block.json:58; src/blocks/work/docs.json:166; test/assembly/cloud-authority.integration.test.ts |
| `issue.show` | Issue, lease; invited: mode and live participants. | agent and person | Half-built | src/blocks/work/forge.block.json:68; src/blocks/work/docs.json:178; test/adapters/http/cloud-http.test.ts |
| `issue.list` | AND filters; ready=open+deps closed+unheld. createdSince: inclusive full RFC 3339 timestamp, before limit; truncated: more matches. | agent and person | Half-built | src/blocks/work/forge.block.json:79; src/blocks/work/docs.json:189; test/adapters/http/cloud-http.test.ts |
| `issue.update` | Held lease+revision; no cycles or open epic demotion with open children. | agent and person | Half-built | src/blocks/work/forge.block.json:89; src/blocks/work/docs.json:194; test/assembly/cloud-authority.integration.test.ts |
| `issue.comment` | Plain comment; read: issue.comments. | agent and person | Half-built | src/blocks/work/forge.block.json:101; src/blocks/work/docs.json:207; test/assembly/cloud-authority.integration.test.ts |
| `issue.close` | Held lease; cloud verifies pr, local verifies receipt, or written withoutReceipt reason. | agent and person | Half-built | src/blocks/work/forge.block.json:148; src/blocks/work/docs.json:255; test/adapters/http/cloud-http.test.ts |
| `issue.board` | {}: held issues/holders/blockers/dependents; cursor. {id}: ready, notReadyBecause=CLOSED,HELD,BLOCKED_BY. | agent and person | Half-built | src/blocks/work/forge.block.json:165; src/blocks/work/docs.json:268; test/assembly/cloud-authority.integration.test.ts |
| `issue.ready` | Open; deps closed; no live lease; labels all-of. labelOrder: first carried label, then stored order. | agent and person | Half-built | src/blocks/work/forge.block.json:175; src/blocks/work/docs.json:272; test/assembly/cloud-authority.integration.test.ts |
| `issue.blocked` | Open: missing/open deps. | agent and person | Half-built | src/blocks/work/forge.block.json:185; src/blocks/work/docs.json:277; test/assembly/cloud-authority.integration.test.ts |
| `issue.stale` | Open: expired unreleased leases. | agent and person | Half-built | src/blocks/work/forge.block.json:195; src/blocks/work/docs.json:281; test/assembly/cloud-authority.integration.test.ts |
| `issue.comments` | Read issue comments. | agent and person | Half-built | src/blocks/work/forge.block.json:238; src/blocks/work/docs.json:326; test/assembly/cloud-authority.integration.test.ts |
| `issue.events` | Accepted issue/lease history. | agent and person | Half-built | src/blocks/work/forge.block.json:249; src/blocks/work/docs.json:337; test/assembly/cloud-authority.integration.test.ts |
| `issue.dep` | Held lease + expected revision; add/remove dep. | agent and person | Half-built | src/blocks/work/forge.block.json:260; src/blocks/work/docs.json:348; test/assembly/cloud-authority.integration.test.ts |
| `issue.link` | Held lease; typed external link. | agent and person | Half-built | src/blocks/work/forge.block.json:272; src/blocks/work/docs.json:360; test/assembly/cloud-authority.integration.test.ts |
| `issue.links` | Read issue links. | agent and person | Half-built | src/blocks/work/forge.block.json:284; src/blocks/work/docs.json:373; test/assembly/cloud-authority.integration.test.ts |
| `issue.lint` | Kinds, refs, dep cycles; open issues' closed parents (always). labels.required: exactly one match/group; empty default. | agent and person | Half-built | src/blocks/work/forge.block.json:295; src/blocks/work/docs.json:389; test/assembly/cloud-authority.integration.test.ts |
| `issue.tree` | Open epics/root: child counts, open descendants (depth 3), parent anomalies; limit/truncated. | agent and person | Half-built | src/blocks/work/forge.block.json:305; src/blocks/work/docs.json:384; test/assembly/cloud-authority.integration.test.ts |

## F2 Claims, leases and handoff

| Command or feature | Plain meaning | Who calls it | State | Evidence |
|---|---|---|---|---|
| `issue.claim` | Blocked needs reason; closed needs reopen. | agent and person | Half-built | src/blocks/work/forge.block.json:112; src/blocks/work/docs.json:219; test/adapters/http/cloud-http.test.ts |
| `issue.renew` | Renew live generation/reacquire expired; ttlSeconds overrides claimTtlSeconds (3600s default). | agent and person | Half-built | src/blocks/work/forge.block.json:124; src/blocks/work/docs.json:232; test/assembly/cloud-authority.integration.test.ts |
| `issue.release` | This session's lease. | agent and person | Half-built | src/blocks/work/forge.block.json:136; src/blocks/work/docs.json:244; test/assembly/cloud-authority.integration.test.ts |
| `issue.call` | Count root-intent call; refuse after 60 calls/30h; bounded timebox. | agent and person | Half-built | src/blocks/work/forge.block.json:205; src/blocks/work/docs.json:285; test/blocks/l7-work/intent-limit.test.ts |
| `issue.checkpoint` | Save checkpoint. | agent and person | Half-built | src/blocks/work/forge.block.json:216; src/blocks/work/docs.json:297; test/blocks/l7-work/resume.test.ts |
| `issue.resume` | Restart context. | agent and person | Half-built | src/blocks/work/forge.block.json:227; src/blocks/work/docs.json:312; test/blocks/l7-work/resume.test.ts |
| `issue.invite` | Coordinator invite; duplicates do nothing. | agent and person | Half-built | src/blocks/work/forge.block.json:501; src/blocks/work/docs.json:393; no exact-name test reference found |
| `issue.join` | Invited membership; live rejoin keeps expiry. | agent and person | Half-built | src/blocks/work/forge.block.json:513; src/blocks/work/docs.json:397; no exact-name test reference found |
| `issue.leave` | Release own membership; no coordinator lease. | agent and person | Half-built | src/blocks/work/forge.block.json:525; src/blocks/work/docs.json:402; test/blocks/l7-work/participants.test.ts |

## F3 Lanes and parallel attempts

| Command or feature | Plain meaning | Who calls it | State | Evidence |
|---|---|---|---|---|
| `lane.attempt` | Own live attempt lease; separate capped worktree. Same arguments adopt preserved work. Never cleans up another lane. | agent and person | Half-built | src/blocks/work/forge.block.json:316; src/blocks/work/docs.json:27; test/blocks/l7-work/lane-attempt-close.integration.test.ts |
| `lane.start` | Start a capped worktree for an open issue. Project-local brief needs Goal, Acceptance test (table: Case, Input, Status, Exit, Eligibility, Unchanged; nonempty first data cell), Files, Forbidden actions, Stop point and Prior art. Same arguments adopt a preserved worktree. | agent and person | Half-built | src/blocks/work/forge.block.json:335; src/blocks/work/docs.json:41; test/assembly/cloud-authority.integration.test.ts |
| `lane.release` | Release a hand-closed lane; with attempt, release an attempt without a live lease, including a missing worktree. Refuse dirty or ignored work and pending closes. Keep the branch. Normal lanes require a closed issue without a receipt or live lease. | agent and person | Half-built | src/blocks/work/forge.block.json:352; src/blocks/work/docs.json:3; test/assembly/cloud-authority.integration.test.ts |
| `lane.close` | Close a merged lane with a PASS receipt or drop a CLOSED unmerged PR. With attempt, keep its branch: only selected attempts land and only unselected attempts drop after selection. Refuse run locks and dirty work; discardIgnored permits protected ignored files. | agent and person | Half-built | src/blocks/work/forge.block.json:369; src/blocks/work/docs.json:14; test/assembly/cloud-authority.integration.test.ts |
| `lane.next` | Return the next action for one lane (id) or all. Pauses when autopilot is off, stopped or over budget; the merge action only when every condition holds. After a merge: receipt, close, issues, rebuild, unwatch, done. | agent and person | Half-built | src/blocks/work/forge.block.json:388; src/blocks/work/docs.json:54; test/assembly/cloud-authority.integration.test.ts |
| `lane.record` | Record a fact Forge cannot read itself: an action result, a merge-gate verdict, the owner's verbatim reply, the request id of a gated step, or the owner channel. | agent and person | Half-built | src/blocks/work/forge.block.json:405; src/blocks/work/docs.json:72; test/assembly/cloud-authority.integration.test.ts |
| `lane.control` | Read project control, or control for one canonical issue. A cloud stop records control and does not acknowledge another machine's cancellation. | agent and person | Half-built | src/blocks/work/forge.block.json:416; src/blocks/work/docs.json:96; test/assembly/cloud-authority.integration.test.ts |
| `lane.dispatch` | Record one dispatch intent under shared control and a live issue lease. Starts no agent. Reuse the same dispatch ID when reconciling an uncertain outcome. | agent and person | Half-built | src/blocks/work/forge.block.json:427; src/blocks/work/docs.json:101; test/assembly/cloud-authority.integration.test.ts |
| `lane.stop` | Set the stop flag for one lane or all lanes. After it, lane next returns only pause. Stopping needs no approval. | agent and person | Half-built | src/blocks/work/forge.block.json:438; src/blocks/work/docs.json:115; test/assembly/cloud-authority.integration.test.ts |
| `lane.resume` | Clear the stop for one lane or all lanes and restart spending. Call without approval to get a request. On cloud, show result.ask in chat and wait up to 10 minutes for a clear yes. Retry the same scope with approval: {request, quote, source}, copying the reply exactly. | agent and person | Half-built | src/blocks/work/forge.block.json:449; src/blocks/work/docs.json:126; test/assembly/cloud-authority.integration.test.ts |
| `lane.freeze` | Freeze the local tracker store: later issue and attempt writes are refused naming the freeze. Reads still work. Repeating it keeps the first time. | agent and person | Half-built | src/blocks/work/forge.block.json:460; src/blocks/work/docs.json:137; test/assembly/cloud-authority.integration.test.ts |
| `lane.unfreeze` | Lift the local tracker freeze. This is the rollback path. It needs the owner's reply relayed as an approval: call once without approval to get a request, then again with approval {request, quote, source}. | agent and person | Half-built | src/blocks/work/forge.block.json:470; src/blocks/work/docs.json:142; test/assembly/cloud-authority.integration.test.ts |
| `lane.status` | Show every lane's step, PR, stop flag and use of its call, active time and round budgets, the stop flag and autopilot switch, and a measured load sample. hold names why a new lane would not start now: lane cap, low free memory or high CPU. | agent and person | Half-built | src/blocks/work/forge.block.json:480; src/blocks/work/docs.json:146; test/assembly/cloud-authority.integration.test.ts |
| `lane.show` | Read the recorded lane and issue lease without changing either. | agent and person | Half-built | src/blocks/work/forge.block.json:490; src/blocks/work/docs.json:155; test/assembly/cloud-authority.integration.test.ts |
| `attempt.slots` | Coordinator sets 1-16 competing slots. | agent and person | Half-built | src/blocks/work/forge.block.json:537; src/blocks/work/docs.json:406; test/blocks/l7-work/lane-attempt-close.integration.test.ts |
| `attempt.reserve` | Reserve an open attempt; live retries keep their lease. | agent and person | Half-built | src/blocks/work/forge.block.json:549; src/blocks/work/docs.json:411; test/blocks/l7-work/lane-attempt-close.integration.test.ts |
| `attempt.release` | Release your attempt; retain its history. | agent and person | Half-built | src/blocks/work/forge.block.json:561; src/blocks/work/docs.json:416; test/blocks/l7-work/lane-attempt-close.integration.test.ts |
| `attempt.evidence` | Append commit evidence under your attempt lease. | agent and person | Half-built | src/blocks/work/forge.block.json:573; src/blocks/work/docs.json:420; test/blocks/l7-work/lane-attempt-close.integration.test.ts |
| `attempt.select` | Coordinator selects attempts or none; preserves all attempt work. | agent and person | Half-built | src/blocks/work/forge.block.json:585; src/blocks/work/docs.json:424; test/adapters/http/cloud-http.test.ts |
| `attempt.note` | Publish under your attempt lease. | agent and person | Half-built | src/blocks/work/forge.block.json:597; src/blocks/work/docs.json:428; test/blocks/l7-work/participants.test.ts |
| Lane tools | Lane runner, control, registry, tiers and brief, fix, review and test instructions exist. Product versus development use needs call-site review. | Unclear | Unclear | tools/lane-run.ts:1; tools/lane-control.ts:1; tools/lane-registry.ts:1; tools/lane-tier.ts:1; tools/lane-brief.md:1; tools/lane-fix.md:1; tools/lane-review.md:1; tools/lane-test.md:1 |

## F4 Checks, receipts and the merge gate

| Command or feature | Plain meaning | Who calls it | State | Evidence |
|---|---|---|---|---|
| `pr.merge` | Gate, squash merge the pinned head, then verify readback. MERGED: exit 0. Gate or confirmed nonzero refusal: exit 1. Uncertain state, zero-exit unmerged state or post-write interruption: MERGE_UNVERIFIED, exit 2. | person and agent | Half-built | src/blocks/check/forge.block.json:43; src/blocks/check/docs.json:3; test/blocks/l9-check/merge.test.ts |
| `pr.state` | Read current-head GitHub checks, threads, merge readiness and remarks. Prints one JSON line with verdict, news and an opaque next token; --since suppresses unchanged reads. Read failures exit nonzero without advancing the token. | person and agent | Half-built | src/blocks/check/forge.block.json:61; src/blocks/check/docs.json:8; test/blocks/agent/wait-guard.test.ts |
| `check.gate` | Read fresh GitHub pull request evidence and require a verified current-head PASS receipt, successful required checks, zero unresolved threads, no door paths, base tip in the branch, and a head review by each gate.headReviewers login. PASS exits 0; REFUSED exits 1 with reasons in result. | person and agent | Half-built | src/blocks/check/forge.block.json:77; src/blocks/check/docs.json:12; test/blocks/l7-work/autopilot-merge.test.ts |
| `check.run` | Run declared checks. PASS exits 0; FAIL exits 1; INCOMPLETE or NOT_EXECUTED exits 2. Non-PASS returns ok:false (MCP isError:true) with the full receipt in result. Retain it on nonzero exit; inspect result.runs and repair commands, environment or timeout. Requires a first Git commit. | person and agent | Half-built | src/blocks/check/forge.block.json:87; src/blocks/check/docs.json:16; test/assembly/check-budget.test.ts |
| `check.list` | Read the configured command names without launching commands. | person and agent | Half-built | src/blocks/check/forge.block.json:104; src/blocks/check/docs.json:20; test/assembly/cloud-authority.integration.test.ts |
| `check.show` | Read and verify one accepted receipt; use the id returned by check run. | person and agent | Half-built | src/blocks/check/forge.block.json:114; src/blocks/check/docs.json:24; test/assembly/cloud-authority.integration.test.ts |

## F5 Memory and decisions

| Command or feature | Plain meaning | Who calls it | State | Evidence |
|---|---|---|---|---|
| `memory.scope` | Print the scope used by rules and new device notes, without creating a store. | agent and person | Working | src/blocks/memory/forge.block.json:11; src/blocks/memory/docs/records.json:4; test/assembly/first-run/device-memory.test.ts |
| `memory.rules` | Print note counts and search/show commands; optional notes prefixes live rule notes. | agent and person | Working | src/blocks/memory/forge.block.json:21; src/blocks/memory/docs/records.json:10; test/assembly/memory-recovery.integration.test.ts |
| `memory.attach` | Read notes requested by id or matching issue labels and touched path segments. | agent and person | Working | src/blocks/memory/forge.block.json:31; src/blocks/memory/docs/records.json:16; test/blocks/memory/attach.integration.test.ts |
| `memory.add` | Save a note to this device or this project, or edit one you have read. | agent and person | Working | src/blocks/memory/forge.block.json:41; src/blocks/memory/docs/records.json:22; test/assembly/cloud-authority.integration.test.ts |
| `memory.search` | Find notes in this project and on this device that mention any word of the query, best match first. | agent and person | Working | src/blocks/memory/forge.block.json:52; src/blocks/memory/docs/records.json:36; test/assembly/config-errors.integration.test.ts |
| `memory.show` | Read one note, or an earlier version of it, at any level. | agent and person | Working | src/blocks/memory/forge.block.json:63; src/blocks/memory/docs/records.json:42; test/assembly/cloud-state-client.test.ts |
| `memory.propose-forget` | Mark a note for the owner to forget while keeping it readable. | agent and person | Working | src/blocks/memory/forge.block.json:74; src/blocks/memory/docs/records.json:48; test/assembly/cloud-authority.integration.test.ts |
| `memory.forget` | Hide a note with recorded approval, or restore it with undo. | agent and person | Working | src/blocks/memory/forge.block.json:85; src/blocks/memory/docs/records.json:54; test/blocks/l7-work/autopilot-owner.test.ts |
| `memory.move` | Move one note, copy with keep, or move a device scope to this project; scope batches return moved.length and next until complete, with complete only when the scan reaches the end and moves 0 notes. | agent and person | Working | src/blocks/memory/forge.block.json:97; src/blocks/memory/docs/records.json:60; test/assembly/cloud-authority.integration.test.ts |
| `memory.export` | Read one level's notes out as a document for backup. | agent and person | Working | src/blocks/memory/forge.block.json:108; src/blocks/memory/docs/records.json:74; test/assembly/cloud-authority.integration.test.ts |
| `memory.restore` | Add notes from an export at its level with recorded approval. | agent and person | Working | src/blocks/memory/forge.block.json:118; src/blocks/memory/docs/records.json:80; test/assembly/cloud-authority.integration.test.ts |
| `memory.accept` | The owner accepts proposed notes or revisions so they are served. | agent and person | Working | src/blocks/memory/forge.block.json:128; src/blocks/memory/docs/records.json:88; test/blocks/memory/catalog.test.ts |
| `memory.reject` | The owner rejects proposed notes or revisions; they stay in history. | agent and person | Working | src/blocks/memory/forge.block.json:138; src/blocks/memory/docs/records.json:106; test/blocks/agent/memory.test.ts |
| `memory.withdraw` | An agent takes back proposed notes or revisions it no longer needs; they stay in history. | agent and person | Working | src/blocks/memory/forge.block.json:148; src/blocks/memory/docs/records.json:124; test/blocks/memory/catalog.test.ts |
| `memory.proposals` | Read-only batches of what waits for the owner, similar ones grouped, ready for memory.accept. | agent and person | Working | src/blocks/memory/forge.block.json:158; src/blocks/memory/docs/records.json:137; test/blocks/memory/catalog.test.ts |
| `decision.propose` | Record a decision under the next number in the project's own id format. | agent and person | Working | src/blocks/memory/forge.block.json:168; src/blocks/memory/docs/records.json:149; test/assembly/cloud-authority.integration.test.ts |
| `decision.adopt` | Mark a proposed decision adopted with recorded approval. | agent and person | Working | src/blocks/memory/forge.block.json:179; src/blocks/memory/docs/records.json:162; test/assembly/cloud-authority.integration.test.ts |
| `decision.list` | List recorded decisions in number order, 200 at a time. | agent and person | Working | src/blocks/memory/forge.block.json:190; src/blocks/memory/docs/records.json:168; test/assembly/cloud-authority.integration.test.ts |

## F6 Guards and agent workflow

| Command or feature | Plain meaning | Who calls it | State | Evidence |
|---|---|---|---|---|
| `agent.wait` | Run `forge agent wait <n>` after the PR opens and after each push; do each step, then follow `then`. `--sweep` on session resume; `--done` at land, abandon or handback. | person and agent | Half-built | src/blocks/agent/forge.block.json:15; src/blocks/agent/docs.json:11; test/blocks/agent/wait-guard.test.ts |
| `agent.memory` | Print SessionStart hook JSON for a named or detected adapter using the installed companion. Replace earlier Forge memory entries and preserve unrelated settings and hooks; Forge never edits them. Adapters without a startup hook point to the underlying harness. | person and agent | Half-built | src/blocks/agent/forge.block.json:26; src/blocks/agent/docs.json:3; test/blocks/agent/memory.test.ts |
| `agent.guard` | Print mergeable Stop and PreToolUse hooks using the installed package companions. Name an adapter or detect exactly one harness. Install the printed entries yourself, preserving existing settings and hooks. | person and agent | Half-built | src/blocks/agent/forge.block.json:37; src/blocks/agent/docs.json:20; test/blocks/agent/wait-guard.test.ts |
| `route.get` | Use the current model at high effort and standard speed. A matched adapter loses to any matched adapter whose over list names it. Detect the sole remaining adapter, inheriting omitted fields from the first matched adapter in its over list; otherwise use current. Max requires ~/.forge/routing.yaml. | person and agent | Half-built | src/blocks/agent/forge.block.json:48; src/blocks/agent/docs.json:25; test/blocks/agent/route.test.ts |
| Template and guards | Claude, Codex and T3 setups plus ask-first, command, done-claim, output and memory guard files exist. Their enforcement conditions need further review. | Unclear | Unclear | templates/delivery/forge.template.json:1; templates/delivery/agents/claude.yaml:1; templates/delivery/agents/codex.yaml:1; templates/delivery/agents/t3.yaml:1; templates/delivery/harness/guard.mjs:1 |
| Six skills | Intake, cut, build, review, land and loop workflow skill files exist. | Unclear | Unclear | templates/delivery/skills/forge-intake/SKILL.md:1; templates/delivery/skills/forge-cut/SKILL.md:1; templates/delivery/skills/forge-build/SKILL.md:1; templates/delivery/skills/forge-review/SKILL.md:1; templates/delivery/skills/forge-land/SKILL.md:1; templates/delivery/skills/forge-loop/SKILL.md:1 |

## F7 Accounts, identity and sign-in

| Command or feature | Plain meaning | Who calls it | State | Evidence |
|---|---|---|---|---|
| `accounts.plan` | Detect accounts, propose a repo identity and render the owner's one-message ask. | agent and person | Half-built | src/blocks/accounts/forge.block.json:32; src/blocks/accounts/docs.json:3; test/blocks/accounts/packed.integration.test.ts |
| `accounts.use` | Apply the selected account with a relayed approval quote and source, and audit the change. | agent and person | Half-built | src/blocks/accounts/forge.block.json:48; src/blocks/accounts/docs.json:12; test/blocks/accounts/packed.integration.test.ts |
| `accounts.decline` | Record the owner's relayed refusal for this repo. | agent and person | Half-built | src/blocks/accounts/forge.block.json:64; src/blocks/accounts/docs.json:21; no exact-name test reference found |
| `accounts.check` | Refuse a push range whose author or committer email is not the bound GitHub account's. Defaults to every unpushed commit. Never calls gh. | agent and person | Half-built | src/blocks/accounts/forge.block.json:80; src/blocks/accounts/docs.json:30; test/blocks/accounts/packed.integration.test.ts |

## F8 Cloud and export

| Command or feature | Plain meaning | Who calls it | State | Evidence |
|---|---|---|---|---|
| `cloud.login` | Standard Worker entry points refuse cloud requests until v3 launches. Existing rehearsal and custom deployments fall outside Forge 0.0.1 support. Log in to a compatible deployment with the owner's approval, save the credential privately and bind the project. Never prints the token. | person | Half-built | src/blocks/cloud/forge.block.json:16; src/blocks/cloud/docs.json:3; test/assembly/cloud-authority.integration.test.ts |
| `cloud.logout` | Unbind this checkout from its Forge cloud project: removes this project's saved credential, then .forge/cloud.json, so the checkout uses the local store again. Other projects' credentials are kept. The device token is not revoked on the server. Never prints the token. | person | Half-built | src/blocks/cloud/forge.block.json:27; src/blocks/cloud/docs.json:15; test/blocks/cloud/catalog.test.ts |
| `store.export` | Write a consistent read-only backup of this project's store, with a source.json and an export-info.json describing it, into an empty folder. | person | Half-built | src/blocks/store/forge.block.json:15; src/blocks/store/docs.json:3; test/assembly/store-export.test.ts |
| Cloud service | Issue, lease, lane, GitHub evidence, merge policy, receipts, token, v3 store, checkpoint, restore and dump files exist. The standard Worker refuses requests. | Unclear | Switched off | cloud/src/worker.ts:274; cloud/src/local-only.ts:11; docs/reference/cloud.md:3 |
| Cloud authentication and adapters | Device and project login, OAuth composition and Clerk adapter files exist. | Unclear | Unclear | cloud/src/auth/compose.ts:1; cloud/src/adapters/workers-oauth/compose.ts:1; cloud/src/adapters/workers-oauth/clerk/index.ts:1 |
| Cloud conformance | Capacity, storage, restore, OAuth and fault proof scripts exist. | Unclear | Internal | cloud/conformance/conformance.ts:1; cloud/conformance/restore-cost.ts:1; cloud/conformance/oauth.ts:1 |

## F9 Teams

| Command or feature | Plain meaning | Who calls it | State | Evidence |
|---|---|---|---|---|
| Directory, identity and migrations | Person bindings, organizations, roles and team records are represented. A memory directory store exists. | Unclear | Half-built | team/directory.ts:2; team/identity.ts:1; team/migrations.ts:1; docs/work/2026-11-10-teams-phase1/plan.md:30 |

## F10 Extending Forge

| Command or feature | Plain meaning | Who calls it | State | Evidence |
|---|---|---|---|---|
| `project.detect` | Report what the project already has: package manager and scripts, languages, hook setup, CI, issue tracker and decision records. | agent and person | Half-built | src/blocks/project/forge.block.json:9; src/blocks/project/docs/records.json:3; test/assembly/config-defaults/captured-schema.test.ts |
| Extensions | Contracts, schemas, admission and an example block exist. Behavior of individual extension commands needs further inspection. | Unclear | Unclear | schemas/block.json:1; schemas/interfaces/forge.tracker.json:1; src/core/trust/operations.ts:1; docs/writing-a-block.md:1; examples/hello-block/forge.block.json:1 |
| Core and surfaces | State, configuration, runtime and services assemble into terminal and MCP surfaces. Help, skills synchronization and identity have dedicated files. | Unclear | Unclear | src/core/state/README.md:1; src/core/runtime/README.md:1; src/assembly/index.ts:1; src/surface/cli.ts:1; src/surface/mcp.ts:1; src/surface/help.ts:1; src/surface/skills.ts:1; src/assembly/identity.ts:1 |

## F11 Release, install and upgrade

| Command or feature | Plain meaning | Who calls it | State | Evidence |
|---|---|---|---|---|
| Release and import tools | Release journeys, package readback, cloud restore and import utilities exist. Product versus internal use needs call-site review. | Unclear | Unclear | tools/release/journeys.mjs:1; tools/release/readback.mjs:1; tools/restore-cloud.ts:1; tools/import-current.ts:1; tools/import-current-state.ts:1 |
| CI tools | Change scope, test shards and CI reports support Forge development. | Unclear | Internal | tools/ci/change-scope.ts:1; tools/ci/test-shards.ts:1; tools/ci/ci-report.ts:1 |

## F12 Speed, footprint and platform support

| Command or feature | Plain meaning | Who calls it | State | Evidence |
|---|---|---|---|---|
| Speed and footprint tools | Measure and compare speed and footprint. | Unclear | Internal | tools/bench/cli-speed.ts:1; tools/bench/footprint.ts:1; tools/bench/speed-compare.ts:1 |
| Windows process supervision | Windows process control has dedicated code and documentation. | Unclear | Unclear | docs/reference/windows-process-supervision.md:1; src/adapters/process/windows-job.ts:1 |

### Extension inventory

Ports on main: `authorization`, `clock`, `cloud-login`, `config-codec`, `device-files`, `device-identity`, `identity-mint`, `identity`, `lifetime`, `mcp-transport`, `package-manager`, `private-files`, `process`, `runner-output`, `state-protocol`, `state`, `store-export`, `store`, `tracker`, `vcs`.

Adapter manifests on main:
- `config-yaml`: {"package": "yaml", "port": "ConfigCodecPort"} (src/adapters/config-yaml/adapter.json:1).
- `fs`: {"builtin": "node:fs", "port": "ConfigFiles"} (src/adapters/fs/adapter.json:1).
- `http`: {"builtin": "node:https", "port": "CloudHttp"} (src/adapters/http/adapter.json:1).
- `mcp-transport`: {"package": "@modelcontextprotocol/server", "port": "McpTransportPort"} (src/adapters/mcp-transport/adapter.json:1).
- `node-runtime`: {"executable": "node", "port": "FileCapturePort, RunIsolationPort"} (src/adapters/node-runtime/adapter.json:1).
- `oidc`: {"builtin": "node:crypto", "port": "src/ports/identity.ts#IdentityVerifier"} (src/adapters/oidc/adapter.json:1).
- `package-manager`: {"port": "package-manager", "executable": ["npm", "pnpm", "yarn", "bun"]} (src/adapters/package-manager/adapter.json:1).
- `process`: {"port": "process", "package": "koffi"} (src/adapters/process/adapter.json:1).
- `runner-output`: {"executable": ["vitest", "jest", "pytest"], "port": "src/ports/runner-output.ts#RunnerOutputPort"} (src/adapters/runner-output/adapter.json:1).
- `store-sqlite`: {"builtin": "node:sqlite", "port": "StorePort"} (src/adapters/store-sqlite/adapter.json:1).
- `vcs-git`: {"port": "vcs", "executable": ["git"]} (src/adapters/vcs-git/adapter.json:1).

Schemas on main: `schemas/block.json`, `schemas/common.json`, `schemas/config.json`, `schemas/context.json`, `schemas/detection.json`, `schemas/docs.json`, `schemas/error.json`, `schemas/evidence.json`, `schemas/interface.json`, `schemas/interfaces/forge.tracker.json`, `schemas/invocation.json`, `schemas/observation.json`, `schemas/operation.json`, `schemas/projection.json`, `schemas/result.json`, `schemas/state.json`, `schemas/template.json`, `schemas/tracker.json`.

## Things that exist but appear in no user-facing doc

Search: case-insensitive literal dotted and space-separated command names in tracked root README.md and every tracked file under docs/. This does not rule out descriptions using other words. Block docs and template docs are excluded.

No literal name found for: `accounts.plan`, `accounts.use`, `accounts.decline`, `agent.memory`, `agent.guard`, `pr.merge`, `check.show`, `cloud.logout`, `memory.attach`, `memory.show`, `memory.propose-forget`, `memory.move`, `memory.export`, `memory.restore`, `memory.accept`, `memory.reject`, `memory.withdraw`, `memory.proposals`, `decision.propose`, `decision.adopt`, `decision.list`, `issue.call`, `issue.events`, `issue.lint`, `lane.attempt`, `issue.invite`, `issue.join`, `issue.leave`, `attempt.slots`, `attempt.reserve`, `attempt.release`, `attempt.select`.

## Still unknown

- This is a partial inventory, not a complete assessment of all implementations, schemas, tests and guards. All eight manifests and declared command documentation were read. Other requested areas were identified but not exhaustively analyzed.
- A literal test reference does not establish coverage or a passing test. No tests, builds, installations or live requests were run.
- Caller labels are manifest declarations. Tool classifications, adapter integration, team readiness and exact v3 launch work need further verification.

COVERED 8 OF 14 (manifest command inventories); 82 commands listed of 82 found in the eight manifests.
