Decisions needed: none.

# Cloud and team inventory

This is a source inventory of fetched `origin/main` at `31a4f787dc499801a10384cbbe003039b68acb6f`. Evidence rung 2 means read the file; it does not establish that a deployment works. No tests, builds, deployments or live requests were run. The standard entry point is deliberately closed: `cloud/src/worker.ts:274` exports `local-only.ts`; the lead supplied the verified 503 behavior. Read the file: `docs/reference/cloud.md:3` says standard Worker entry points refuse cloud requests until the v3 launch. Existing rehearsal and custom deployments are outside the supported 0.0.1 boundary.

## At a glance

| Group | What it lets you do | State | Biggest missing piece |
|---|---|---|---|
| G1 Project and claims | Share one project authority and reserve work | Half-built | Supported launch and two-machine proof |
| G2 Issues | Read and change issues on the shared authority | Half-built | Some commands and input forms are refused |
| G3 Lanes | Coordinate and stop or resume work across sessions | Half-built | Live dispatch proof and cloud lane close |
| G4 GitHub proof | Check a merged PR before closing work | Half-built | Full evidence summary and live acceptance |
| G5 Sign-in | Approve devices, issue and revoke credentials | Half-built | Hosted proof, token listing and admin CLI |
| G6 Recovery | Export, checkpoint and restore project data | Half-built | Live two-machine restore proof and admin CLI |
| G7 Cloud checks | Exercise storage, races, costs and recovery | Half-built | Live checks skip 33 journeys |
| G8 Teams | Identify people and maintain a directory | Half-built | Connected project membership and independent human approval |

States describe the named capability, not a claim that every underlying file has been proven complete. Each group is half-built because a specific limitation below remains, even where substantial code and tests exist behind the switch.

## G1. One store per project and who holds a claim

An owner can have a single authority decide who holds a timed reservation for work. Devices and sessions can see a holder, renew or release a reservation, with a generation number preventing stale holders from acting.

Read the file: `docs/reference/cloud.md:7`, `:40`, `:67`, `:252`; `cloud/src/project.ts:341`; `cloud/src/store.ts:83`; `cloud/src/issue-lease.ts`, `lease-command.ts`, `lease-ttl.ts`; tests exist at `test/cloud/leases.test.ts` and `test/cloud/lease-command.test.ts` (file inventory, not a test result). The configured Worker admits one project for login and typed commands; raw lease and admin routes accept other project names (`docs/reference/cloud.md:40`).

State: **Half-built**. Read the file: `docs/reference/cloud.md:14` requires separate packed, candidate and public-registry proofs and says missing stages are `INCOMPLETE/2`; `:95` says the live installed dispatch proof remains incomplete. Those proofs and the launch gate remain before supported use; the source inspection cannot tell whether other required proof has since occurred.

## G2. Issues in the cloud

An owner can use the implemented shared issue routes to read a backlog, create and discuss work, update it, connect dependencies, and claim or close it. Some edits require an active reservation and its current generation, preventing a stale session from making them.

Read the file: `docs/reference/cloud.md:268` lists `issue.show`, `comments`, `links`, `list`, `ready`, `blocked`, `stale`, `create`, `comment`, `update`, `dep`, `link`, `close`, `claim`, `renew`, and `release`. The implementation is in `cloud/src/issue-*.ts`, `command-write.ts`, `issue-commands.ts:263`, and tests include `test/cloud/issue-commands.test.ts`. `issue.ready` currently uses an empty label order (`docs/reference/cloud.md:268`).

State: **Half-built**. Read the file: `cloud/src/issue-commands.ts:354` says "Commands are not yet supported in cloud" for unhandled commands; `docs/reference/cloud.md:268` says other work operations are refused and cloud write dry runs are unavailable. `issue.update` refuses kind, parent and dependsOn inputs; `issue.claim` refuses reopen, reason, competing and collaborative issues; a local receipt ID cannot be used for close (`docs/reference/cloud.md:244`, `:250`, `:252`). These are missing forms, not merely a switch.

## G3. Lanes across machines

Sessions can coordinate work lanes, record dispatch intent, stop work and request a controlled resume. An owner reply can be relayed to approve a specific stopped scope, with the request bound to the project, device, session and current control state.

Read the file: `cloud/src/lane-approval.ts:36`, `:96`, `:163`, `:190`; `lane-commands.ts:73`, `:173`; `lane-control-store.ts`; `lane-dispatch.ts:41`; `test/cloud/lane-commands.test.ts`. `docs/reference/cloud.md:268` lists cloud control, stop, resume, show, status, start, release, next and record, with constraints; dispatch has its own installed proof at `:90-117`.

State: **Half-built**. Read the file: `docs/reference/cloud.md:268` says "lane.close is refused by name" and lane dry runs other than stop are unavailable; `:95` says "The live installed dispatch proof remains INCOMPLETE/2." After restore, global resume needs fresh owner approval; a stop does not stop issue writes and already accepted work is not cancelled (`:132`).

## G4. Proof from GitHub and the merge rule

The server can inspect GitHub evidence against its own merge policy when a claimed issue is closed with a pull request. It stores a bounded evidence record with the close and checks the reservation and policy again at acceptance.

Read the file: `cloud/src/github-app-credential.ts`, `github-compose.ts`, `github-evidence.ts`, `github-headers.ts`, `github-http.ts`, `github-json.ts`, `github-workflow-evidence.ts`, `merge-evidence.ts:195`, `merge-policy.ts:24`, `evidence-receipts.ts`, `receipt-admission.ts`, `issue-receipts.ts`; `docs/reference/cloud.md:250`. Related tests include `test/cloud/github-merge-evidence.test.ts`, `merge-evidence.test.ts`, and `verify-close.test.ts`.

State: **Half-built**. Read the file: `docs/reference/cloud.md:250` says "a full evidence summary is not projected yet" and `receipt.admit` and `receipt.show` are unknown commands on cloud. The runbook also requires a separate disposable evidence project because snapshot export refuses verified-close evidence (`:130`); the standard launch and live proof remain outstanding or unverified.

## G5. Sign-in, tokens and sessions

An owner can start device login and approve or deny it in a browser after identity verification. The server issues bounded device credentials, checks session restrictions, and can revoke access and release affected leases.

Read the file: `cloud/src/auth/compose.ts`, `device-browser.ts`, `device-login.ts`, `project-login.ts`; `cloud/src/tokens.ts:84`, `:113`, `token-session.ts`, `github-app-credential.ts`; `cloud/src/adapters/workers-oauth/` including `clerk/`, registration, redemption, refresh, revocation and grant-state; `src/blocks/cloud/` contains the block manifest, entry, documentation and input/output schemas; `docs/reference/service-providers.md:37`; `docs/reference/cloud.md:292`, `:304`, `:306`. Tests include `test/cloud/auth/` and `test/adapters/workers-oauth/flow.test.ts`.

State: **Half-built**. Read the file: `docs/reference/cloud.md:57` says provisioning, revoke, status, dump and restore have no CLI; `:65` says no route lists tokens; `:595` says "deployed refresh remains unverified". Browser ingress protection has named gaps (`:294`), and `:292` requires the exact configured owner, not an arbitrary teammate.

## G6. Backup, checkpoint, restore and export

An administrator can export project data in pages and restore it with validation and controlled stopping. Separate v3 code checks authority, records, checkpoints and staged restore pages.

Read the file: `cloud/src/dump.ts:533`, `v3-authority.ts:112`, `v3-checkpoint.ts:258`, `v3-record-transitions.ts`, `v3-restore.ts:116`, `v3-store.ts`, `state-access.ts`, `state-commit.ts`, `state-input.ts`, `state-read.ts`; `docs/reference/cloud.md:57`, `:130`, `:132`, `:320`. Tests include `test/cloud/dump.test.ts`, `v3-checkpoint.test.ts`, `v3-recovery.test.ts` and `import-current.integration.test.ts`.

State: **Half-built**. Read the file: `docs/reference/cloud.md:57` says admin dump and restore have no CLI; `:130` says snapshot export refuses verified-close evidence, and imported leases and approvals cannot be used as fresh grants. The runbook requires a complete live page-by-page restore and readback (`:83-88`), and specifically warns that a successful restore alone is not dispatch permission (`:132`).

## G7. The checks Forge runs on its own cloud

The cloud has fixtures and checks for competing claims, storage limits, export and restore, login and refresh races, and stopped work. They help maintainers detect a dropped row, incorrect limits or a race before trusting a release.

Read the file: `cloud/conformance/conformance.ts`; `budget.ts:1`; `capacity.ts:1`, `:664`; `command-cost.ts`, `comparison-check.ts`, `cost-fixture.ts`, `digest.ts`, `fault-worker.ts`, `max-source.ts`, `oauth-ci.ts:1`, `oauth-worker.ts`, `oauth.ts`, `page-order.ts`, `refresh-canary.ts`, `refresh-controls.ts:1`, `refresh-race.ts`, `refresh.ts`, `restore-cost.ts`, `restored.ts`, `rows-written.ts`, `stop-capacity.ts:12`, `stop-live.ts`, `storage.ts:14`, `store-join.ts`, `write-profile.ts`. The test configurations are `cloud/wrangler.example.jsonc`, `wrangler.oauth-test.jsonc`, `wrangler.test.jsonc`; `cloud/package.json` declares the Worker dependencies; `cloud/scripts/preflight.mjs` and `set-admin-token.mjs` support preparation. These are file roles, not a claim they passed in this review.

State: **Half-built**. Read the file: `docs/reference/cloud.md:611-615` says the live main check skips 33 journeys, including test-wrapper login and command cases, small-limit exports and ingress-dependent oversized restore; its live pass is narrower than the two-machine proof. `:342` calls capacity figures measurement gates, not deployed-capacity claims.

## G8. Teams

Directory code can bind a verified identity to a person and manage organizations and their membership records. The intended product is two people and their agents sharing a project with distinct permissions and independent approval.

Read the file: `team/identity.ts:8`, `:15`; `team/directory.ts:19`, `:53`, `:79`, `:86`, `:93`, `:108`; `team/migrations.ts:15`; `test/team/directory.test.ts`; `docs/work/2026-11-10-teams-phase1/plan.md:7`, `:30`, `:48-52`, `:97-108`; `docs/work/2026-11-09-teams-research/options-paper.md`. The directory has an in-memory store and migration descriptions; that alone does not prove installed project authorization.

State: **Half-built**. Read the file: the plan says "No team runtime or live cloud journey is proved by this docs PR" (`plan.md:30`) and calls for adding project members, the installed authorization port, person-bound credentials and independent approval (`:48-52`). It defers organization roles, shared memory and other features (`:97-108`). The plan describes its historical base, so current completion of every future task is **Unclear** from this inspection; no live membership was tested.

## Q1. What must happen for v3 launch?

Read the file: `docs/reference/cloud.md:14` requires "hosted packed acceptance, live candidate-tarball acceptance and live public-registry acceptance" and calls missing stages `INCOMPLETE/2`. Its checklist (`:76-86`) calls for artifact and environment checks; owner-approved login on two machines; create/read/edit and replay; three-session and 100-call races; outage and recovery; device revocation; full export and restore readback; stopped dispatch and fresh owner-approved resume; then a full repeat using the public registry.

Read the file: `:150` requires reviewed version merge, prerequisites and main CI, candidate proof, verified owner approvals on the release environment, main-only deployment, no admin bypass, trusted publishing and dist-tag permission. `:162` requires withholding promotion until "full public-registry two-machine proof is accepted"; the owner approves publication and promotion. The document does not specify in this excerpt the code change that will replace the local-only entry, so the exact switch implementation is **Unclear**; `worker.ts:274` identifies the present gate.

## Q2. Two machines today

Read the file: in the supported standard entry, cloud requests are refused until launch (`docs/reference/cloud.md:3`; lead-verified 503), so two machines cannot rely on the standard cloud service today. Local project storage remains supported (`:3`); the runbook describes the intended shared login, issue, claim and lane flows for an ungated deployment, not proof that they currently work for the owner (`:14`, `:76-86`).

Read the file: even behind the gate, unsupported issue forms, work operations, lane close and most dry runs are refused (`:244`, `:252`, `:268`); `store.reinit` is refused for a bound project (`:270`). Existing rehearsal or custom deployments are outside the supported boundary (`:3`); their current state is **Unclear** without live access.

## Q3. A second person today

Read the file: the standard cloud entry refuses requests, and the device browser requires the configured exact owner (`docs/reference/cloud.md:3`, `:292`), so a teammate has no demonstrated supported separate cloud membership today. The directory can represent people and organization members (`team/identity.ts:15`, `team/directory.ts:79`), but that is not evidence of connected project access.

Read the file: the team plan calls for project membership roles, person-bound devices and agent sessions, removal fences and an independent human approval (`docs/work/2026-11-10-teams-phase1/plan.md:17-24`, `:48-52`). Its two-person acceptance journey includes unauthorized access, racing claims, offline conflict, approval and removal (`:93`); current completion and live operation are **Unclear** from this read-only inventory.

## Q4. Questions, notifications and phones

Read the file: case-insensitive search of `cloud/src`, `team` and `src/blocks/cloud` for ask, question, prompt, mailbox, inbox, notify, push, websocket, wait and approval found lane approval and login polling, plus ordinary programming uses such as array `push` and asynchronous `await` (`cloud/src/lane-approval.ts:36`, `:163`, `cloud/src/auth/device-login.ts:272`, `:289`; `docs/reference/cloud.md:304-306`). Lane resume generates an expiring scope-bound request and accepts the owner's verbatim reply and source as a relay, then consumes it (`lane-approval.ts:73`, `:163`, `:190`; `lane-commands.ts:173`); device login separately waits for browser approval.

Inferred: this search did not reveal a general-purpose question inbox, notification delivery, WebSocket channel or phone app in the searched cloud and team source; keyword absence cannot prove that none exists elsewhere or under another name. A browser link can be opened where the owner can sign in, but a supported phone-specific experience is **Unclear** from these files.

## Still unknown

- Whether the recorded incomplete live proof has since been completed outside the fetched documentation, whether any rehearsal is running, and whether hosted behavior matches the fixtures. No live system or CI result was checked.
- Whether team plan tasks have landed through code outside the inspected team and cloud surfaces. The plan is explicitly historical; directory code alone is insufficient evidence of a complete membership system.
- The precise code or release change that will open the standard Worker after the named launch gates. `worker.ts:274` shows the present export, not the future switch procedure.
- Test outcomes, full production limits and deployed costs. File names and source descriptions show intended checks, not passing results.

COVERED 12 OF 12
