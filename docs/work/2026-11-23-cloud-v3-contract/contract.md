# forge-1853: cloud v3 production contract for the fresh-project pilot (path slice 1), revision 2, lead-corrected

> Status (lead, 2026-11-23): this contract had two independent checks (cloud-v3-contract-check.md, cloud-v3-contract-check-r2.md), both REWORK. Under the two-round rule it gets no third check. The seven required changes of the second check are applied below with the checker's exact text.
> Governs now: owner choices O2 to O10 (defaults), A2 to A4, B, D, E policy, I, the per-operation refusal table in G, the forge-cloud-root/4 cold compatibility rule, and in H only: stopped-issued token validity, retained-stage policy, unchanged incarnation and restoreEpoch at promotion, the parent-root digest, and separate promotion and resume.
> Not settled (do not brief or build from these parts): (1) G, replay of an archived successful issue.create: settled by forge-1825-design.md (checked once, PASS WITH CHANGES, changes applied); slice 2 is built as pieces A to D from that note. (2) H, the activation, promotion and control lifecycle, including repeated restore. A separate design note (forge-1856) is written and checked before slice 4 and before slices 16 to 22.
> Threat model for this decision. Asset: project state, leases and tokens in the v3 store. Threat: a slice built on an unsettled section ships a recovery or promotion path that accepts history that disagrees with the served state, or makes honest history unreadable. Always holds: no slice is briefed from a part listed as not settled; each such part gets its own design note and one independent check.

Design author: Claude Opus 5.5 high, 2026-11-23. Revision 1 tried to apply the 19 required changes of the first independent check (`.worktrees/briefs/cloud-v3-contract-check.md`, GPT-6.1 Sol high); the second check found 12 applied and 7 partial, and revision 2 applies its seven corrections. Revision 0 is kept at `cloud-v3-contract-r1.md`, revision 1 at `cloud-v3-contract-r2.md`. Design only: no code, no enabling change. Every `file:line` means origin/main 0fb2aa74617c719ce21712cd355bd8b2295f7a20 in forge-new. The investigation is `.worktrees/briefs/cloud-v3-path.md` ("path report"); its line numbers are for 51302f31 and are not reused. forge-1846 (slice 3, PR 763) is not on this ref.

Every later slice (2 to 34, path report section 4) is checked against this document. A slice that cannot meet a rule stops and reports; it does not pick another rule. Code mechanics (selection algorithm, test wiring, byte arithmetic) implement the owner policy below; they are not policy themselves.

## Owner decisions

Silence means the default. Defaults O1 to O6 are the path report's recommendations. Slice counts in "veto costs" are estimates, not measurements.

**O1. Warm image (forge-1837).** Should a warm object keep using its cached image when storage changed under it?
- A. Accept. Gives up: cached reads and replays can lag an out-of-band storage edit; and because append checks only the head number (`cloud/src/v3-store.ts:817-837`), a same-head change (an authentic root of another incarnation with the same head, or an edited older row) can continue through new writes until the next cold load. The next cold load verifies the persisted image's internal coherence under G. It rejects inconsistent history and state, but it can accept a complete earlier authentic image, including one with another incarnation and the same numerical head. It does not establish freshness or detect every out-of-band replacement.
- B. A, plus append compares the authenticated root body with the root the image was built from. Catches root replacement at the next write; still misses an edited older row under the same root. Cost: one compare in append, added to slice 5.
- C. Re-verify the image on every request. Cost: a full fold per request (section G cost), measured in slice 5.
- Default A. Veto to B adds a few lines to slice 5; C adds one slice after slice 5.

**O2. Replayed authentic token row (forge-1842).** Accept that someone holding both a saved signed token row and that token's bearer secret can undo its revoke by writing the row back?
- A. Accept for the owner-only pilot, with a 7-day lifetime cap in both v3 issuers. Gives up: freshness of revoke for the token's remaining lifetime. Today the admin issuer allows 90 days (`cloud/src/tokens.ts:20`, `cloud/src/v3-tokens.ts:148`) and login mints 30 days (`cloud/src/auth/project-login.ts:17-18`, `272-279`); 7 days is new for both. A storage writer alone cannot recover the bearer from its hash.
- B. Per-token revocation record outside the object, checked on every request; needs fail-closed behavior when that store is unreachable.
- C. Anchor head, root and token generations together outside the object.
- Default A with 7 days (stated assumption: two owner devices re-login weekly). Changing the number touches slices 19 and 24. B adds a design slice and two or more build slices before slice 24; C more.

**O3. Raw leases under v3 tokens (forge-1849).**
- A. `holder`, `claim`, `renew`, `release` accept a v3 device token (new behavior; no production support exists today). The token proves device, session and expiry; actor, agent and harness metadata from the body stay unproven (`cloud/src/project.ts:1287-1306`, cited from the check).
- B. Typed only; raw routes refuse 404 UNKNOWN_COMMAND. Raw-route callers lose their journeys.
- C. `holder` only.
- Default A. B turns slice 8 into a refusal slice and moves caller replacement into slice 25.

**O4. Revoke releases leases (forge-1847).**
- A. Revoke releases, in the same transaction, the leases of the revoked token's session when a bounded scan of authenticated token rows finds no other live token for that device and session. Gives up: a live sibling token keeps the session's leases (revoking one token does not revoke a session); a scan fault or over-bound fails the whole revoke; recovery cannot prove the historical absence of a sibling (A4).
- B. No release; leases run to expiry; reply keeps `leasesReleased: false`.
- C. Release later through a pending state with partial-result semantics.
- Default A. B removes slice 10; C enlarges it.

**O5. Pilot scope.**
- A. Fresh tracker-only project: the 20 typed operations the client serves from cloud (`src/assembly/cloud-authority.ts:75-96`), raw leases (O3), login, private login and approval storage, admin token inventory, export, restore, promotion. Generic client state namespaces refused.
- B. A plus generic state namespaces; authority namespaces stay forbidden (`state-access.ts:72-78`, cited from the check).
- C. Create, read and claim only. Restore still needs stopped control, owner approval and resume (parts of slices 16 and 17); without them restored copies stay stopped and unusable, and that is stated to the owner.
- Default A. B moves slices 28 to 30 before 27. C lets slice 27 follow slices 10, 16-17 (restore parts only) and 19 to 26.

**O6. Backup replay.**
- A. A genuine signed backup restores into any empty project (forge-1838 target rule; no target binding in the manifest, `cloud/src/v3-seal.ts:141-147`). Gives up: freshness and single use; each restore starts a new incarnation and epoch with no source tokens. Cross-deployment restore works only while the signing key is in the two-slot ring (`cloud/src/v3-seal.ts:37-50`).
- B. Bind a backup to a source project identity; needs a definition of project identity across recreation and deployments. Source binding still does not prove newest backup.
- Default A. B changes the portable format in slice 20 and adds a target check in slice 21.

**O7. Truth of input-stage refusals (new).** Section G re-derives state-stage refusals against prior state. For structural input-stage refusals it can only check that the stored error is in a fixed per-operation list; it cannot prove the caller's input was invalid, because the receipt holds a one-way digest of the input (`cloud/src/command-write.ts:28-33`).
- A. Accept allowlist membership for input-stage refusals.
- B. Store a bounded non-secret validation witness per input refusal (the failing rule id plus a redacted shape: field path, JSON type, string lengths, no values) and re-run the rule on it. Gives a refusal consistent with its witness, but still not tied to the digest, so a key holder can invent a consistent witness. Cost: a witness grammar per operation, a larger frame, slice 2 roughly doubles.
- C. Store the full invalid input up to 512 KiB; ties the proof to the fingerprint digest but stores raw invalid data (forbidden by forge-1825).
- Default A. B must be designed before slice 2 starts.

**O8. Existing v3 images (new).** Slice 2 refuses any image without the new format (section G). No v3 image can be produced by the committed stock Worker (section D), but a test or hand-deployed object might hold one.
- A. No grandfathering. Before deploying slice 2 the operator confirms no v3 image worth keeping exists; any that remain become unavailable.
- B. A one-time converter for old images. It cannot re-derive input-stage refusals, so it needs O7 A anyway.
- Default A. B adds one slice before slice 2.

**O9. Retention and the lifetime cap gate (new).** Checkpoint keeps all history in one 256 KiB transcript page (section E).
- A. Keep all refusal and replay evidence; refuse new work at the measured cap; slice 27 does not start until the owner has seen slice 5's measured usable capacity, refusal-flood exhaustion, safety reserve and rollover behavior.
- B. Approve a pruning rule in slice 5, by contract amendment, that keeps `expiredReplay` truthful and historical verification possible.
- Default A. B enlarges slice 5 and needs a new check.

**O10. Rollback availability (new).**
- A. A binary older than a stored format may run only while affected projects are held unavailable, their data retained and a verified export usable by a compatible binary. No serving rollback (section F).
- B. Write a down-converter so an older binary can serve. Cost: a slice per format change, and it loses the refusal evidence it removes.
- Default A.

## A. The four open questions

### A1. Warm image (O1 A)

Rule: every append authenticates the stored root and compares its numerical head with the warm image head; this detects a changed head only. It does not establish that the image has the same root, incarnation, checkpoint projection or older rows as storage, and same-head changes can pass append. Token rows, approvals and restore stages are read fresh on every request. Selection class (section C) is recomputed from storage on every request and is not cached.

- Asset: answers of reads and replays; writes made on a warm image.
- Threat: a storage writer changes rows under a warm object.
- Always holds: a changed head refuses the write (`cloud/src/v3-store.ts:834-837`); no token decision uses a cache (`cloud/src/v3-tokens.ts:107-115`); the next cold load runs the history check (G). Warm images also hold lazy snapshot pointers, read and digest-checked when loaded (`cloud/src/v3-store.ts:751-783`).
- Not claimed: detection on a warm object of a same-head change, including another incarnation's authentic same-head root (append signs with the stored root's incarnation without comparing the image's, `cloud/src/v3-store.ts:858-861`). Re-decided before slice 32.

| Entry point | Role |
|---|---|
| `Project.#image` `cloud/src/project.ts:425-429`; `#hasV3Root` 417-419 | cached image; cached table presence (removed by slice 24) |
| `recoverV3` `cloud/src/v3-store.ts:485-575`; `publishV3` 653-657 | build and fold the image |
| `append` `cloud/src/v3-store.ts:808-867` | root reread 817, head check 834, stale marks 835, 855 |
| checkpoint replaceWarm `cloud/src/v3-checkpoint.ts:396`, `412`, `415` | drop or replace the image |
| provision and restore `cloud/src/project.ts:632-633`, `654` | set or clear the cache |
| replay: `commandV3` `cloud/src/v3-commands.ts:216-224`; `leaseV3` `cloud/src/v3-store.ts:1183-1200` | answer from the image |

Slices: 5 (O1 B if chosen), 20 (export reads storage), 24 (per-request class).

### A2. Replayed authentic token row (O2 A)

Rule: a v3 token is accepted only after an authenticated read of its row in the same synchronous turn as the effect it admits; an earlier authentic row written back is accepted until that row's expiry; every v3 issuer caps lifetime at 7 days.

- Asset: the right to act with a revoked token.
- Threat: someone with the bearer secret and a saved row writes the row back after a revoke.
- Always holds: the row MAC verifies under a configured key for this object (`cloud/src/v3-tokens.ts:99-103`; `cloud/src/v3-seal.ts:185-202`); after slice 24 the MAC also binds the incarnation.
- Not claimed: freshness of a token row; the stated-limit test is `test/cloud/v3-tokens.test.ts:858-870`.

| Entry point | Role |
|---|---|
| `authorizeV3Token` `cloud/src/v3-tokens.ts:107-140`; `stored` 64-97; `authentic` 99-103 | the only v3 token check |
| `issueV3Token` 142-189 (TTL check 148); `revokeV3Token` 191-212 | create; revoke |
| `signToken`/`verifyToken` `cloud/src/v3-seal.ts:198-202`; token parts 185-196 | signed bytes |
| callers: `cloud/src/project.ts:1099-1116`, `665-679`; later slices 8, 19 | |

Slices: 19 (login issuer cap), 24 (admin issuer cap, incarnation binding).

### A3. Raw leases under v3 tokens (O3 A)

Rule: on a v3-selected project the four raw lease routes admit a v3 device token by `authorizeV3Token` before and after the bounded body, take device, session and expiry only from the second check, append with no await after it, scope request ids by the token principal, never open v2 lease storage, and treat body metadata as unproven.

- Asset: who holds a lease.
- Threat: a caller without a live token, or naming another device or session, takes or changes a lease; a v3 project reaches the v2 lease owner (today a forwarded owner header reaches `#holder`, `cloud/src/project.ts:886-901`, `935-937`).
- Always holds (target, slice 8): the `/command` two-check order (`cloud/src/project.ts:1102-1115`); one frame per new lease command (`cloud/src/v3-store.ts:1170-1268`).
- Not claimed: anything beyond A2 and A4.

| Entry point | Role |
|---|---|
| raw section `cloud/src/project.ts:874-960`; `#holder` 507-513; `#lease` 1331; `admitLeaseRequest` 1267 | today v2 only |
| `leaseV3` `cloud/src/v3-store.ts:1170-1268`; `admitLease` 1065; `transition` 930 | v3 effects |
| Worker lease admission `cloud/src/worker.ts:194-196` | admitted project |

Slices: 8, 9.

### A4. Revoke releases leases (O4 A)

Rule (target, slice 10): the writer authenticates the bounded set of token rows naming the revoked token's device and session, and in one transaction signs the revoke and appends one release frame for that session's unreleased, unexpired leases when no other live authentic token names it; any fault rolls back both; a repeat revoke releases nothing; the reply lists released subjects.

- Asset: lease holding after a revoke.
- Threat: release without revoke or the reverse; a forged release frame.
- Always holds: recovery re-derives the release effects against prior leases (G); a live sibling intentionally keeps the session's leases.
- Not claimed: historical proof that no other live token existed. Token rows are signed outside commit history (`cloud/src/v3-tokens.ts:191-210`; no token collection, `cloud/src/v3-store.ts:74`), so a signer-supplied "no sibling" value proves nothing on its own. Accepted pilot limit. On an activated stopped root revoke releases nothing: activation already released imported leases (`cloud/src/v3-store.ts:471-478`) and no lease can be granted while stopped (818).

Entry points: `revokeV3Token` `cloud/src/v3-tokens.ts:191-212` (today row only, `leasesReleased: false`); v2 sibling model `cloud/src/project.ts:764-806` (query 789-795); `append`, `apply`, `authorityFault` (`cloud/src/v3-store.ts:808`, `917`; `cloud/src/v3-authority.ts:175`). Slice 10 picks the frame encoding and adds its basis row to G.

## B. Bounded pilot scope (O5 A)

Rule: a v3-selected project serves exactly the target surfaces below; route exclusions are refused after ingress admission and before body parsing or any effect; nothing on a v3-selected project reaches v2 storage, v2 tokens, `runCommand` or `StateOwner`; a forwarded owner header is refused on every Project entry before branch-specific storage access.

Typed operations need a bounded body read and envelope admission before the operation is known (`cloud/src/project.ts:1102-1106`). An operation unknown to the common parser returns 404 UNKNOWN_COMMAND "No such command" (`cloud/src/issue-commands.ts:151-156`); a parser-known operation absent from the v3 registry returns 404 UNKNOWN_COMMAND "No such v3 command" (`cloud/src/v3-commands.ts:199-203`). Neither calls `runCommand` or records a frame. This table does not override earlier Worker authentication or configuration errors (`cloud/src/worker.ts:88-156`).

The "target" column is pilot behavior. "Today" is for a fresh ordinary v3 root without a v2 marker; today's refusals on such a root come from the missing v2 marker, not from authority isolation (check, route audit).

| Surface | Target | Today |
|---|---|---|
| `/command` create, update, claim | served | only with `ctx.testV3` (`cloud/src/project.ts:1099-1116`); bit off gives 401 AUTH_INVALID (1117-1118) |
| renew, release (9); show (6); list, ready, blocked, stale (7); comment, comments (11); link, links (12); dep (13); close (15); lane control, stop (16); resume (17); dispatch (18) | served from the named slice; before it, "No such v3 command" | "No such v3 command" |
| other ops | "No such command" or "No such v3 command" | same |
| raw holder, claim, renew, release | served (O3 A, slice 8) | device bearer 401 (890-901); owner forward reaches `#holder` |
| `/state/read`, `/state/commit` | 404 UNKNOWN_COMMAND "State is not served for this cloud v3 project", FAIL envelope, before token or body read (slice 24) | 401 at 1016-1017 |
| login, `/device`, `/device/approve`, `/device/deny`, device `/callback` | served for v3 (slice 19); before it 403 AUTH_FORBIDDEN | 403 at 705-709, 725-729 |
| global OAuth routes (`cloud/src/auth/compose.ts:14-17`), optional `/app` | not project-data routes; never read v3 data | as today |
| admin devices (token inventory), revoke | served by production selection (24) | only with `ctx.testV3` (665-679); bit off: devices 409 (680-681), revoke reads body then 400 INPUT_INVALID (764-767) |
| admin status | truthful v3 status (21); slice 24 refuses to select until 21 lands | 200 `initialized:false` from v2 (849-859) |
| admin dump (export) | v3 export (21); v2 dump on v3: 409 INPUT_CONFLICT "Cloud v3 projects cannot use v2 routes" | 200 empty v2 dump (807-818; `cloud/src/dump.ts:430-431`) |
| admin restore | v3 restore (21) | `ctx.testV3` only (637-663) |
| admin upgrade | 409 as above, after Worker input checks (`cloud/src/worker.ts:213-225`) | same |
| internal report route | 503 via `appUnavailable` (`cloud/src/report-http.ts:27`) | 401 (521-528) |
| `/p/<p>/test-v3*` | 404 UNKNOWN_COMMAND at the Worker (`cloud/src/worker.ts:33`; `.github/workflows/cloud.yml:802`) | same |
| alarm | maintenance (23) | returns on root-table presence (386) |
| unknown method or path | existing Project 404/405 (874-882) | same |

Reserved route contracts. Spelling may wait; these responsibilities may not.

| Route | Admission | Body | Class (C) | Result |
|---|---|---|---|---|
| provision (24) | admin bearer | empty; non-empty is 400 INPUT_INVALID | Empty only; Valid ordinary returns current state with no write | 200 with incarnation-free summary; other classes per C |
| token inventory (24) | admin bearer, GET | none | Valid ordinary or activated | id, device, session, agent, harness, expiry, revoked; never hash or MAC; bounded page |
| approval request (17) | device token, two checks | ≤8,192 bytes | Valid | binds project, incarnation, restoreEpoch, operation, operation digest, session |
| approval approve (17) | owner browser proof, server-checked (model: `cloud/src/auth/device-browser.ts:294-314`, v2) | ≤8,192 bytes | Valid | single use, expiry |
| approval consume | inside the permitted mutation's transaction | none | Valid | atomic with the mutation |
| promotion (22) | consumes an approval also bound to activationDigest | ≤8,192 bytes | Activated only | H |
| export, status, restore (21) | admin bearer | restore ≤2 MiB per page (`cloud/src/project.ts:645-650`) | per C | E, F, H |

Owner-header rule: the Worker strips incoming owner headers (`cloud/src/worker.ts:118-129`) but the configured OAuth forward recreates them (`cloud/src/adapters/workers-oauth/compose.ts:267-284`, cited from the check). On a v3-selected project every Project entry refuses a forwarded owner header with 403 AUTH_FORBIDDEN before any storage read other than the class probe, as `#command` already does (`cloud/src/project.ts:1083-1092`).

## C. Selection and generation binding

Rule: a project is served by v3 only when a server-side deployment setting names it and its stored artifacts fall in a v3 class below; classes are checked in the listed order on every request, the first match wins, and no class creates or deletes authority except provision, restore and promotion.

Artifacts: v2 markers (provision and restore KV markers, `cloud/src/project.ts:629-632`), v2 tables (`state_*`, `domain_cloud_*`, `cloud/src/v3-store.ts:103-104`); v3 schema tables root, pages, commits (`cloud/src/v3-store.ts:101`), tokens (111), restore stage (`cloud/src/v3-restore.ts:43`), checkpoint stage, staged, retired (`cloud/src/v3-checkpoint.ts:26-28`). "Root valid" means `readSealedRoot` succeeds (`cloud/src/v3-store.ts:263-359`).

| # | Setting | Stored state | Result |
|---|---|---|---|
| 1 | off | no v3 artifact | v2, as today |
| 2 | off | any v3 artifact | Mismatch: every route 409 INPUT_CONFLICT "Cloud v3 projects cannot use v2 routes"; admin status reports `mismatch`; never v2 |
| 3 | on | any v2 marker or table and any v3 artifact | Mixed: every route 409 INPUT_CONFLICT "Cloud v3 project storage is mixed"; status reports `mixed` |
| 4 | on | v2 marker or table only | Legacy: every route 409 INPUT_CONFLICT "Cloud v3 requires a fresh project" (`cloud/src/v3-store.ts:666`) |
| 5 | on | nothing | Empty: admin provision, admin restore into an empty target, status (`empty`); other routes 503 UNAVAILABLE "Cloud v3 project is not provisioned" |
| 6 | on | valid in-progress restore stage, no root table (conditions in the paragraph below) | Restoring: status, exact restore continuation and retry (`cloud/src/v3-restore.ts:189-248`); other routes 409 INPUT_CONFLICT "An admin restore is under way" (`cloud/src/project.ts:433`) |
| 7 | on | any other v3 artifact set where the root is not valid (missing table or row, token-only, pages-only, commits-only, bad MAC or shape, old commit schema, `forge-cloud-root/3` after slice 2, orphan checkpoint tables without a root) | Unavailable: every route 503 UNAVAILABLE; status reports `unavailable`; nothing created or deleted; repair is outside the pilot |
| 8 | on | valid root with `activationDigest` | Activated-stopped: status, exact restore retry, token inventory and revoke, login, reads (from slices 6-7), lane control and approval (16-17), promotion (22); writes 409 "The restored project is stopped" (`cloud/src/v3-store.ts:190`, 818); checkpoint refused (`cloud/src/v3-checkpoint.ts:285`) |
| 9 | on | valid ordinary root (leftover checkpoint or restore stage tables allowed) | Ordinary: section B surface; next checkpoint discards its stage and collects retired pages (`cloud/src/v3-checkpoint.ts:286`, 347); restore returns 409 RESTORE_TARGET_NOT_EMPTY (`cloud/src/v3-restore.ts:191-194`) |

Preserve the listed precedence. Probe all authority and maintenance table families and v2 markers on every request. If a root table exists, read and authenticate the bounded current root and validate its required schema and format before selecting class 8 or 9; cache neither this class nor root validity. This is a bounded root/class check, not a full image fold or an append comparison with the cached image, and it does not strengthen O1 into whole-image verification. A missing row, malformed root, bad MAC or obsolete schema is class 7 even on a warm object. If no root table exists, class 6 requires a valid in-progress restore stage with the expected schema, one or two sequential bounded member rows and a valid first-row manifest/pin, and no root/pages/commits/tokens/checkpoint/retired artifacts. An empty, malformed, completed-without-root or otherwise unexplained stage is class 7. Only an exact authenticated restore continuation may advance class 6. Do not repair any of these classes through an ordinary request. Status reports the selected class without creating or deleting storage. A stopped lane state inside class 9 (after promotion, before resume) is lane control, not a class.

- Asset: which authority serves a project; which history a credential, lease, receipt or backup belongs to.
- Threat: deployment input or a request switches authority; a recreated project accepts an earlier incarnation's rows, tokens or receipts; an unspecified state falls back to v2.
- Always holds: selection reads only server configuration and storage, never request data; commit row MACs bind object scope and incarnation (`cloud/src/v3-seal.ts:83-88`, `96-112`; verified at `cloud/src/v3-store.ts:570`); root MACs bind object scope (`cloud/src/v3-seal.ts:90-94`, `204-208`); activation mints a new incarnation and epoch (`cloud/src/v3-store.ts:694`); after slice 24 token MACs bind the incarnation, read from the authenticated root in the same turn.
- Not claimed: whole-object rollback to an older sealed state (forge-1832 limit); target binding of backups (O6); old-token receipts replaying for a new token (principal-scoped).

| Entry point | Role |
|---|---|
| `Project` constructor `cloud/src/project.ts:372-383`; `#hasV3Root` 417-419; `#requireV2` 431-436 | today's selection (test bit, cached presence) |
| `hasV3Root`, `hasPriorV3RestoreState` `cloud/src/v3-store.ts:109-115` | table probes (do not see stage tables) |
| `provisionV3` 659-682; `genesis` 117-137; `readSealedRoot` 263-359; `activateV3` 684-721 | create, validate, re-incarnate |
| `restoreV3Page` `cloud/src/v3-restore.ts:173-252`; `checkpoint` `cloud/src/v3-checkpoint.ts:276-427` | stage tables |
| token functions `cloud/src/v3-tokens.ts:107-212`; seal functions `cloud/src/v3-seal.ts:96-112`, `198-208` | bindings |
| Worker admission `cloud/src/worker.ts:96-117`, `194-212` | admitted project; admin bearer |

Slices: 24 (setting, classes, token incarnation), 26 (preflight checks the setting and `V3_SEAL_KEY` by name).

## D. Test adapters separated from production routes

Rule: production selection never enables the probe family or owner-header adapters, and is independent of every test-only occurrence; the committed production Worker does not set `testV3`.

Complete case-insensitive inventory of `testV3|test-v3` at the ref (20 lines, from the check, consistent with my narrower search): `cloud/src/store.ts:9`; `cloud/src/project.ts:368, 381, 432, 553, 554, 637, 666, 838, 1099`; `test/cloud/v3-project.fixture.ts:20, 113, 155, 156`; `test/cloud/v3-seal.test.ts:94, 115` (direct `testV3:true` contexts); `test/cloud/v3-seal-rows.test.ts:176`; `test/cloud/auth/wiring.test.ts:761, 772`; `.github/workflows/cloud.yml:802`. `cloud/conformance/fault-worker.ts:32-48` sets no bit; its line 34 is the conformance project header.

- Asset: the production authority boundary.
- Threat: a synthetic-frame route (`appendV3Frames`, no bearer check, `cloud/src/project.ts:620-626`) or owner-header probe reaches a real project.
- Always holds: the Worker path regex admits one lowercase segment (`cloud/src/worker.ts:33`), asserted by CI (`.github/workflows/cloud.yml:802`); after slice 24 the production branches are restore, devices and revoke, status, dump and export, command, raw leases, login and browser, and the class probe, all keyed on production selection; the probe family stays on the test bit.
- Not claimed: protection against someone who can deploy any Worker.

| Entry point | Rule after slice 24 |
|---|---|
| probe family `cloud/src/project.ts:552-636`; `appendV3Frames` `cloud/src/v3-store.ts:785-804` | test bit only |
| 432, 637, 665, 807, 838, 1099, raw 874-960, login 704-741 | production selection |
| fixture `test/cloud/v3-project.fixture.ts:111-157` | gains a production-selection mode; slice 25 uses it |

## E. Capacity, retention and lifetime

Rule: after slice 5 no append is admitted unless the projected history, snapshot, directory and export still fit the bounds below with a bounded reserve for safety operations (revoke release, lane stop, promotion); a refused append answers 503 STORAGE_LIMIT_EXCEEDED (`cloud/src/project.ts:227`) and writes nothing.

| Bound | Value | Source |
|---|---|---|
| command body; depth; nodes | 512 KiB; 32; 5,000 | `cloud/src/issue-commands.ts:57-65` |
| admin and raw body | 8,192 bytes | `cloud/src/project.ts:152` |
| v3 restore request | 2 MiB | `cloud/src/project.ts:645-650` |
| page, portable member | 256 KiB | `cloud/src/v3-store.ts:58`; `cloud/src/v3-restore.ts:85` |
| checkpoint pages | 3: directory:0, snapshot:0, transcript:0 | `cloud/src/v3-checkpoint.ts:129-154`, `190` |
| reader roster; directory | 640 pages; 32 pages, 4 MiB | `cloud/src/v3-store.ts:65-67`, `350-352` |
| root; checkpoint proposal | 128 KiB each | `cloud/src/v3-store.ts:64`, `270`; `cloud/src/v3-checkpoint.ts:30`, `345` |
| tail | 1,024 rows, 16 MiB | `cloud/src/v3-store.ts:68-69`, `838` |
| checkpoint turn | 12 rows, 512 KiB | `cloud/src/v3-checkpoint.ts:31-34` |
| stored JSON depth | 64 | `cloud/src/v3-store.ts:70` |
| imported lease entries at activation, including released | 16 | `cloud/src/v3-store.ts:71`, `692` |
| token labels; lifetime | 8,192 bytes; 90 days admin, 30 days login, pilot 7 (O2) | `cloud/src/v3-tokens.ts:20`; `cloud/src/tokens.ts:20`; `cloud/src/auth/project-login.ts:17-18` |
| usable commands per pilot; refusal-flood exhaustion; reserve; cold-start fold time | to be measured in slice 5 | none |
| multi-page formats | slice 31 | none |

Retention (read and traced, not run): the inspected v3 runtime has no age-based outcome pruning. It keeps the latest outcome per scoped request id; at the store API level a later call after `retryUntil` can replace that entry (`cloud/src/v3-store.ts:917-923`; `cloud/src/v3-commands.ts:216-247`), though an expired bearer cannot make that call and a new token has another principal. Checkpoint keeps every archived frame and adds up to 12 covered tail frames to transcript:0, capped at 256 KiB (`cloud/src/v3-checkpoint.ts:338-345`); `receiptCutoff` is staged (342, 355) but not written to the root (376-386). That cap limits checkpoint and export, not today's append (`cloud/src/v3-store.ts:838`). So the pilot has a finite lifetime of history; slice 5 enforces it and O9 gates slice 27 on the measured numbers. Export must also enforce the 16 imported-lease ceiling, not only the page bound.

Slice 5 must also budget: the history folds of section G (every archived and tail pass, counted as G's cost paragraph says; a checkpoint can run two archived replays), basis bytes per refusal frame, and the reserve. The Durable Object CPU limit is not checked here.

- Asset: a project that can always be checkpointed, exported and restored.
- Threat: commands, refusals or leases accumulate until checkpoint or export fails; a token holder floods refusals.
- Not claimed: any capacity number before slice 5.

Entry points: `append` `cloud/src/v3-store.ts:808-867`; `checkpoint`, `pack`, `roster` `cloud/src/v3-checkpoint.ts:276-427`, `129-196`; `activateV3` `cloud/src/v3-store.ts:684-721`; refusal records `cloud/src/v3-commands.ts:225-251`, `cloud/src/v3-store.ts:1208-1214`. Slices: 5, 23, 31.

## F. Rollback authority

Rule: each rollback has one named authority and leaves evidence; no rollback turns a v3 project into v2 or rewrites or deletes a v3 project in place; a binary older than a stored format may run only while the affected project is held unavailable, its data retained and a verified export usable by a compatible binary (O10 A). Export is a recovery prerequisite, not permission for an older reader to serve.

| Rollback | Who | Can undo | Cannot undo | Evidence |
|---|---|---|---|---|
| code deploy | deploy-rights holder (owner) | Worker code | stored data; A pre-slice-2 reader rejects forge-cloud-root/4 whenever it actually calls readSealedRoot: cold load, append, checkpoint, status paths that authenticate the root, or exact restore retry against an existing root. A warm reader can still answer cached command or lease replays without reading the new root. The old binary does not implement the new class table. Before deploying an incompatible binary, slice 26 must establish an ingress unavailability guard outside the binary being rolled back and account for existing warm objects; do not rely on the root bump or class 7 alone to stop reads and replays. Retain the data and the compatible verified-export recovery artifact under O10. G acceptance includes a warm old-reader replay counterexample and verifies the independent rollback guard through hosted checks. The root bump remains the correct cold-image compatibility signal, including after covered commits are deleted. | deploy version and artifact digest in the runbook record (26) |
| selection off | deploy rights | serving | writes; the project becomes class 2, never v2 | setting change in the runbook record |
| token revoke | `ADMIN_TOKEN` holder (`cloud/src/worker.ts:204-212`) | future use of the token; from slice 10, eligible session leases | executed commands; sibling sessions; whole-row rollback (A2) | signed `revoked_at`; audit lines (`cloud/src/v3-tokens.ts:130-133`); release frame (10) |
| restore | `ADMIN_TOKEN` holder, empty target only (`cloud/src/v3-restore.ts:191-194`) | nothing in place; makes a stopped copy | the source; resume without promotion | stage rows (`cloud/src/v3-restore.ts:239-248`), `activationDigest`, activation row, new incarnation |
| promotion | owner approval (H) | the stopped state of a verified restore | anything after the backup head | consumed approval and promote frame in the signed log |

- Not claimed: per-person admin identity (`ADMIN_TOKEN` is one shared secret, `cloud/src/worker.ts:40-51`); undoing a merged close or a dispatched lane. Preflight lacks `V3_SEAL_KEY` (`cloud/scripts/preflight.mjs:11`); slice 26 adds it by name.

## G. Refusal basis (forge-1825, slice 2)

Rule: every recorded command-family refusal frame carries a closed bounded basis; state-stage refusals are re-derived against prior state by the same decision function the writer used, and input-stage refusals are checked for membership in a fixed per-operation list (O7 A); this runs on append before signing and on every fold of history, including history already checkpointed; an image needing this check carries root format `forge-cloud-root/4`, which a pre-slice-2 reader rejects whenever it reads the root (a warm old reader can still answer cached replays; see F).

Defect today: a claim refusal returns once events are empty (`cloud/src/v3-store.ts:1039-1041`); create and update refusals are only shape-checked (`cloud/src/v3-record-transitions.ts:125-135`); `authorityFault` checks error shape and code list only (`cloud/src/v3-authority.ts:113-129`). An authentic manifest can carry invented but well-formed refusals; `test/cloud/v3-manifest-seal.test.ts:246-267` shows this succeeding today.

- Asset: the truth of recorded refusals and of replays that return them.
- Threat: a key holder (including the signer of a backup accepted under the previous key) or a writer bug signs a refusal the prior state did not produce. An unkeyed storage writer is already stopped by the row, root and manifest MACs.
- Always holds (after slice 2): every recorded state-stage refusal in a verified image is what the prior image produces for its basis at its time and expiry; every input-stage refusal is in its operation's list; no basis stores input that failed a check.
- Not claimed: that the basis is what the client sent; that an input-stage refusal followed really invalid input (O7); a fabricated history that is consistent end to end; refusals that are returned but not recorded (UNKNOWN_COMMAND, parser and context errors, AUTH_*, request-id conflicts, `expiredReplay`, claim-witness and replay LEASE_STALE, stopped INPUT_CONFLICT, storage UNAVAILABLE, token issue and revoke input errors). No frames are added for those.

### Basis grammar

`basis` is a frame member present on every command-family frame (create, update, claim) whose outcome status is not `ok`, and absent on every other frame. Closed keys; canonical JSON; at most 2,048 bytes plus the holder (below). Strings are the writer's already-validated values.

| Operation, stage | `basis` | Domains |
|---|---|---|
| create, input | `{"stage":"input"}` | none |
| update, input | `{"stage":"input"}` | none |
| claim, input | `{"stage":"input"}` | none |
| update, state | `{"stage":"state","id","prefix","expectRevision","holder","generation"}` | `id`: the original displayed id, matching `QUALIFIED` (`cloud/src/issue-read.ts:28`), 1 to 200 characters (ItemId, `schemas/tracker.json:6-9`); prefix is the historical configured prefix used for this decision, validated by configured(): 1 to 32 characters matching ^[a-z0-9]+(?:-[a-z0-9]+)*$. It is carried in the basis so recovery does not substitute today's deployment setting. The displayed id retains its separate ItemId bound and QUALIFIED grammar. expectRevision and generation use the finite integer domain accepted by their input/context schemas, with minimum 1; those schemas do not impose a safe-integer maximum. Do not reject an otherwise valid basis solely because either requested value exceeds Number.MAX_SAFE_INTEGER. Frame counters and stored revision/generation rules retain their own existing checks. Re-run configured before storedId and the state decision, just as the writer does before entering its command decision. Other members: `holder`: passes `validateLeaseHolder`, canonical form at most 8,192 bytes (schema maxima total 1,056 characters, `schemas/context.json:6-44`); `generation`: integer ≥1 |
| claim, state | `{"stage":"state","id","prefix","holder","ttlMs"}` | `id`, `prefix`, `holder` as above; `ttlMs`: `ttlSeconds × 1000` for a schema-valid `ttlSeconds` in 1 to 604,800 (`schemas/tracker.json:261-266`), or the default; so a multiple of 1,000 in 1,000 to 604,800,000. Not required to pass `checkTtl`. |

The subject is derived (`issue:` + `storedId(id, prefix)`), never stored; a context subject inconsistent with it is refused at write.

Stage assignment, in writer order:

- create: `checked(input)` failures are input stage (`cloud/src/issue-create.ts:30-45`). No state stage.
- update (`cloud/src/v3-commands.ts:146-184`): `checkedUpdateInput` failures and "Invalid issue id" (`cloud/src/issue-read.ts:127`) are input stage. State stage, in order: "Unknown issue id prefix" INPUT_INVALID (130); NOT_FOUND "Issue was not found" (168); LEASE_NOT_HELD, LEASE_STALE, LEASE_EXPIRED from `decideLease` at frame time (170; `src/contract/lease.ts:126-158`, cited from the check); REVISION_CONFLICT, compared as the whole error including `currentRevision` and `retry:"reconcile_first"` (171-177).
- claim (`cloud/src/v3-commands.ts:82-124`): `validateClaimInput` failure "Expected a valid issue claim" and "Invalid issue id" are input stage. State stage, in order: "Unknown issue id prefix"; NOT_FOUND (`cloud/src/v3-store.ts:981-982`); INPUT_CONFLICT closed (987-988); CLAIM_BLOCKED with exact message and `observed` (994-1014); INPUT_INVALID "ttlMs is over 24 hours" or "ttlMs would exceed the token expiry" (`checkTtl` at 1016, `cloud/src/lease-ttl.ts:15-18`, with expiry = `outcome.retryUntil`); LEASE_HELD (1017-1021). In claim, validation and `storedId` run before the witness test, and the witness test runs before `claimEffect`. Input-stage errors and the state-stage "Unknown issue id prefix" error are recorded even when a claim witness for the request id exists, so they need no witness absence. Once `storedId` succeeds, an existing witness returns unrecorded LEASE_STALE (`cloud/src/v3-refusals.ts` `claimDecision`) and prevents every later `claimEffect` outcome. Only a recorded refusal reached through `claimEffect` requires the claim witness to be absent from the prior image.
- lease family: no basis; the fingerprint is the full input (`cloud/src/v3-authority.ts:65-75`); its existing re-derivation (`cloud/src/v3-store.ts:1103-1161`) now runs on every fold, including cold.

Input-refusal lists: exact `{code:"INPUT_INVALID",message,retry:"never"}` errors with fixed text, one list per operation shared by writer and verifier, taken from `cloud/src/issue-create.ts:36-44`, `cloud/src/issue-update.ts:100-105`, `cloud/src/v3-commands.ts:85-86`, `cloud/src/issue-read.ts:127`. A message that embeds request text becomes fixed text in slice 2.

### Where re-derivation runs

One decision function per command, called by the writer and by the verifier; the verifier reads prior state only from the image being folded.

1. Append: before signing, the new refusal is re-derived against the current image; a mismatch is refused with no INSERT, sign or publish (`cloud/src/v3-store.ts:845-858`).
2. Cold ordinary recovery and activated recovery (`recoverV3`, 485-575; activated recovery is also item 4): On cold ordinary recovery and activated recovery, independently fold the authenticated archived transcript from an empty historical image. Reconstruct and check archived results, then require exact equality of the folded inventory and the inventory described by the authenticated directory and snapshot, including values, revisions, tombstones, leases, outcomes, witnesses and every later collection. Check the snapshot bytes and directory offsets, lengths and digests with the same reconciliation rule used by portable restore. Require their common projection digest to equal root.publicDigest, and require the folded head, event watermark and allocation floors to agree with the covered snapshot metadata. Only then use that snapshot as prior state for the uncovered tail or activation. Apply the same checks before checkpoint publishes replacement pages. Comparing replay only with a digest supplied by the root is insufficient.
3. Checkpoint: the checks of item 2 on the archived history (today it checks only count and digest, `cloud/src/v3-checkpoint.ts:310-328`), then the covered tail (321-331).
4. Activated recovery: as item 2.
5. Portable restore: the existing fold (`cloud/src/v3-restore.ts:144-171`) with the verifier.

Local root and transcript authentication (root MAC, page hashes) stays separate from the portable manifest brand. Each individual archived replay processes at most one 256 KiB transcript page; ordinary cold recovery also admits at most 1,024 tail rows and 16 MiB of tail bodies. These are input-byte bounds, not a measured CPU or heap bound. A checkpoint currently calls recoverV3 before staging and again inside root publication, so adding the archived check to recoverV3 can perform two archived replays in one checkpoint, plus newly covered tail work. Plan either both passes or an explicitly checked reuse of verified state. Account for the served snapshot image, historical replay image, parsed frames, stored page buffers, tail bodies and reconstruction temporaries. Prefix scans and dependency checks also contribute work per frame. Slice 5 measures worst-case CPU, peak heap, fold count and storage work and budgets them before slice 27; slice 31 repeats that work for larger formats. No one-snapshot heap or one-fold-per-checkpoint claim is made here.

### Stored format and old readers

- `ROOT_FORMAT` becomes `forge-cloud-root/4` (`cloud/src/v3-store.ts:72`). A pre-slice-2 reader rejects it whenever it calls `readSealedRoot` (see F for the warm-reader case): a generation-0 root must equal its own genesis bytes (347) and a later root must carry its own format (`sealedFields`, 233-236, used at 348). Checkpoint carries the format forward through `...root` (`cloud/src/v3-checkpoint.ts:377`); activation writes the new constant through `genesis` (`cloud/src/v3-store.ts:694-696`).
- `FRAME_KEYS` gains `basis` (76-79). Commit format stays `forge-cloud-commit/3`; the root format is the image-level signal.
- Portable format unchanged: a pre-slice-2 binary folds every portable frame (608-617), so a backup with any basis frame fails its closed key check (899-912); a backup with no refusal frame needs no new check.
- `apply` drops the frame and keeps the outcome (917-928), so `basis` is not in snapshot outcomes; `archive` keeps it in transcript:0 (`cloud/src/v3-checkpoint.ts:94-101`).
- After slice 2 the reader accepts only `/4` roots, and a command refusal without `basis` is refused everywhere (O8 A). Last reader of `/3`: the binary before slice 2.
- Portable `issue.create` refusals: today `authorityFault` rejects every portable create frame (`cloud/src/v3-authority.ts:193-201`). Slice 2 admits a portable create frame whose status is INPUT_INVALID with an input basis, The archived-history verifier must accept and reconstruct every honest frame produced before its cut, including successful issue.create frames. Checkpoint keeps the issue.create operation, its event and its changes, but replaces outcome.result with outcome.resultDigest. For archived local replay, reconstruct the create result from the create event, prefix, allocated id, revision and frame time; compare its digest, verify its changes, and retain the reconstructed result for projection reconciliation. Keep live result validation unchanged. Do not use portable mode unchanged: its present authority validator rejects successful issue.create. Before slice 2 begins, specify and check the archived replay mode and its interaction with portable create-success handling. Add an honest create-success followed by a state refusal, two checkpoints and cold recovery, plus the corresponding supported portable history, to acceptance. No producer may emit history that its consumer cannot independently fold.

### Rejected alternatives

1. Subject taken from the saved error: the receipt chooses its own premise (forge-1825).
2. Raw request stored: keeps invalid and possibly sensitive data, up to 512 KiB per refusal. It does not rule out a bounded redacted witness (O7 B).
3. No frame for input refusals: changes replay and request-id behavior (`cloud/src/v3-commands.ts:216-250`) and departs from v2's bounded denials (`cloud/src/issue-receipts.ts:252-273`). A policy trade-off, kept as a slice 5 lever only with owner approval.
4. Basis bound into the fingerprint: changes refusal fingerprints and conflict checks; a refusal-only scheme is possible but costs compatibility for no added proof.
5. Basis inside `outcome`: spends snapshot bytes on every refusal and changes the shared key sets (`cloud/src/v3-authority.ts:18-20`).
6. Commit-format bump only: misses checkpointed history, which a pre-slice-2 reader never folds. Replaced by the root-format bump above.

### Slice 2 acceptance

Local tamper rows sign edited rows with the fixture signer (`test/cloud/v3-project.fixture.ts:119-131`). Portable rows build snapshot, directory offsets, lengths and digests, transcript, projection, manifest member hashes, MAC and pin consistently with the trusted fixture signer, signing plain data once (forge-1846.md:197), and include an honest sibling that passes the outer checks. Slice 2 builds portable artifacts locally; there is no production export route until slice 20. "Refused" means: cold 503 UNAVAILABLE, checkpoint 503 UNAVAILABLE, portable 400 RESTORE_INVALID_ROW (`cloud/src/v3-store.ts:189`; `cloud/src/v3-checkpoint.ts:38-44`; `cloud/src/v3-restore.ts:166-170`); CLI exit 1 (`src/surface/result.ts:69-89`) asserted through the CLI adapter, not raw HTTP. These are predictions from code.

| # | Case | Expected |
|---|---|---|
| 1 | Honest refusal of every recorded code, including update and claim unknown prefix and both claim TTL refusals; then cold, checkpoint, second checkpoint, export and restore, exact replay | first reply: INPUT_INVALID 400/6, NOT_FOUND 404/3, conflicts and lease errors 409/4, CLAIM_BLOCKED 409/1; replay identical with zero writes; one frame per refusal, each with `basis` |
| 2 | Claim LEASE_HELD message edited | refused on cold, checkpoint, portable |
| 3 | Claim LEASE_HELD reported generation edited | same |
| 4 | Claim basis names an open issue with no live lease, no blockers, valid TTL, so `claimEffect` succeeds | same |
| 5 | Archived refusal `resultDigest` edited with snapshot, directory and projection rebuilt to match | portable refused; earlier staged pages may remain; final verify writes nothing |
| 6 | Create INPUT_INVALID message outside the list | refused locally and portable |
| 7 | Update REVISION_CONFLICT `currentRevision` edited | refused |
| 8 | Update NOT_FOUND while the record exists, with valid lease and revision | refused |
| 9 | Refusal frame without `basis` | refused, in tail and after checkpoint |
| 10 | `basis` with an extra key, a raw input field, a wrong type or an over-bound string | refused |
| 11 | Ok frame carrying `basis` | refused |
| 12 | Lease-family refusal edited | cold refused (new); checkpoint and portable as today |
| 13 | Append called directly with a well-formed command refusal not re-derivable from a real prior image | refused before INSERT, sign or publish; root unchanged |
| 14 | Refusal tampered then checkpointed, then cold load | refused (archived history check) |
| 15 | Activated restore whose imported history has a tampered refusal | cold activated recovery refused |
| 16 | `/4` root under a pre-slice-2 reader | cold: a pre-slice-2 reader refuses the root at `readSealedRoot` (`cloud/src/v3-store.ts` `sealedFields` 234-250, format test 237, genesis equality 348, call 349 at 3188d0fa); reasoned, no test of an old binary. Warm: a warm old reader can answer a cached command or lease replay without reading the root (`cloud/src/v3-commands.ts:217-225` runs before `append`); reasoned, a counterexample. Slice 2 owns only these two arguments. Hosted verification of the independent ingress rollback guard stays in F and in slice 26's acceptance, required before an incompatible serving rollback. Slice 2 neither implements nor verifies it |
| 17 | Controls | unrelated assertions, timeouts and budgets kept; `test/cloud/v3-manifest-seal.test.ts:246-267` (trusted-signer rewritten refusal restores successfully) is deliberately changed to a semantic refusal, with an honest signed-backup control kept; this change is recorded in the red-first plan; other handcrafted refusal fixtures gain `basis` without weakening their checks |
| 18 | Honest create success, then a state refusal on that issue, two checkpoints, cold recovery (history H of `forge-1825-design.md`) | exact replay of both with zero writes |
| 19 | The portable form of row 18 | restores; cold activated recovery passes; exact replays |
| 20 | r2 change 1 counterexample: honest transcript and `publicDigest`, one snapshot value edited with its directory entry, roster hash and root re-signed by the fixture signer | cold refused, checkpoint refused |

Coordination with forge-1846 (PR 763): forge-1846 keeps that test (forge-1846.md:67, 134). Merge order: PR 763 first; slice 2 rebases onto it and alone owns the edit to `test/cloud/v3-manifest-seal.test.ts:182-267`. forge-1846 must not change those lines further.

## H. Restored-root promotion

Rule: a verified activated root becomes ordinary only through one promotion transaction that consumes an owner approval bound to project, object, incarnation, restoreEpoch and activationDigest, appends one `restore.promote` frame and re-signs the root; the project stays stopped by lane control until an ordinary owner resume.

Today: activation writes a generation-1 root with `activationDigest` and one row at `coveredHead + 1` whose frame holds `control` and `restoreEpoch`, outside `FRAME_KEYS` (`cloud/src/v3-store.ts:433-452`, 684-721, 76-79); recovery verifies it by byte equality and releases imported leases in the image only (454-483); append, checkpoint and ordinary fold refuse it (818; `cloud/src/v3-checkpoint.ts:285`; `cloud/src/v3-store.ts:632-646`).

Representation:

1. `restore.activate` becomes an ordinary frame kind with its own closed key set (`format`, `operation`, `restoreEpoch`, `sequence`, `time`, `control`, `events`). Rebuild historical activation bytes using control.incarnation, restoreEpoch, sequence minus one and frame time. LaneControlGlobal has an incarnation member, not a project member. For the current activation boundary require that incarnation and restoreEpoch to match the authenticated current root; historical activation boundaries retain their historical identities.
2. Imported-lease releases are a derived effect of that frame, re-derived on every fold: every unreleased imported lease gets `releasedAt` = frame time; more than 16 lease entries refuses. No separate release frames.
3. Activation and promotion representation is not yet settled. Before slice 4, specify closed keys, member domains and bounds, event shape, approval-receipt representation and replay validation for restore.promote, and specify the allowed activation-to-promotion transitions. Ordinary recovery must prove that removing the current activation marker corresponds to a verified promotion frame for that activation; a valid-looking ordinary root alone is not proof. A copied or repeated historical activation must not reset current control identity or epochs. Define how a new restore boundary handles imported global and per-issue controls while preserving their historical evidence and invalidating old execution authority. Demonstrate one full history containing per-issue stop, export, restore, promotion, resume, export again and restore again. State separately the image head/event watermark and the root's covered snapshot metadata: promotion leaves coveredHead and its snapshot eventWatermark unchanged, and folding activation and promote advances the image counters once each. Define the post-commit warm image, cold recovery, first and later checkpoint cuts, portable replay, concurrent promotion and exact retry outcomes. Slice 22 implements this checked representation; it must not design it for the first time. Keep stopped-issued token validity and retained-stage policy as already specified.
4. Promotion keeps `coveredHead` unchanged, appends `restore.promote` at `activation sequence + 1`, sets generation 2, parent digest = digest of the activated root body (as checkpoint does, `cloud/src/v3-checkpoint.ts:288`, 380), drops `activationDigest`, keeps incarnation and restoreEpoch. Head and `eventWatermark` advance one per frame, as `applyActivation` does today (479-480). Both rows then fold as ordinary tail rows; the next checkpoint archives them.
5. Tokens issued while stopped stay valid after promotion (same incarnation). Source tokens never carry over (new incarnation, no token data in backups).
6. The restore stage table and its rows are kept as evidence; after promotion an exact restore retry answers 409 RESTORE_TARGET_NOT_EMPTY. Export of an activated, unpromoted root is refused 409 "The restored project is stopped"; export works after promotion.

- Asset: permission to resume work on restored data.
- Threat: a root edit, replayed approval or ordinary `lane.resume` turns a restored copy live without the owner; promotion runs twice.
- Always holds: promotion is not resume; approval consumption and the state change commit together; nobody deletes `activationDigest` by hand.
- Not claimed: that the restored backup was the intended one (O6); re-run of merge proofs in the backup.

Must be settled before:

| Slice | Item (from this section) |
|---|---|
| 2 | `restore.activate` key set listed in G's frame grammar work, so `FRAME_KEYS` changes once |
| 4 | items 1 to 3: activate frame kind, derived releases, control record |
| 16 | lane control reads and writes the same control record; resume clears stop |
| 17, 19 | approval binding fields (B reserved contracts); item 5 |
| 20, 21 | item 6; activated-root export refusal |
| 22 | Slice 22 implements the checked representation; the representation is designed and checked before slice 4 (see the status block at the top). |

Entry points: `activateV3`, `activationFrame`, `applyActivation` `cloud/src/v3-store.ts:684-721`, `433-483`; activation branch 557-560; `foldRow` 621-651; `restoreV3Page` `cloud/src/v3-restore.ts:173-252`; status `cloud/src/project.ts:837-848`.

## I. Non-deferrable rules

Rule: every slice from 2 to 34 names in its brief which rules it touches and adds acceptance rows for each; the merge gate refuses a slice that weakens one.

| Rule | Checkable sentence | Exists today | Slices |
|---|---|---|---|
| Owner approval | honored only if the server verifies the owner proof and consumes it in the same transaction as the change, bound to operation, project, incarnation, epoch, session, and for promotion the activation digest | v2 browser proof `cloud/src/auth/device-browser.ts:294-314`; issuer checks `cloud/src/auth/project-login.ts:263-282` | 17, 19, 22, 27 |
| Single authoritative write | every tracker, lease and control mutation atomically commits its effects and replay evidence in signed history, then publishes; token, challenge, approval and checkpoint or root maintenance follow their own authenticated transactions; no v2 dual write or local fallback; revoke and eligible releases are one transaction; approval consumption and its mutation are atomic | append `cloud/src/v3-store.ts:816-866`; tokens `cloud/src/v3-tokens.ts:171-187`, `197-210`; checkpoint root swap `cloud/src/v3-checkpoint.ts:388-408`; restore `cloud/src/v3-restore.ts:187-248` | 2, 4, 5, 10, 15, 17, 22, 24, 30, every command slice |
| Device and session | device, session and expiry come only from the second token check, rechecked after every await; body metadata is not proof | `cloud/src/project.ts:1102-1115` | 8-10, 15, 17-19, 24, 25 |
| Project scope | admitted project and object scope bind every request, row, root and token; incarnation binds rows and (24) tokens; class (C) checked every request | `cloud/src/worker.ts:96-117`; `cloud/src/v3-seal.ts:83-94`, `185-196` | 20-22, 24, 27, 32, 33 |
| Merge proof | v3 close stays refused until server-observed merge evidence is rechecked in the final transaction | v2 only | 12, 14, 15, 25 |
| Verified restore | activates only pages matching an authenticated manifest whose history passes G's fold | `cloud/src/v3-restore.ts:64-96`, `144-171` | 2, 3, 20-22, 25-27 |
| Size limits | every stored or request body is bounded before it is materialized; admission keeps export possible | section E | 5, every route slice, 20-26, 31 |
| Truthful results | replies distinguish the C classes and staged, verified, stopped, promoted, running; a lost or ambiguous response is never reported as definite success or failure without reconciliation; operation identity and retry posture are kept; HTTP status and CLI exit are stated separately | partial; status gap `cloud/src/project.ts:849-859`; storage failure 961-964, 1156-1161 | 2, 10, 15, 17, 19, 21-27 |
| Independent merge gate | each PR gated by a fresh reviewer of a different model from its builder (GPT-6.1 Sol xhigh), no P0 or P1 | practice | every slice |
| Hosted CI | tests run only on hosted CI, red first then green; unrelated assertions kept; any deliberate change of an existing assertion (as in G row 17) is named in the red-first plan | owner rule | every slice |
| Old frames stay foldable | A change to historical admission, schemas, validators, decision functions, canonicalization or refusal text must keep every previously written honest frame in the supported root format foldable with the same derived result, or bump the root format and apply the incompatible-format deployment and rollback rules. | none (new rule from forge-1825) | 2, and every slice that changes these rules |

## Open points

1. Slice 10: frame encoding of revoke releases, under A4's stated historical limit.
2. Slice 20: whether the manifest records the source incarnation (portable format change) or this stays unrecorded.
3. Slice 24: name and shape of the selection setting; slice 26 validates it.
4. Slice 2 scope grows (root `/4`, history fold, `restore.activate` key set, portable create refusals); slice 4 gains H items 1 to 3. No slice reorder proposed.
5. Class 7 repair: an admin path to inspect and clear an unavailable project is outside the pilot; until it exists such a project needs manual handling by the owner.
6. Not re-read by me, taken from the check: `cloud/src/project.ts:1287-1306` (raw metadata), `src/contract/lease.ts:90-158`, `cloud/src/auth/device-browser.ts:294-314`, `cloud/src/auth/compose.ts:14-17`, `cloud/src/adapters/workers-oauth/compose.ts:267-284`, `state-access.ts:72-78`, `cloud/src/dump.ts:430-431`, and the 20-line test-bit inventory. Slices citing them re-read them.

## Evidence

Read in full: the check, the path report, forge-1838.md, forge-1843-gate-r2.md, forge-1848.md; in part: forge-1848-gate-r2.md, forge-1846.md. Issues read with read-only `issue show --text`: forge-1825, 1837, 1842, 1847, 1849, 1850, 1851, 1853.

Code read with `git show 0fb2aa74:<path>` (revision 0 list, plus for this revision): `cloud/src/v3-store.ts` 100-190, 220-360, 425-721, 956-1063; `cloud/src/v3-checkpoint.ts` 94-101, 276-427; `cloud/src/v3-commands.ts` 40-252; `cloud/src/lease-ttl.ts` all; `cloud/src/issue-read.ts` 28, 110-140; `cloud/src/v3-restore.ts` 106-171; `cloud/src/v3-authority.ts` 175-234; `cloud/src/issue-claim.ts` 50-70; `cloud/src/v3-seal.ts` 30-52; `cloud/src/auth/project-login.ts` 15-19, 263-282; `src/surface/result.ts` 69-89; `test/cloud/v3-tokens.test.ts` 852-872; `test/cloud/v3-manifest-seal.test.ts` 178-270 (grep); `schemas/tracker.json` 6-9, 240-275; `schemas/state.json` 40-68; `schemas/context.json` 6-60.

Read the line: every current-behavior statement with a reference I read. Traced: the format rejection by an old reader (G), the class table (C), the cold-fold placement (G), the promotion fold (H), retention (E). Taken from the check without re-reading: open point 6. Nothing was run: no tests, builds, deploys or tracker writes.

## Changes after the check

| # | Change | Applied in |
|---|---|---|
| 1 | narrow stale-image guarantee; selection freshness | O1, A1, C (per-request class) |
| 2 | current versus target in B | B table columns and today notes |
| 3 | before-body limit; two unknown-op errors | B intro |
| 4 | full route coverage; owner-header guard | B reserved contracts, owner-header rule; D production branch list |
| 5 | ordered classification | C classes 1-9 |
| 6 | test-bit inventory | D |
| 7 | retention and ceiling wording | E retention, O9 |
| 8 | verifier placement covers checkpointed history | G "Where re-derivation runs", rows 14-15, E cost |
| 9 | basis grammar; claim and update state INPUT_INVALID | G grammar and stage assignment |
| 10 | weaker input-refusal theorem | G rule and Not claimed; O7 |
| 11 | acceptance fixtures | G rows 4, 5, 13, portable construction, create-refusal rule |
| 12 | obsolete success assertion | G row 17; I hosted CI; forge-1846 coordination |
| 13 | image-level compatibility | G stored format (root `/4`); O8 |
| 14 | promotion representation before earlier slices | H representation and must-settle table |
| 15 | sibling observation is not proof | A4, O4 |
| 16 | single-write rule; indeterminate results | I |
| 17 | owner-visible policy choices; O5 C prerequisites | intro, O5 C, O7-O10 |
| 18 | citations and evidence | A2, O2, E, I, Evidence |
| 19 | export is not serving permission | F rule, O10 |

Second check: 12 of the 19 round 1 changes applied, 7 partial. The 7 are corrected in revision 2 with the checker's text; items 2 and 3 of the second check remain open designs (see the status block).
