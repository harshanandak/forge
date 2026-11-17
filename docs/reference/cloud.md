# Forge cloud claim server

A Cloudflare Worker with one SQLite Durable Object per project. It decides who holds a lease on a
subject. The code is in `cloud/`.

Release acceptance follows [the release runbook](../release.md) and the two-machine supplement below. Owner decision V001 keeps the temporary prerelease candidate from `package.json` for now, with the beta-tag default; the owner sets the final version at release time. The current workflow publishes to `next`, then promotes prereleases to `beta` and stable versions to `latest` after readback and the second owner approval. Never substitute a tag, package name or version during proof.

## Installed release and two-machine proof

Keep three separate results: hosted packed acceptance, live candidate-tarball acceptance and live public-registry acceptance. Missing stages are INCOMPLETE/2. CI fixtures establish installed wiring and real Project authority behavior locally; they do not establish physical-machine, deployed restore or owner identity acceptance. Execute this supplement only under separate authorization for disposable resources; it authorizes no deployment, cutover or publication.

The private artifact ledger records reviewed main commit (`RELEASE_SHA`), successful push CI URL/run (`CI_RUN`), exact package/version (`VERSION`), artifact SHA-256 (`ARTIFACT_SHA256`), SHA-512 integrity, installed `dist/build.json`, CLI identity, Node version, absolute installed bin, Worker version/config, project names and machine/device/session identities. Use Windows A and a safe disposable boxes.dev B, with A1/A2 sharing A's device and B1 independent. Never reuse the meetings-template box. Save timestamped envelopes, actual CLI exits, HTTP outcomes and dispatch sentinels; redact credentials, headers and private login responses. Confidential dumps stay private, outside commits and public CI artifacts.

On both machines use new absolute prefixes/caches and the same downloaded CI archive. Read the candidate version from `package.json` in the reviewed source checkout. Verify the CI event is push, branch main, conclusion success and head exactly `RELEASE_SHA`; compare the archive against the independent ledger digest, not only its adjacent sidecar. Do not rebuild, repack or use the global forge on PATH.

```sh
VERSION=$(node -p "require('./package.json').version")
gh run view "$CI_RUN" --repo harshanandak/forge --json headSha,headBranch,event,conclusion,url
gh run download "$CI_RUN" --repo harshanandak/forge --name packed-package --dir "$ARTIFACT_DIR"
printf '%s  %s\n' "$ARTIFACT_SHA256" "$TARBALL" | sha256sum -c -
npm install --prefix "$PREFIX" --cache "$CACHE" --ignore-scripts "$TARBALL"
BIN="$PREFIX/node_modules/forge-workflow/dist/bin/forge.js"
node --version
node "$BIN" --version --json
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; import {hash} from "node:crypto"; const p=process.env; const build=JSON.parse(readFileSync(p.PREFIX+"/node_modules/forge-workflow/dist/build.json","utf8")); assert.deepEqual(build,{version:p.VERSION,commit:p.RELEASE_SHA,dirty:false,runId:p.CI_RUN}); console.log(JSON.stringify({build,integrity:"sha512-"+hash("sha512",readFileSync(p.TARBALL),"base64")}));'
```

Export the named nonsecret ledger variables before these commands. Preserve the existing no-Bun consumer PATH and local-owner sentinel from the installed acceptance fixture. Every subsequent command uses `node "$BIN"`; prepare project identities/config through the supported setup operation, then initiate `node "$BIN" auth login --origin "$ORIGIN" --project "$PROJECT"`. The agent runs setup, login initiation and command work; the owner personally approves each matching device code in the Clerk browser. Transfer only the committed nonsecret binding between machines, never credentials. Login cannot create a missing project identity or replace an established binding.

| Phase, in order      | Agent work                                                                                                                                                              | Owner boundary                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Artifact/environment | Check ledger, cold prefixes, isolated Worker/config; verify both new project names have empty status and all six empty tables                                           | Verified owner subject supplied privately if missing         |
| Provision/login      | Provision source only, revoke bootstrap credential, initialize fixture once; start A/B logins                                                                           | Approve each device in browser                               |
| Stages 1-2           | A1/A2/B1 create/read/comment/held edit; identical create/comment request replay; exact domain-event counts                                                              | None                                                         |
| Stages 3-4           | Separate three-session and 100-call races; one winner each; compare every holder tuple/expiry; release/reacquire/renew and exact stale-generation refusals              | None                                                         |
| Stage 5              | Fresh bound clone names remote holder then claims after release; reversible outage refuses reads/writes and store reinit, including dry-run; reconnect and compare data | None; agent runs command work                                |
| Stage 6              | Revoke precisely disposable B credential id; account for every covering token, next-call refusal, full released list and retained A access                              | None; never disclose token                                   |
| Stage 7              | Quiet source, export every v2 page, restore never-provisioned target; complete admin table readback before target login                                                 | None                                                         |
| Restored stop/resume | Fresh target logins, global/lane control reads, zero-launch dispatch sentinel, old-fence/approval refusals; request shared all-lanes resume and retry its exact request | Approve target logins and fresh all-lanes resume in browser  |
| Fresh resumed work   | Fresh issue revisions/read-set and claim, one permitted dispatch, stale refusals, final stopped cleanup                                                                 | None                                                         |
| Published repeat     | New exact-version registry installs and new disposable projects on A/B; repeat every phase                                                                              | Owner publication first; fresh browser approvals as required |

The restored typed-command target must be admitted on the isolated Worker. Changing admission/config or deploying is a separate authorization with prior admission/config and Worker version recorded as the reverse path. An admin-only unadmitted target cannot prove stopped dispatch. If unavailable, leave that phase INCOMPLETE. Caller-policy refusal never authorizes hand-editing credentials/bindings, impersonation or bypassing attended approval.

Read raw v2 export pages and compare every column in canonical order in `state_records`, `state_events`, `state_leases`, `state_requests`, `domain_cloud_requests` and `domain_cloud_command_receipts`. Validate exactly the floor, lease-release and stop/audit deltas described under Stopped activation; reject missing/extra rows or pages. A serving restore adds another stop and is not a neutral comparison. Enumerate X, Y, R, every comment/link, deleted-number allocation floor, holder/generation/release event, replay receipt and control/audit object, including all N imported values and F floors. No count-only or sample-only acceptance.

Require no held imported lease, no consumable old approval/browser state and no login/token state in the dump. CI inspects private tables directly; live refusal behavior complements dump exclusion. Retained ordinary-restore receipt bytes are imported history, never fresh grants; current-state imports carry no receipts/leases. A reused raw request id under a new token is a different principal: verify scoped replay isolation. Reach stale fences with valid current credentials, revisions and original generation context; distinguish released LEASE_NOT_HELD from replaced LEASE_STALE. A local context refusal is not server proof. Keep verified-close evidence in a separate disposable project because snapshot export refuses such evidence; never erase it for a passing dump.

Record ResultEnvelope status and CLI exit separately from HTTP and runner verdict. OK is 0, INCOMPLETE 2, lease conflicts 4, invalid/context input 6, and unavailable/approval/auth failures here 1. A successful restore is not dispatch permission. Per-lane resume cannot lift global stop; fresh owner-approved shared all-lanes resume, current grant and fresh reads remain required. Existing processes are not cancelled. Lost final restore response requires status/dump inspection; discard an ambiguous disposable target rather than forcing activation.

After owner publication, install only the exact public version on both machines with fresh caches/prefixes and save registry metadata and npm-verified signatures/provenance. Compare registry integrity to the same reviewed archive, installed build commit/run/version to the ledger, and signer/source/workflow to release policy. Repeat the complete live proof in fresh projects; re-fetch registry metadata and both installed identities before acceptance. These read-only commands do not authorize publishing:

```sh
npm view "forge-workflow@$VERSION" version dist.integrity dist.attestations --json
npm view forge-workflow dist-tags --json
npm install --prefix "$REGISTRY_PREFIX" --cache "$REGISTRY_CACHE" --ignore-scripts "forge-workflow@$VERSION"
npm audit signatures --prefix "$REGISTRY_PREFIX" --json --include-attestations > "$PRIVATE_AUDIT"
```

Owner-only handoff: after the reviewed version merges, all prerequisites/main CI and candidate proof pass, verify the GitHub `release` environment actually requires owner approval for both publish and promote, main-only deployment and no administrator bypass. Check npm trusted publishing and dist-tag permission. An environment name in YAML is not evidence. If policy or unused-version availability fails, stop; never fall back to an agent token or a different artifact.

Owner-only commands, never for agents to execute:

```sh
test "$(gh api repos/harshanandak/forge/commits/main --jq .sha)" = "$RELEASE_SHA"
gh run view "$CI_RUN" --repo harshanandak/forge
gh workflow run release.yml --repo harshanandak/forge --ref main -f run_id="$CI_RUN"
RELEASE_RUN=$(gh run list --repo harshanandak/forge --workflow release.yml --commit "$RELEASE_SHA" --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RELEASE_RUN" --repo harshanandak/forge --web
```

The first approval publishes the verified candidate archive to `next`. Withhold the second approval until full public-registry two-machine proof is accepted, then review that same run in the browser for promotion to `beta` (prerelease, the owner's default) or `latest` (stable). The owner sets the final version at release time. Preserve every existing integrity, provenance, signature, cold-install and environment gate. Agents never dispatch/approve release, run npm publish or change dist-tags. A published version is immutable; retain failure evidence and diagnose at the failed gate.

## Routes

Every route is `/p/<projectId>/<route>` and needs `Authorization: Bearer <token>`, except `loginstart` and `loginpoll`.

The HTTP adapter's typed `stateRead` and `stateCommit` share the existing HTTPS exchange.
It sends once with the bearer in Authorization, refuses redirects, and never retries a lost reply.
Headers/body share a deadline and caller cancellation; state responses have a hard 1 MiB ceiling
plus JSON depth/node budgets. Invalid UTF-8, token echoes and unknown statuses/refusals are UNAVAILABLE.
The decoder checks project, namespace, policy, protocol/read versions and every record/event wrapper.
Reads must match the query kind, keys, range bounds and cursor; commits match the request ID,
ordered entries, values and writing actor. Refusals retain only a code and checked fence conflict.
These transport facts do not infer eligibility or acceptance after an unusable reply, update a
local overlay, or access credentials. Credentialed record-client assembly is separate work.

`POST /p/<projectId>/state/read` and `/state/commit` admit only device tokens on `FORGE_CLOUD_PROJECT`, with a closed invocation `context` and matching route/kind. `FORGE_STATE_NAMESPACES` is an explicit array of exact namespace IDs (initially `["forge/memory"]`); missing/malformed config returns UNAVAILABLE, and `[]` grants nothing. Config cannot grant `forge/work`, `forge/cloud` or any `forge/core-*` namespace. `policyRevision` is the digest of the sorted, deduplicated config; `discover` is accepted only on an unpinned read. Reads return bounded get/range/count/max/history results with the config revision and a namespace event watermark plus private restore epoch. Pages pin both revisions; stale pins return REVISION_CONFLICT. Responses are capped at 1 MiB with stored byte sizes checked before loading bodies. Missing epochs return UNAVAILABLE with an admin device-token provisioning remedy; reads initialize nothing. Admin provisioning initializes the private epoch, and completed restore replaces it before visibility. Ascending range cursors use last key + NUL (up to 501 characters), descending cursors use the exclusive last key, and history next is the last returned event sequence, and before resumes exclusively below that sequence (event revisions may repeat). Commits apply one CAS batch and its namespace-scoped receipt in the same transaction. They fingerprint the full request and return authoritative records/version with result null; exact retries return the stored answer, while changed input conflicts. Token/config admission repeats before replay and inside the write transaction; fenced retries also require the current lease grant. Commit responses are capped at 1 MiB before acceptance. Reads create no receipts. Cloud count/max examine at most `MAX_AGGREGATE_KEYS + 1` (1001) matching keys through an indexed, key-only LIMIT subquery. More than 1000 matching keys returns `INPUT_INVALID` (HTTP 400, exit 6, retry never), asking the caller to narrow the prefix; under-budget results remain exact. Local aggregate callers retain their existing behavior unless they supply the optional budget.

### Namespace watermark preparation (forge-1423)

This preparation release adds `005_state_events_namespace_index` and the covering
`(namespace, sequence)` index. Admitted writes, provisioning, restore and import targets
run the complete historical initializer. Reads never initialize or repair a store.
Upgraded reads require the named index and read its reverse sequence endpoint; an older
store retains the exact legacy MAX query. That temporary bridge still examines history
and is not completion of the bounded-watermark fix or eligibility for strict cutover.

The lead runs this rollout after deploying the preparation release:

1. Establish a complete inventory of every Project name this Worker can address,
   including legacy admin/lease names beyond `FORGE_CLOUD_PROJECT`. Before deployment,
   obtain names from the operator's provisioning/deployment records and reconcile them
   with restore/import manifests and administrative creation records. This PR performs
   no live calls and establishes no complete enumeration mechanism. If those records
   cannot prove completeness, stop: a list of configured projects alone is insufficient.
2. Account for concurrent provisioning and unfinished paged restores; capture new names
   until the inventory is stable. Do not treat a staging restore as provisioned.
3. For every provisioned entry, use an admin bearer with `GET /p/<name>/upgrade` to read
   `{ready,index,pending}` without migration. POST the same route with exactly `{}`
   (JSON, at most 64 bytes, no query parameters) to apply all pending migrations.
   POST returns the same readiness plus `outcome: "upgraded"` or `"already ready"`.
   Missing/wrong admin is 401, invalid method/body/query is 400, and cold/incompatible
   targets are 409; no refusal provisions or migrates the target.
4. Independently GET readiness again for **every** inventory entry and require
   `ready: true`, `index: true`, `pending: []`. Retain names/readiness only, never auth
   or state contents. Measure index construction on the largest supported store before
   choosing rollout timeouts: it visits existing events and can block that object's work.
5. On incomplete inventory, any failed upgrade or failed read-back, stop cutover and
   retain this preparation release. Strict missing-index refusal belongs to a later
   release, after the operator has verified the complete stable inventory.

Once a store records migration 005, the rollback target is **this preparation release**,
not older main: older code rejects the unknown ledger entry. Keep the additive index and
ledger with compatible code; a schema downgrade requires a separate authorized plan.

| Route                                        | Method    | Token  | What it does                                                                                                                                                                                                                            |
| -------------------------------------------- | --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claim`, `renew`, `release`                  | POST      | device | Change a lease. Each carries a `requestId`; a retry returns the right result. A session-bound token can act only as its own session: a body naming another is `AUTH_DEVICE_MISMATCH` (403) and records nothing.                         |
| `command`                                    | POST      | device | Typed issue commands for `FORGE_CLOUD_PROJECT`; body up to 512 KiB. See below. OAuth and admin tokens get 403.                                                                                                                          |
| `holder?subject=...`                         | GET       | device | Read a lease.                                                                                                                                                                                                                           |
| `loginstart`, `loginpoll`                    | POST      | none   | Device login for the one project named by `FORGE_CLOUD_PROJECT`. See below.                                                                                                                                                             |
| `/device`, `/device/approve`, `/device/deny` | GET, POST | none   | Not under `/p/`. The owner's browser approval of a device login. See below.                                                                                                                                                             |
| `devices`                                    | POST      | admin  | Issue a device token: `{ device, session?, agent?, harness?, ttlMs }`. The token is shown once.                                                                                                                                         |
| `revoke`                                     | POST      | admin  | Revoke a device token by id. It is refused on its next request.                                                                                                                                                                         |
| `status`                                     | GET       | admin  | Initialization, dump usage, effective caps and capacity warnings.                                                                                                                                                                       |
| `dump`                                       | GET       | admin  | The project as JSON: issues, leases, events and receipts. No tokens, no hashes. `?cursor=start` dumps in pages (see below).                                                                                                             |
| `restore`                                    | POST      | admin  | Write a dump into an empty project. Body up to 8 MiB (`RESTORE_TOO_LARGE` over it). A row that is not valid state, including a JSON body that repeats a label at any depth, is refused as `RESTORE_INVALID_ROW` and nothing is written. |

The device routes `claim`, `renew`, `release` and `holder` check the token before they open the project's database, through a read-only view of the token table. A refused token sets up and migrates nothing. `holder` reads the stored lease through a read-only view too, so it never initializes storage. A command write refuses a request id that carries a credential, and checks the token once more, before it opens the database.

Request IDs belong to the authenticated token in this project, separately for typed commands and raw lease routes. Public pinning through catalog calls, host options, CLI, MCP, SDK and raw clients remains available. Same-token retries keep their recorded result or refusal and all existing lease fences; changed input or another operation within that route family is still INPUT_CONFLICT (409, exit 4).

A replacement token, even on the same device and session after login, starts a new operation. It cannot replay the old token's receipt and may create another item when normal checks allow it. Reconcile before changing credentials or retrying after restore. Dumps retain receipt and history bytes for audit but exclude tokens, so issuing a token after restore does not transfer receipt ownership.

Ambiguous pre-change IDs are UNAVAILABLE (503, exit 1, retry never) before work, including old IDs that resemble internal scoped IDs and old acquisition receipts without an outer receipt. Reconcile and use a new raw ID. Version metadata distinguishes these from current receipts. The typed receipt cap is 3,000 unexpired server receipts; frozen legacy records do not count. The private OAuth owner-forward path uses its authenticated owner as a separate principal domain; tokens for that same owner retain that domain.

A command is `{ requestId, op, input, context, dryRun? }` and nothing else, at most 32 levels and 5,000 values. `context` is closed too: the device comes from the token and the project from the server, so a different device or project, a project root, and a namespace, clock or variant are refused. Only sixteen `issue.*` operations are known (others are `UNKNOWN_COMMAND`, 404); `issue.show`, `issue.comments`, `issue.links`, `issue.list`, `issue.ready`, `issue.blocked` and `issue.stale` run as reads, `issue.create`, `issue.comment`, `issue.update`, `issue.dep`, `issue.link`, `issue.close`, `issue.claim`, `issue.renew` and `issue.release` run as writes. `dryRun` is `UNAVAILABLE` (503) and writes nothing.

`issue.comment` takes `{ id, body }` (body 1 to 65,536 characters) and returns `{ id, commentId }` as the local command does. The id may use the current prefix or a historical one, in any case; the authority numbers the comment inside the write from the issue's comment floor (`allocation:comment:<id>:`), the highest number ever given, so a number never falls after a delete and the caller never names it. Each add commits its comment and its event, the floor advance (one extra event) and its receipt in one transaction. The write needs no lease. A missing issue is `NOT_FOUND` (404, exit 3), bad input or an unknown id prefix is `INPUT_INVALID` (400, exit 6). Like `issue.create`, a command is recorded once per `requestId` with its comment, event and receipt in one transaction: the same `requestId` and input returns the original `commentId` with no second comment, other input under that `requestId` is `INPUT_CONFLICT` (409, exit 4), a `requestId` that looks like a device token is `INPUT_INVALID`, and past 3,000 unexpired typed receipts a fresh write is `UNAVAILABLE` (503). A refusal for a fresh `requestId` is recorded and replays unchanged.

`issue.update` edits `title`, `body` and `labels` of an existing issue and returns the issue as the local command does. It needs `expectRevision` (a positive integer) and the caller's held lease: the context names the session and `leaseGeneration`, and the device comes from the token. The write is accepted only if, at server time inside the transaction, the issue's live cloud lease is held by that device and session at that exact generation. Otherwise it is `LEASE_NOT_HELD` (no lease, released, or another holder), `LEASE_STALE` (another generation) or `LEASE_EXPIRED`, all 409 with exit 4, the same codes the local command gives. A stale `expectRevision` is `REVISION_CONFLICT` (409, exit 4). Supplying `kind`, `parent` or `dependsOn` is `INPUT_INVALID` ("not supported in cloud yet"): an imported issue keeps its kind, parent and dependencies, and dependencies change only through `issue.dep`. A missing issue is `NOT_FOUND`. Receipts work as for create, with one difference: a replay of the same `requestId` and input returns the original result only while the caller still holds the lease; after a release, expiry or takeover it is `LEASE_STALE` and the old result is never returned. Refusals from the lease or revision check roll back with the write and are not recorded, so a retry runs again.

`issue.dep` takes `{ id, target, action, expectRevision }` (`action` is `add` or `remove`) and returns the issue as the local command does. It needs the caller's held lease and `expectRevision`, with the same fence, codes and exit codes as `issue.update`. The checks run in the local order: an absent issue is `NOT_FOUND` ("Issue <id as written> was not found"), even when the target is malformed; the new list is capped at 256 dependencies (`INPUT_INVALID`, "At most 256 dependencies are allowed"); then the resulting graph is walked, and a missing issue is `NOT_FOUND` ("Issue <shown id> was not found") and a cycle, a self dependency included, is `INPUT_CONFLICT` ("Dependencies must not contain a cycle"). A removal validates the resulting graph too, so it can repair a dangling dependency, but is refused while another dependency is still missing. An absent issue is recorded as a refusal with the input; the cap, graph, fence and revision refusals roll back with the write and are not recorded, so a retry runs again. A replay of the same `requestId` and input returns the original item only while the caller still holds the lease, else `LEASE_STALE`; other input under the same id is `INPUT_CONFLICT`. Cloud-only limit: the graph walk reads at most 10,000 issues per request and a longer reach is `UNAVAILABLE` (503) with nothing written; the local command has no such limit. The walk is iterative, so a long chain cannot overflow the stack.

`issue.link` takes exactly `{ id, relation, url }` (`relation` matches `^[a-z][a-z0-9-]{0,49}$` and is open, not an enum; `url` is 1 to 2,000 characters) and returns the whole stored record (`namespace`, `key`, `revision`, `value`, `updatedAt`, `updatedBy`), as the local command does. The key is `link:work-<digits>:<n>`, with the stored id even for a prefix alias, and `revision` is 1. The checks run in the local order: the input schema (`INPUT_INVALID`, 400), the id (a malformed id or unknown prefix keeps the cloud's fixed messages), an absent issue (`NOT_FOUND`, "Issue <id as written> was not found"), then the URL, which must match the local pattern exactly (`http` or `https` in lower case, a host, no whitespace; nothing is trimmed, parsed, fetched or restricted to a host, and a link is evidence attached to the issue, never verified), else `INPUT_INVALID` ("Links require an http or https URL"). These four are recorded as refusals. The link is numbered inside the write from the issue's link floor (`allocation:link:<id>:`), the highest number ever given, never from a count, so a number never falls after a delete and sparse live links 1 and 3 give the next link suffix 4 at revision 1. It is written once and nothing is overwritten. Duplicate relations and URLs are appended again. The write needs the caller's held lease on the issue, with the same fence and codes as `issue.update`; a lease on the link key alone does not count. The issue row, its revision, status, dependencies, eligibility and lease do not change, and a closed, competing or collaborative issue with a held lease is linkable, as locally. The link and its event, the floor advance (one extra event) and the receipt commit together; the lease, revision and readback refusals (`INTERNAL`, "Accepted write did not match its readback; reconcile before retrying") roll back and are not recorded. A replay of the same `requestId` and input returns the original record, whatever links were added since, only while the caller still holds the lease at the original generation, else `LEASE_STALE`; other input, session, generation or device under the same id is `INPUT_CONFLICT`. `issue.link` is not idempotent. The CLI routes it for a cloud-bound project (see below).

`issue.close` on cloud takes `{ id, pr, reason? }` to verify a merged PR, or `{ id, withoutReceipt, reason? }` for an explicit exemption, and returns the closed issue with the stored reason hidden. Both need the caller's held lease and generation, which remains held after close. A local `receipt` ID is still refused by name as `INPUT_INVALID`. Verification uses the newest `delivers` link, the admitted repository and server-owned policy, and GitHub App observations. Its synchronous commit rechecks authentication, the lease, delivery revision and policy; it stores bounded evidence as `forge/work/evidence:<stored-issue-id>` with the close and one command receipt. Whole and paged dumps include that ordinary state record. A new verified close of an already closed issue is `INPUT_CONFLICT`; an exact retry returns its recorded close while the lease remains held. Invalid input is recorded as a refusal, so changing `pr: 0` to a valid PR under the same request ID gives `INPUT_CONFLICT`. GitHub and other transient verification refusals remain unrecorded. The exemption path keeps its existing competition, missing-proof and closed-issue behavior. CLI `forge issue close <id> --pr <number>` and MCP `issue.close {id, pr}` use this same cloud path. `pr` cannot be combined with `receipt` or `withoutReceipt`: mixed inputs are `INPUT_INVALID` (exit 6) before any request, including the hidden lease read. On an unbound project, `pr` is `INPUT_INVALID` before local state opens because there is no local GitHub verifier. `receipt.admit` and `receipt.show` are removed from the catalog and remain `UNKNOWN_COMMAND` on cloud. `issue.show` exposes the stored receipt ID; a full evidence summary is not projected yet.

`issue.claim` takes `{ id, ttlSeconds? }` and returns `{ id, generation, expiresAt }` as the local command does. It is the plain exclusive claim only: `reopen` and `reason` are refused as `INPUT_INVALID` ("not supported in cloud yet"), as are competing and collaborative issues. The context names the session and the device comes from the token; a session-bound token cannot name another session. Inside one transaction, in the local order, the server refuses a live cleanup reservation (`INPUT_CONFLICT`), a missing issue (`NOT_FOUND`), a closed one (`INPUT_CONFLICT`, "Closed issues cannot be claimed"), a live lease held by anyone, the same holder included (`LEASE_HELD`, with the full holder and expiry), and open or missing dependencies (`CLAIM_BLOCKED`, 409, exit 1, with the blockers). Then it takes the lease with the same engine as the raw `claim` route, and records the receipt. The ttl is `ttlSeconds` or 3,600 (the cloud has no `claimTtlSeconds` setting). A ttl over 24 hours, or one that would outlast the token, is `INPUT_INVALID` and is never clamped. A replay of the same `requestId` and input returns the original grant only while it is still the current lease; after a release, expiry or takeover it is `LEASE_STALE` and the old grant is never returned. Refusals from the checks above are not recorded, so a retry runs again. The raw lease routes are unchanged: they take any subject and check no issue.

`issue.renew` takes `{ id, ttlSeconds? }` and returns `{ id, generation, expiresAt }`; `issue.release` takes `{ id }` and returns `{ id }`, both as the local commands do. They are served as typed commands on this route, and the server resolves the id to its issue: the caller never sends a subject, unlike the raw `renew` and `release` routes, which are unchanged. The context names the session and its lease generation, and the device comes from the token; a session-bound token cannot name another session. Inside one transaction, in the local order, the server refuses a missing issue (`NOT_FOUND`, "Issue <id as written> was not found"), then checks the lease with the same engine as the raw routes: `LEASE_NOT_HELD`, `LEASE_STALE` or `LEASE_EXPIRED` unless the caller holds that exact generation as that session on the token's device. A renew's ttl is `ttlSeconds` or 3,600, checked after the issue and before the lease, as the raw `renew` route does (the local handler has no cap): over 24 hours, or past the token's expiry, is `INPUT_INVALID` and is never clamped. Refusals from these checks are not recorded, so a retry runs again. Replays: a release that committed answers a retry of the same `requestId` and input with its original `{ id }`, even though the lease is gone, and never `LEASE_NOT_HELD`; a renew answers a retry with the recorded grant only while that exact grant (holder, generation and expiry as renewed) is still the live lease, and otherwise `LEASE_STALE`. The same `requestId` with other input, session or device is `INPUT_CONFLICT` and never replaces the receipt. The CLI routing of renew and release follows in its own change.

`issue.show` takes `{ id }` and returns the issue as the local command shows it, with its current `revision` and a `lease` only while one is live. It needs the Worker var `FORGE_CLOUD_ID_PREFIX`, the issue id prefix (lowercase letters, digits and hyphens, at most 32 characters); a missing or invalid value is `UNAVAILABLE` (503) and no work table is read. Status codes: a missing issue is `NOT_FOUND` (404, exit 3), bad input or an unknown id prefix is `INPUT_INVALID` (400, exit 6), a stored issue that fails its schema is `INTERNAL` (500, exit 1). The response is at most 1,048,576 bytes of UTF-8 for the whole envelope; a larger one is `UNAVAILABLE` (503), "response too large".

`issue.comments` takes `{ id }` and nothing else (`limit`, `cursor`, `offset` and extra keys are `INPUT_INVALID`, 400, exit 6) and returns `{ records }` as the local command does: every comment as its full stored record (`namespace`, `key`, `revision`, `value`, `updatedAt`, `updatedBy`), with the stored `work-` ids kept, in append order. The order is the number each key ends with, never the text order of the keys or the clocks. The id may use the current or a historical prefix, in any case. A missing issue is `NOT_FOUND` (404, exit 3), "Issue <id as written> was not found"; an issue with no comments returns `{ records: [] }`. The read needs no lease, claim or show, writes nothing, and is not recorded. There is no pagination, but the cloud bounds it before any comment body loads: more than 10,000 comments or more than 1 MiB (the response cap) of stored comment JSON for that issue is `UNAVAILABLE` (503), "Issue comments are over their read budget", because a reply over the cap is refused anyway. The 1 MiB response cap still applies to the whole envelope, so a response over it is refused, never shortened. Every stored comment is checked whole, so a corrupt or oversized one is `INTERNAL` (500) and never part of a partial answer. A dry run is `UNAVAILABLE`, as for every command.

`issue.links` takes `{ id }` and nothing else (`limit`, `cursor`, `offset` and extra keys are `INPUT_INVALID`, 400, exit 6) and returns `{ records }` as the local command does: every link as its full stored record (`namespace`, `key`, `revision`, `value`, `updatedAt`, `updatedBy`), with the stored `work-` ids kept, in link-number order. The order is the number each key ends with, so `link:work-1:10` comes after `link:work-1:9`, never the text order of the keys or the clocks. Only keys `link:<stored id>:<n>` in the work namespace for that issue count: another issue's links, comments and keys in another namespace are not returned. The id rules, the `NOT_FOUND` text, the `{ records: [] }` answer for an issue with no links, the budget (more than 10,000 links or 1 MiB of stored link JSON is `UNAVAILABLE`, 503, "Issue links are over their read budget"), the 1 MiB response cap and the `INTERNAL` (500) for a corrupt or oversized stored link are those of `issue.comments`. The read needs no lease, writes nothing, and is not recorded.

`issue.list` takes `{ parent?, kind?, label?, labels?, status?, createdSince?, ready?, limit? }` (limit 1 to 1,000, default 1,000) and returns `{ items, truncated }` as the local command does: the matching issues, open and closed, in key order (`work-10` before `work-2`), at most `limit` of them, with `truncated` true when more matched. Filters work as in the local command: `parent` takes a current or historical prefix alias or `none`, `label` and `labels` combine with AND, and `createdSince` includes its own time. `ready: true` keeps open issues whose direct dependencies are all closed (a missing one blocks) and that no live lease holds; it does not apply `labelOrder`. It uses the same prefix setting, checks, status codes and 1 MiB cap as `issue.show`; a response over the cap is refused, never shortened. Reads are bounded before any issue body loads. The cloud first reads compact rows (every stored field except a text body of up to 65,536 characters, which is read as empty), checks every one, then filters, orders and picks the page from them, and loads full records only for the returned page. A project with more than 10,000 issues is `UNAVAILABLE` (503), "Issue list is over its read budget", whatever `limit` is. One 8 MiB payload covers the compact rows plus the full records of the page, counted as the bytes the storage statements return (keys and sizes included): over it is the same `UNAVAILABLE`, never a shorter page. Bodies outside the page do not count, so a large project can be listed a small page at a time, though a project whose compact rows alone pass 8 MiB is still refused. SQLite still reads each stored row to build the compact rows, twice per list, so a large project costs CPU and storage reads even for a one-issue page. Parity with the local command holds within these limits. Every stored issue is checked before any filter or limit, so a corrupt issue is `INTERNAL` (500) whatever the filter; a lease is read only for the issues that are still candidates.

`issue.ready` takes the same input as `issue.list` and returns the same `{ items, truncated }`, as the local command does: it is always ready-filtered (even with `ready:false` or no `ready`), a `status: "closed"` filter returns no items, and the ready issues are sorted by `labelOrder` (stable, before `limit`). It runs through the same code, checks, budgets, status codes and 1 MiB cap as `issue.list`. The cloud has no `labelOrder` setting yet (forge-1250), so cloud `issue.ready` uses an empty `labelOrder` today and returns ready issues in key order.

`issue.blocked` and `issue.stale` take the same input as `issue.list` and return the same `{ items, truncated }`, as the local commands do, through the same code, checks, budgets, status codes and 1 MiB cap. Both keep only open issues, so a `status: "closed"` filter returns no items, and both ignore `ready`. `issue.blocked` keeps open issues with a direct dependency that is missing or not closed, whether or not a lease holds them. `issue.stale` keeps open issues whose lease was never released and expired at or before the read time. Both return key order, never ranked by `labelOrder`, and take every `issue.list` filter and `limit`. A lease is read only for the issues that are still candidates or are returned.

A project bound to the cloud serves `issue.show`, `issue.comments`, `issue.links`, `issue.list`, `issue.ready`, `issue.blocked`, `issue.stale`, `issue.create`, `issue.comment`, `issue.update`, `issue.dep`, `issue.link`, `issue.close`, `issue.claim`, `issue.renew` and `issue.release` from the cloud, validates each result against the operation's declared output, and opens no local project state for them. A write goes only to the cloud, and a dry run of one is `UNAVAILABLE` before any request, including the lease read. The request id is sent unchanged, so the cloud can replay a retried write. `issue.update`, `issue.dep`, `issue.link` and `issue.close` need a held cloud lease: the CLI reads the live lease generation from the cloud show, never makes one up or refreshes one, and a stale generation you pass is refused by the cloud (`LEASE_STALE`, exit 4). `issue.claim` goes through the command route; `reopen` or `reason` is `INPUT_INVALID` ("not supported in cloud yet") before any request. `issue.renew` and `issue.release` are typed commands on the same route: the CLI sends no subject, the server resolves the issue and checks the lease the caller holds, and the CLI reads the live generation from the cloud show as for update (a stale one you pass is `LEASE_STALE`, exit 4). The CLI routes `issue.close` with `pr` for verified close or `withoutReceipt` for an exemption: a `receipt` input is `INPUT_INVALID` ("issue.close with a receipt is not supported in cloud yet.", exit 6) before any request, including the hidden show, and a missing `withoutReceipt` is the cloud's `RECEIPT_REQUIRED` (exit 1). CLI and MCP forward `{ id, pr, reason? }` to the same cloud verifier and return its result without writing a local receipt. Local receipt close on an unbound project keeps its existing behavior. `issue.link` takes the same held lease and returns the cloud's whole stored record; a dry run of it is refused before any request, including the lease read. Every other work operation is refused for a bound project by name (`INPUT_INVALID`, exit 6) before any request, including the hidden show a held operation would otherwise send, and also as a dry run: lanes (forge-1248) are not served yet. Cloud `issue.ready` uses an empty `labelOrder` today (forge-1250).

`forge store reinit` is refused on a bound project (`INPUT_INVALID`, exit 6, "store.reinit is not served by the cloud authority of a cloud-bound project yet."), with or without `--dry-run`, whether or not a local store exists. The refusal comes before any local state opens, any approval is asked or any request is sent, so it needs no login and creates no local store. A malformed or mismatched binding keeps its own refusal. Recovery on an unbound project is unchanged. Only a human can invoke it; MCP still does not expose it.

Forge also refuses local project-state writes without a cloud implementation (`UNAVAILABLE`, exit 1), including check receipts, decisions, project memory and custom blocks. The sixteen issue routes above remain available. Device-only notes use `memory.add` with `level=device`; block authors declare `context=device` and use core device state. Selecting project state from a device operation still refuses. Generic project-state sync is deferred to forge-1345.

Local reads remain historical local data, without a claim of cloud freshness. If device registration proves that a bound project's local store is missing, restore a backup to inspect those records or use cloud-served issue commands for shared issue state. `store reinit` remains disabled; removing the binding does not sync or recover records. Unbound projects retain their existing local behavior.

A refused cloud command keeps only checked details, never the server's words. `LEASE_HELD` keeps the full lease (holder, generation, expiry) and prints the local engine's message; the other three lease codes keep a subject alone or the same full tuple. `CLAIM_BLOCKED` on `issue.claim` keeps its blocker edges in server order, each `{ id }` or `{ id, holder, holderUnverified: true }`, with no open or missing state, and no `--reason` repair, because the cloud claim refuses `reason`. A competing `issue.close` keeps its one repair, rebuilt locally; other repairs are dropped. A lease subject must be `issue:work-<digits>` for the requested id's digits. A missing, partial or extra-key detail, a bad generation, a token or control character in a kept string, or a body over 1 MiB is `UNAVAILABLE` with fixed text and no partial detail.

A whole dump (`GET dump`) is one response for a small project: up to 3 MiB stored, 10,000 rows per table and 262,144 characters per value, except `state_records.body`, `state_events.body` and `state_requests.fingerprint` and `result`, which take up to 8,388,608 characters because a stored issue, its event and its receipt each hold a 65,536 character body whose characters can each escape to six (a legal maximum is about 393,000 stored). A larger project is refused as `DUMP_TOO_LARGE` (413), and so is a whole dump over the 8 MiB restore body once escaped (a control character is one stored byte and six sent); a project with more than 10,000 rows in a table cannot be dumped whole (use the paged dump below).

Whole and paged dumps carry `domain_cloud_requests.created_at` as a nonnegative safe integer and restore it exactly, including zero. Restore admits ages at most 60 seconds ahead of its clock, inclusive, to allow small clock skew; later ages are refused rather than clamped. Shipped version 1 and earlier version 2 backups omit this field. Their missing age becomes the fixed epoch value `0`, meaning unknown historical age; it is never replaced with restore time. Raw witnesses currently have no age deadline. If age-based expiry is added later, an unknown age must use a restore-time retention floor, never zero as its expiry anchor. Present invalid ages are refused, and all other row fields remain strict. The request-age dump migration refreshes installed byte counters and triggers to count the newly transported field.

## Device login

Dumps now use `forge-cloud-dump/2` or `forge-cloud-dump-page/2`. Both include the non-evented `domain_cloud_command_receipts` table (request id, fingerprint, outcome, result, creation time and replay deadline); its result has the wide JSON limit. Version 1 remains readable and supplies an empty command-receipt table. Older readers reject version 2. Size checks, strict row validation, staging cleanup and readback include the new table. Every insert, update or delete in a dumped table advances a transactional export counter, so a receipt-only change also makes a continuation `DUMP_CHANGED`. A restore starts a fresh export epoch; tokens and export metadata stay private to the server. A recorded outcome replays for matching principal, transport family, request id and input while `created_at <= now < min(credential expiry, created_at + 24h)`. Retries do not extend this deadline; nothing is guaranteed after it, and a still-valid credential can execute the same request id again. New typed receipts store this minimum as their expiry; existing non-imported rows use the same effective deadline without a schema migration. Restored receipts retain their audit bytes but are marked imported in private server metadata; they never count toward live admission or provide replay or ownership proof. Imported audit rows are retained until their original expiry, or reclaimed within the same eight-row pruning bound when stored receipt capacity needs space. A refusal at the live cap returns before pruning and changes no row or export marker. Each fresh authenticated write prunes at most eight expired server receipts, earliest effective deadline first, in the same transaction. Reusing an expired id still behind that batch replaces its expired live row in the write transaction. Fresh receipts are never evicted to admit another client. At 3,000 receipts before their effective deadline a fresh write is UNAVAILABLE (503, retry safe), with a message that the limit clears as receipts expire; check-time refusals beyond the cap remain unrecorded. A retry with an expired token is AUTH_EXPIRED before receipt lookup, never a fresh replay under that token. Legacy forge/cloud request records and events remain frozen; replay checks server receipts first and falls back to those records, and both raw and scoped spellings retain legacy ownership checks. Raw owner receipts and inner state_requests are unchanged. Event-log growth remains separate work, so removing the lifetime receipt stop does not promise indefinite writes.

`POST loginstart { device }` returns `{ ok, device_code, user_code, expires_in: 600, interval: 5, verification_uri: "/device", project, device }`. `POST loginpoll { device_code }` returns `{ ok: false, error }` (`authorization_pending`, `slow_down` with a longer `interval`, `expired_token`, `access_denied`, `invalid_grant`) until an approved challenge yields `{ ok: true, credential }`, once. The credential is a JSON string `{ format: "forge/device-credential/1", id, token, device, expiresAt }` for a 30 day device token (`LOGIN_TTL_MS`). Responses are `no-store`.

Neither route needs a bearer. They serve only the project named by `FORGE_CLOUD_PROJECT`, which must already be provisioned, and need the secret `DEVICE_LOGIN_HMAC_KEY` (random, base64url, at least 32 bytes) plus the owner vars `CLERK_ISSUER`, `FORGE_OWNER_SUBJECT` and `CLERK_CLIENT_ID`. A missing setting returns `AUTH_CONFIG_UNAVAILABLE` (503) on these two routes only. Starts are limited to 5 per address and 30 per project in a 60 second window (`rate_limited`, 429), and to 1,024 live challenges (`capacity_exceeded`, 429). Challenge state is one private `domain_cloud_login` row and is never in a dump. A poll that consumed its challenge and then failed to issue needs a fresh login.

### Owner approval in the browser

The owner opens `GET /device` (no bearer; the page sets a host-only `__Host-forge_device` cookie, kept if the browser already has a well formed one, so a second tab does not break the first). The cookie is also the form's CSRF proof. `POST /device` types the user code and previews the project and device; the page carries two single-use tickets, one for Approve and one for Deny, bound to this browser, this challenge and that action. `POST /device/approve` or `POST /device/deny` needs a same-origin `Origin` header, the cookie and the matching ticket. It saves a one-use state (`forge-device.` plus 43 random characters, kept only as a hash), a PKCE verifier and the user code in the private `domain_cloud_login` row for 10 minutes, sets a fresh `__Host-` cookie for that one state (kept only as a hash), and answers 302 to Clerk. A page cookie alone, stolen or planted, cannot finish the redirect. A browser holds one record per challenge (a new preview or decision replaces it), a challenge holds at most 3 records, and the project at most 256. Clerk returns to the existing `GET /callback`: a state starting `forge-device.` goes to the project object, never to the OAuth callback; every other state keeps its current path. No new Clerk redirect URI is needed. The callback first checks, in one step, that exactly one device state was sent, that it has a live record and that the request carries that state's own cookie, and only then uses the state up; a refusal at that step leaves the login state as it was, so a wrong browser cannot burn a valid state, though the attempt counters below may advance for an admitted wrong attempt. Once a valid state is used up it stays used up: a later failure (the Clerk code, the ID token, the owner or the engine) does not give it back. It then claims the Clerk code once, verifies the ID token, requires the exact owner (`CLERK_ISSUER` plus `FORGE_OWNER_SUBJECT`) and then approves or denies. It shows `approved` or `denied` and never a token; only the polling device receives one.

The preview forms carry a hidden `challenge` field, the keyed hash of the user code, bound to the stored record. It is a budget key and never authority: a correct ticket with another value is refused. `POST /device/approve`, `POST /device/deny` and the device callback each count one attempt unless the request carries a complete bound proof: at most 5 per challenge (known from the field or from the stored state), 5 per `CF-Connecting-IP` address and 30 per project in a fixed 60 second window. A complete bound proof is a live ticket for that action with this browser's cookie, the matching challenge field, the same origin and a matching CSRF proof, or a live state with its own cookie. It is checked locally, used up once, and neither checks nor spends any of the three counters, so a full counter cannot block an owner who already holds one. Anything incomplete is a guess and counts as before. The proof only starts Clerk authentication or reaches the Clerk and owner checks; it is possession of a narrow capability, not owner identity, and the engine's five failed decisions per owner stay. The counters sit in the private table `domain_cloud_browser_attempts`, outside dumps; a refused or over-limit request writes no login row and moves no window. A missing or empty address is `AUTH_FORBIDDEN` (403) on these routes, even with a complete proof. That header is an ingress-dependent quota signal, never proof of a person: same-zone Workers can change it and cross-zone ones share a fixed address, so they must be trusted or blocked at ingress ([Cloudflare header reference](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip)); this was not checked against any deployed ingress. Still open: the start and failed-preview project budgets above can block a new login or a first valid preview, rotating addresses and distributed traffic are not bounded, and a valid ticket can repeatedly reach Clerk by renewing previews. This is not total denial-of-service protection.

Refusals: 400 `invalid_request` (CSRF, origin, or a missing, used or wrong ticket or challenge field), 400 `invalid_code` (one answer for unknown, consumed, expired and malformed codes), 429 `rate_limited` (the attempt limits above, five failed lookups per address and 30 per project in 60 seconds, counted in one step with the lookup so overlapping requests share the budget, or the engine's five failed decisions per owner), 400 `access_denied` (state unknown, duplicated, expired, replayed, or wrong or missing browser cookie), 401 `AUTH_INVALID` (Clerk proof refused), 403 `AUTH_FORBIDDEN` (a different Clerk user). The Worker also needs `CLERK_REDIRECT_URI`, `FORGE_API_RESOURCE`, `OAUTH_TIMEOUT_MS` and the `CODE_REDEMPTION` binding for these pages; a missing one is `AUTH_CONFIG_UNAVAILABLE` (503).

## Log in from the CLI

`forge auth login --origin <https-origin> --project <project>` runs the device flow for one machine. The operation is declared by the `forge/cloud` block, so enable it first (`blocks: { cloud: { source: { builtin: forge/cloud } } }` in `.forge/config.yaml`). It is for a person at a terminal and is not an MCP tool. The first login needs both flags; later logins use the binding in `.forge/cloud.json`, and login never changes an established binding (`INPUT_CONFLICT`, exit 4, before any request). The checkout needs `.forge/project.json`; login never creates it (`CONTEXT_MISSING`, exit 6).

Login prints `<origin>/device?code=XXXX-XXXX` and the code separately, then opens the default browser when available. Set `FORGE_NO_BROWSER=1` to disable opening. A headless host or failed opener keeps polling and leaves the printed link available. GET pre-fills and shows one well-formed code; click Continue to submit it. The approval page shows that code again. Before Approve, check the required box to confirm that you started this login yourself and the code matches your terminal; an approval POST without that confirmation is refused. Deny needs no confirmation. The short-lived, single-use code needs the owner's Clerk sign-in to approve; the page keeps `Referrer-Policy: same-origin`. The stable catalog/result operation ID stays `cloud.login`; its CLI command is `forge auth login`.

The command prints the code-bearing verification link and a separate code on stderr, then polls no faster than the server's interval until the owner approves, denies or the code expires. Stdout carries one final result: origin, project, device, token id and expiry. The token and the device code are never printed. Ctrl-C cancels the wait. No wait runs past the code's own lifetime: a long `slow_down` interval is cut to the time left, a poll that crosses the deadline is refused as expired, and a code that expires ends the login as `LOGIN_EXPIRED`. A poll that fails in transit ends the login and is not retried, because it may have used the one-time code; run login again.

The credential is saved in `~/.forge/cloud/credentials.json`, a private file under the same lock and atomic replace as account files. It is checked for the current owner, private modes, a plain file with one link and, on Windows, an owner-only ACL and the current user (or the Administrators group) as owner, both before it is read or replaced and again after it is written. Any failure, including a filesystem error such as a file with no read permission, is `ACCOUNT_INTEGRITY`. A token is found only under its exact origin, project id and project name. Login keeps the previous entry until the new one reads back. If the write or the read back fails, even after the file was already replaced, it puts the previous bytes back through the same checked write. A destination that is unsafe is never overwritten: the previous document is then kept in `credentials.backup.json` beside it and the login fails with `ACCOUNT_INTEGRITY`. The binding is written last, only after the credential reads back.

`.forge/cloud.json` holds only the schema, the project id, the origin and the project name, no secret, so it is committed and travels with the project; login stays the only thing that writes it. The assembly check `cloudBinding` reads it from the project's manifest root, so nested folders and linked worktrees give the same answer. A binding that is malformed, unsafe or for another project id is refused, and so is a missing project identity. With no binding, a saved credential for this project id (live or expired) is `INPUT_CONFLICT`, exit 4: run `forge auth login` again. The check never writes a binding or a credential and creates no folder.

Start and poll send no bearer token, follow no redirect and have a deadline and a body limit. A device id longer than 128 characters, or one the Worker would refuse, is sent as `device-` plus the SHA-256 of the full local id; the saved entry keeps both ids, and anything that compares holder identity later must apply the same mapping. Nothing in this command routes another command to the cloud.

## Dump and restore in pages

Use pages when a project is too big for one dump. The limits are counted in SQL, not by loading rows.

1. `GET dump?cursor=start` returns page 0. Each page is `{ format: "forge-cloud-dump-page/2", page, last, next, tables }` and its whole document, counted in UTF-8 bytes with its arrays, commas, metadata and cursor, is at most 4 MiB (`DUMP_PAGE_BYTES`) and never more than the 8 MiB restore body. A row is never split: a row that cannot fit alone with that envelope, or an empty or final page whose envelope alone is over the budget, is refused as `DUMP_TOO_LARGE` (413). The `next` cursor serializes `{ p, t, k, w }`: page number, table index, last key and export watermark. The watermark is a 32-character lowercase hexadecimal epoch, a dot and a zero-padded 19-digit mutation revision; a restore starts a fresh epoch. A cursor is at most 3,145,827 characters; `parseDump` refuses text over 8 MiB of UTF-8 before parsing.
2. While `last` is false, `GET dump?cursor=<next>` (URL-encode `next`) returns the following page. Keep every page. If the project is written to between two pages, the next page is refused as `DUMP_CHANGED` (409): start again from `cursor=start`.
3. `POST restore` each page, unchanged and in order, into an empty project. A page other than the next one is refused as `INPUT_INVALID`. Earlier pages only stage rows. The last page runs the same row checks as a whole restore over everything staged (`RESTORE_INVALID_ROW` names the table and row) and then provisions the project.

Limits: a project over 64 MiB stored (67,108,864 bytes), or with more than 30,000 rows in any table, is refused as `DUMP_TOO_LARGE` on every page request, not only page 0. A restore is checked after every staged page, in the same transaction, so the page that crosses either limit is refused (`RESTORE_TOO_LARGE`) and nothing stays staged. The last page's row checks read 16 rows at a time by key and parse events once, in sequence order, with `JSON.parse` after one linear scan of each body's text that refuses a repeated label (`JSON.parse` keeps the last copy and SQLite `json_extract` the first, so a repeat is read two ways). The same strict read covers record, lease and receipt bodies, including receipt fingerprints and results. A label in sibling objects, or label-like text inside a string, is legal. A second text scan, before anything is parsed, refuses a body, fingerprint or result nested past 32 levels or holding more than 5,000 values (containers, strings and literals; labels not counted) as `RESTORE_INVALID_ROW` naming the table and key. Both scans parse nothing and keep nothing across rows. They retain scalar revisions and digests per record and request, current lease state, and receipt read-set and fence metadata until its event. Memory therefore grows with distinct keys, request ids and their scalar metadata, but does not retain parsed record values or the whole event history. Receipts are paged once for that metadata and again for the final checks. The row and byte defaults and fixed upper bounds are 30,000 and 64 MiB (`DUMP_MAX_ROWS`, `DUMP_MAX_BYTES`); smaller positive safe integers lower the caps. CI measures a synthetic 3x tracker restore in a Node worker with a 96 MiB heap cap, a stand-in for one isolate; the deployed Durable Object is not measured. The 4 MiB page, 8 MiB request body and 3 MiB whole-dump ceilings are unchanged. The conformance run sets smaller values in `wrangler.test.jsonc`; `wrangler.example.jsonc` pins these limits. `DUMP_PAGE_BYTES` can lower the 4 MiB page cap but cannot raise it.

Admin `GET status` returns `value.initialized` and `value.dump`: `rows` for each of the six dump tables,
total `bytes`, effective `limits.maxRows` / `limits.maxBytes`, and `warnings`. Bytes sum the UTF-8 stored
columns, including command receipts; they are not the SQLite database size or serialized page size.
The diagnostic and export/restore checks share the same SQL accounting. Rows are capped per table,
not by their sum. An exact cap remains size-eligible; only usage above it refuses export or restore.
`DUMP_CAPACITY` warning objects identify `resource`, `used` and `limit` at `ceil(0.7 * limit)`:
21,000 rows in any table or 46,976,205 stored bytes at the default limits. Warnings do not block
writes or change status success. Above-cap status still reports usage. Uninitialized status reports
zero without schema setup; unreadable initialized storage returns `UNAVAILABLE`, never false zero.
The example vars pin the measured 30,000-row / 64 MiB limits. Before deployment,
run `capacity.ts` with `current`, `tracker-3x` and the existing boundary shapes at their former candidate limits: compare all six counts and content
digests, cold/warm results, final-page query counts, CPU/wall time and the 96 MiB heap-cap control.
These are measurement gates, not a deployed-capacity claim; whole-dump transport limits remain unchanged.

Staged rows are never served: a project is not provisioned until the last page, and every device route stops at that check before it runs any SQL.

To abandon a half restore, stop. To retry, send page 0 again: it clears the staged rows. Any refused restore request (an out-of-order page, a page over a limit, a bad document or a body that is too large) also clears them, so the next try starts at page 0. A whole `POST restore` clears them too.

## Offline current-state import (step 7)

The strict work-value engine requires close evidence for every closed issue. The approved
PR 592 integration policy adds one named converter repair, `legacy-close-evidence`, before
validation: for a closed current value or historical update with neither `receipt` nor
`withoutReceipt`, set `withoutReceipt` to exactly
`Imported: closed before Forge required close evidence`. Report separate counts of repaired
current values and historical updates, then require every repaired value to pass the strict
engine. Existing evidence is never overwritten. This policy belongs to the converter integration;
the engine has no legacy exemption, and the repair must ship before using this preparation on
legacy trackers. The fresh owner-tracker audit found 154 current values and 154 historical updates
requiring this repair; those counts are a measurement, not a fixed admission allowance.

Use only an owner-pinned standalone SQLite backup produced with SQLite backup/VACUUM INTO, without WAL, SHM or journal companions. Never point this tool at a running tracker. The source manifest has exactly `sha256` (lowercase SHA-256 of the complete file), `eventHighWaterMark` (last event sequence), `records` (exact current row count) and `at` (canonical ISO UTC projection time). Unsupported schema, work keys or allocation history refuse conversion; the source is opened read-only, held in one read transaction and hashed before and after. Supported work keys include landing, reopen, attempt, attempt evidence, cleanup, selection and slots, preserving their values without transferring leases.

```sh
node tools/import-current.ts --backup synthetic-backup.sqlite --manifest source.json --out new-bundle
node cloud/conformance/capacity.ts measure-current new-bundle
```

Every converted work value passes `validateDeclaredWorkRecord`, the same declaration validator used by main. The complete source and generated number floors are preflighted before projection writes. An unrepairable value refuses the whole conversion with its record key and named reason in `error.observed`; record values are not included.

The named legacy close repair applies only in this converter: a closed issue with neither `receipt` nor `withoutReceipt` receives `withoutReceipt: "Imported: closed before Forge required close evidence"`. That repaired value must pass the strict validator. The manifest reports `repaired.records` for repaired live records and `repaired.historicalUpdates` for repaired old update values checked during source verification. Historical updates are not exported as history; the projection creates fresh revision-1 events. Existing close evidence is preserved, and no other malformed value is repaired. The original backup is unchanged.

Non-work records and declared local-only work families stay local. These include lane control, asks, clocks, events, merge state, participant membership, local attempt notes and bound-lane attachments. Autopilot families carry the reason "local runtime state; retained in the pre-cutover snapshot; never imported as live approvals". Unknown work families refuse rather than becoming left-behind entries. If any retained-local records exist, the first conversion writes only `left-behind.json` and refuses: review its counts by namespace and key shape, then rerun into a **new** output directory with `--acknowledge-left-behind <sha256-of-left-behind.json>`. The digest binds the counts and live-lease count to the pinned backup and projection time; a missing or mismatched acknowledgement produces no completed bundle or pages. The successful bundle includes the same report and digest. No record values or identifier suffixes appear in this report. This follows the [PostgreSQL upgrade guide's explicit inventory of items requiring separate handling](https://www.postgresql.org/docs/current/pgupgrade.html), adding acknowledgement of the exact retained-local inventory.

Optional `--max-rows`, `--max-bytes` and `--page-bytes` must be positive safe integers; defaults use the existing dump limits. There are no upload, URL or token flags. The output must not exist: it is created privately, every page is exclusively created, read back, hashed, parsed and restored into a second scratch store, and all six table counts/digests must match. `manifest.json` is written and read back last. A partial directory is unusable; retries require another new directory. `measure-current` checks the completed manifest, exact page membership, lengths and SHA-256 hashes before starting any measurement. Keep the bundle private and immutable throughout measurement and rehearsal. Treat bundles and source backups as confidential and retain them under the owner's local backup/retention policy until readback and rollback obligations are satisfied; do not commit or upload them as CI artifacts.

The manifest records N current rows, F generated historical number floors, N+F revision-1 record/event pairs, six table digests, stored bytes, limits, ordered page hashes/lengths, relinquished source leases and dropped requests. Capacity validation reconciles N plus digest-verified left-behind counts with the total source count. New-project lease reset discards source lease generations, request receipts and prior approvals; old fences cannot authorize writes. Historical attempts remain readable as inactive; lease generation and expiry appear only when a lease record exists. Values and number floors survive, not execution authority. Record/event bodies and page membership are deterministic for the same source, projection time and limits; random export cursor epochs mean independent page hashes can differ.

Rehearse only in a fresh disposable project, restoring pages in manifest order before issuing any device tokens. Re-fetch all six target tables through paged dump and compare every count and content digest. A refused page abandons staging. After a lost intermediate response, restart at page 0 while still unprovisioned. After a lost final response, check initialized status: if initialized, verify the completed target or use another disposable project; do not repost page 0.

Practice runners use `verifyPracticeReadback` from `tools/import-current.ts` on the complete converted source and read-back tables, with the local time window around the final restore request. It applies the existing strict stop oracle, accounts for its generated rows, and compares all six table digests. Catch blocks preserve `practiceComparisonRefusal(error)` instead of replacing it with a generic code. The refusal names the check, table and first divergent key and includes per-table counts/hashes without record values. A null match means the expected digest could not be established, not a match or mismatch. Persist this report, its request window and stop-clock offset before deleting data copies; no rerun is authorized by a comparison refusal.

**Stopped activation:** a successful whole or final-page restore establishes an all-lanes stop, deletes every retained lane approval and browser challenge, and checks caps including the generated stop/control/audit writes in the existing SQL transaction. Any finalization failure refuses activation. State epoch and provisioning are published after SQL commit; the in-memory flag is set last. SQL and asynchronous metadata publication are separate boundaries. Readback must match the complete source plus verified floor, lease-release and stop deltas across all six tables. Without an imported global, stop adds two records and two events; with a valid global it updates that record and adds one audit record, producing two events. These generated rows count against unchanged caps. The converter's `requires-step-8-stop` manifest remains a pre-activation warning. A fresh owner-approved all-lanes shared resume is required before subsequent dispatch; a per-lane resume cannot lift the global stop. Existing processes are not cancelled.

For an owner-approved future cutover, stop local writers, retain the immutable backup and prior routing configuration, review and acknowledge the left-behind inventory, convert and measure, restore a fresh project before issuing tokens, and verify all six tables. The report counts leases live at backup projection time; zero leases are projected, and holders must reacquire after the move. Activate only after step 8 and fresh owner approval. Reverse by stopping the replacement, restoring the prior routing and reopening the retained local authority; do not run two writable authorities. Reconcile replacement-only writes before reversing. This procedure authorizes no real-data cutover or deployment.

## The issue number floor on restore

Create reads a floor record (`allocation:issue:work-` in `forge/work`) so a deleted issue number is never reused. A dump from before floors has none, so create refuses until one exists. Restore settles it as its last step, in the same transaction as the restored rows (the last page for a paged restore, never earlier). The checks that already replay every event also keep the highest issue number seen in live keys and in update and deletion events, and the highest earlier floor value. Nothing else counts for the issue floor: another namespace or prefix, a non-numeric or zero-padded suffix, and a lease on its own do not. An unsafe number refuses the restore instead of being rounded.

- **No floor in the dump:** restore writes one floor record at that highest number (0 when there is none) and one `record.updated` event, as the agent `cloud-restore`, at the next revision if a deleted floor left history. The restored counts in the response describe the imported rows only, not this pair. A deleted issue 2 beside a live issue 1 gives floor 2, so the next create is issue 3 at revision 1.
- **A valid floor in the dump:** it must be at least the highest number and at least any earlier floor value. A larger floor is kept exactly: its value, revision, timestamps and event text do not change, and nothing is written.
- **A malformed or too low floor** (null, extra fields, another prefix, a fraction, a negative or unsafe number, or below the history) is refused as `RESTORE_INVALID_ROW` (400) naming the allocation row. Restore never repairs or advances it.

Comments and links are numbered the same way, per issue and kind: a deleted comment or link number is never reused. Each uses its own floor (`allocation:comment:<id>:` and `allocation:link:<id>:`, the stored id), written by the same `putNext` that writes the record. A project from before these floors derives one on the first append, once, from live keys, record history and any earlier floor. Restore settles every observed comment and link floor the same way, even when every child was deleted, in prefix order after the issue floor, each as one more record and event. A supplied valid floor is kept exactly; a malformed, too low or regressed one is `RESTORE_INVALID_ROW`.

The generated pair counts against the same row and byte limits as the imported rows, and a whole restore now checks them too (`RESTORE_TOO_LARGE`, 413). Any failure rolls back the whole restore, or the last page, and the next try starts at page 0. To recover a legacy project, dump it, restore into an empty replacement project, issue its device only after the restore succeeds, and create. This does not repair a project that is already provisioned, and it does not show that a real tracker fits the unchanged limits (forge-1040 covers both).

A device token acts only as its own device. The admin token is the Worker secret `ADMIN_TOKEN`.

## Deploy

The owner runs these steps. Replace angle-bracket placeholders; `<worker-origin>` is an HTTPS origin without a trailing slash. Use an existing Cloudflare login with Workers/KV write access. Run every command from `cloud/` with the git-ignored `wrangler.local.jsonc` (copied from `wrangler.example.jsonc`) as `--config`; a bare `wrangler deploy` finds no `wrangler.jsonc` and stops. Commit no real value.

1. **Clerk OAuth application.** In the Clerk admin console, open **OAuth applications** and create or open an application. Set its redirect URI to `<worker-origin>/callback`, make it a public client and require PKCE S256; no client secret is used. Allow `openid profile email` scopes (the Worker currently requests `openid`). Copy the client ID from **Application credentials** and the Frontend API URL from **API keys → Show API URLs**. Clerk organizations are informational only and grant no project access. See [Clerk's public-client guidance](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth).
   If the Clerk instance requires organization membership, a new user must create or join an organization during sign-up before consent; organizations still grant no project access.

2. **KV namespace.** From `cloud/`, install its pinned tools:

   ```sh
   bun install --frozen-lockfile
   ```

   Copy `wrangler.example.jsonc` to `wrangler.local.jsonc` and set `account_id` and `name` first: the commands below read them through `--config`. On a first setup, create the namespace once:

   ```sh
   bun x wrangler kv namespace create OAUTH_KV --config wrangler.local.jsonc
   ```

   An existing deployment keeps its own namespace; find its id with:

   ```sh
   bun x wrangler kv namespace list --config wrangler.local.jsonc
   ```

   Set the `OAUTH_KV` id in `wrangler.local.jsonc`. Keep the rest of the example as it is: the preflight refuses any difference outside `account_id`, `name`, `vars` and that id.

3. **Public vars.** Set each var in `wrangler.local.jsonc`. All are required except `FORGE_OAUTH_REDIRECTS`; without `FORGE_OWNER_SUBJECT`, device login refuses (only login reads it), without `FORGE_CLOUD_PROJECT`, device login and `/command` refuse, without `FORGE_CLOUD_ID_PREFIX`, the issue commands answer 503, and the preflight stops the deploy in each case. `FORGE_OWNER_SUBJECT` is the owner's Clerk user id (in Clerk: Users, the user, "User ID", starting `user_`):

   | Name                    | Example shape                               | What `readOAuthConfig` checks                                                                                 | Classification |
   | ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------- |
   | `CLERK_ISSUER`          | `<frontend-api-url>`                        | HTTPS origin only, optionally one trailing slash                                                              | Not secret     |
   | `CLERK_CLIENT_ID`       | `<client-id>`                               | 1–256 printable ASCII characters, excluding spaces                                                            | Not secret     |
   | `CLERK_REDIRECT_URI`    | `<worker-origin>/callback`                  | Exactly the incoming request origin plus `/callback`                                                          | Not secret     |
   | `FORGE_API_RESOURCE`    | `<worker-origin>/p/<project-id>`            | HTTPS URL; a path is allowed                                                                                  | Not secret     |
   | `OAUTH_TIMEOUT_MS`      | `5000`                                      | Decimal integer string from 1 through 2147483647, no leading zero                                             | Not secret     |
   | `FORGE_OAUTH_REDIRECTS` | `<https-redirect-url>,<https-redirect-url>` | Optional comma-separated HTTPS URLs, no credentials, query or fragment; any bad entry makes OAuth unavailable | Not secret     |
   | `FORGE_OWNER_SUBJECT`   | `<owner-subject>`                           | `user_` plus alphanumerics; owner must match this subject and `CLERK_ISSUER` exactly                          | Not secret     |
   | `FORGE_CLOUD_PROJECT`   | `<project-name>`                            | The one provisioned project that login and `/command` serve                                                   | Not secret     |
   | `FORGE_CLOUD_ID_PREFIX` | `<id-prefix>`                               | The work block's `idPrefix` rule: lowercase letters, digits and single hyphens, 1–32 characters               | Not secret     |

   For cloud `issue.close` with `pr`, set non-secret `GITHUB_REPOSITORY` to `<owner>/<repo>` and `GITHUB_MERGE_POLICY` to the JSON string in the example: pin the admitted `FORGE_CLOUD_PROJECT`, numeric repository and producer identities, workflow path and SHA-256, base branch, version and nonempty unique required checks; omit `digest` (the server computes it), keep the JSON within 16 KiB, and match both repository ids to `GITHUB_REPOSITORY_ID`; invalid policy returns `UNAVAILABLE`. Set `producer.appId` (`<producer-app-id>`) to the check-suite App of the approved workflow, independent of the credential App `GITHUB_APP_ID`: read `app.id` from that workflow's check suite using `GET /repos/{owner}/{repo}/check-suites/{check_suite_id}`. The newest `delivers` link must name that repository and PR. Verification and close share one transaction and command receipt. Local close with only `pr` still returns `RECEIPT_REQUIRED` until CLI routing is added.

   The preflight runs the Worker's own rules for these vars, at the origin of `CLERK_REDIRECT_URI`. It cannot know the deployed origin, so the smoke checks below verify the real one.

   Every HTTPS value above rejects credentials, query strings, fragments, whitespace and backslashes. Registration accepts only loopback redirects (`http` on `127.0.0.1`, `[::1]` or `localhost`) and exact matches of `FORGE_OAUTH_REDIRECTS`; anything else is refused with `REGISTRATION_INVALID` before the rate limiter counts it. Metadata uses the callback origin, not the Host header. No Clerk secret key is needed or used; never put one in `vars`.

4. **Deploy.** First prepare generated validators from the repository root:

   ```sh
   bun install --frozen-lockfile
   ```

   ```sh
   bun run gen
   ```

   Return to `cloud/`. Two secrets are required, and their values are never printed. `DEVICE_LOGIN_HMAC_KEY` (random base64url, at least 32 bytes) is needed for device login, which refuses with 503 without it. `ADMIN_TOKEN` is needed for `status`, `devices`, `dump` and `restore`. A redeploy keeps both: a new `DEVICE_LOGIN_HMAC_KEY` voids pending device approvals and a new `ADMIN_TOKEN` voids the saved one. Rotating is its own decision, not a deploy step; to rotate on purpose, run that secret's command below alone, with no device approval pending.

   **First setup only.** If the Worker does not exist yet, Wrangler offers to create it; accept. Name a token file for this Worker, so another Worker's saved token is never overwritten:

   ```sh
   node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | bun x wrangler secret put DEVICE_LOGIN_HMAC_KEY --config wrangler.local.jsonc
   node scripts/set-admin-token.mjs --config wrangler.local.jsonc --token-file ~/.forge-cloud/<worker-name>.token
   ```

   **Redeploy.** Skip both commands. Record the current version (`bun x wrangler deployments list --config wrangler.local.jsonc`) and keep a private dump first. Then run the preflight. It refuses placeholders, a missing var or secret name, and an `OAUTH_KV` id that is not an existing namespace, before anything is uploaded:

   ```sh
   node scripts/preflight.mjs --config wrangler.local.jsonc
   ```

   Deploy only after it passes, never with the example or the CI-only `wrangler.test.jsonc`:

   ```sh
   bun x wrangler deploy --config wrangler.local.jsonc
   ```

   Expect a deployed Worker URL. Durable Object class migrations `v1`, `v2-code-redemption` and `v3-registration-limits` apply automatically on deploy; there is no manual migration command. `set-admin-token.mjs` saves its secret to the token file you named, without printing it. For authenticated curls below, prepare private curl config files containing the appropriate `Authorization` header; never put token values on the command line or print their files. Keep response files private too.

5. **Smoke checks.** Start with metadata:

   ```sh
   curl -sS -i '<worker-origin>/.well-known/oauth-authorization-server'
   ```

   Expect 200 JSON including `{"issuer":"<worker-origin>","authorization_endpoint":"<worker-origin>/authorize","token_endpoint":"<worker-origin>/oauth/token","registration_endpoint":"<worker-origin>/register"}`.

   ```sh
   curl -sS -i '<worker-origin>/.well-known/oauth-protected-resource'
   ```

   Expect 200 JSON `{"resource":"<api-resource>","authorization_servers":["<worker-origin>"]}`, matching `FORGE_API_RESOURCE`.

   If a var is missing in a bad deploy, the same request below returns a visible config refusal; do not remove a live var just to test it:

   ```sh
   curl -sS -i '<worker-origin>/.well-known/oauth-authorization-server'
   ```

   With only `CLERK_ISSUER` missing, expect 503 `{"error":{"code":"AUTH_CONFIG_UNAVAILABLE","variable":"CLERK_ISSUER","message":"OAuth configuration unavailable"}}`. Device-token and admin routes bypass OAuth config and keep working:

   ```sh
   curl -sS -i --config '<admin-curl-config>' '<worker-origin>/p/<project-id>/status'
   ```

   Expect 200 with `value.initialized: true` for a provisioned project (`false` before provisioning), plus the dump usage, effective caps and warnings described above.

   ```sh
   curl -sS -i --config '<device-curl-config>' '<worker-origin>/p/<project-id>/holder?subject=deploy-smoke'
   ```

   With an existing unexpired device token for this project, expect 200 `{"ok":true,"value":null}` for an unused subject, or a lease object. This is the working project path.

   The admitted project (`FORGE_CLOUD_PROJECT`) must exist. On a first setup with an isolated Worker and config, `POST devices` with the admin config provisions it. On an existing deployment, check `status` and keep its binding and credentials; never point the live Worker at a disposable project. These unauthenticated checks show only that the routes answer and refuse correctly:

   ```sh
   curl -sS --output '<private-login-response-file>' --write-out 'HTTP %{http_code}\n' -H 'Content-Type: application/json' --data '{"device":"deploy-smoke"}' '<worker-origin>/p/<project-id>/loginstart'
   curl -sS -i '<worker-origin>/device'
   curl -sS -i -X POST -H 'Content-Type: application/json' --data '{}' '<worker-origin>/p/<project-id>/command'
   curl -sS -i -X POST -H 'Content-Type: application/json' --data '{}' '<worker-origin>/p/<other-project>/command'
   ```

   Expect 200 with `device_code`, `user_code`, `expires_in` and `verification_uri` (keep that file private; it counts toward the five starts per address per minute); then 200 HTML; then 401 `AUTH_REQUIRED`; then 403 `AUTH_FORBIDDEN`. The command handler's reads, `issue.create`, `issue.comment` and owner approval in the browser are not exercised here. Treat both as unverified unless you test them separately.

   Register one public client using the real client's callback URI:

   ```sh
   curl -sS --output '<private-registration-response-file>' --write-out 'HTTP %{http_code}\n' -H 'Content-Type: application/json' --data '{"redirect_uris":["<client-redirect-uri>"],"token_endpoint_auth_method":"none"}' '<worker-origin>/register'
   ```

   In a fresh quota window expect 201 JSON including `client_id` and `redirect_uris`. Retain that client for login. Then exercise the same-IP ceiling:

   ```sh
   for attempt in 1 2 3 4 5; do curl -sS --dump-header - --output '<private-burst-response-file>' --write-out 'HTTP %{http_code}\n' -H 'Content-Type: application/json' --data '{"redirect_uris":["<client-redirect-uri>"],"token_endpoint_auth_method":"none"}' '<worker-origin>/register'; done
   ```

   After five admitted registrations total from this IP in a fixed UTC hour, expect 429 `{"error":{"code":"REGISTRATION_RATE_LIMITED"}}` with `Retry-After` seconds until the next hour; 100 global admissions also trigger it. Cloudflare supplies `CF-Connecting-IP`; do not spoof it. Bodies are capped at 8192 bytes, redirect lists at 5 entries and each URI at 512 code units; abandoned registrations expire after 86400 seconds. Wait for rollover before another registration, or reuse the retained client.

   Authorization starts have an independent budget in the existing `REGISTRATION_LIMITER` binding: the `authorizations` object admits 10 starts per canonical address and 100 globally per fixed UTC 10-minute window, using the object's clock. Every admitted GET `/authorize` spends both units before OAuth validation, with no refund for invalid OAuth inputs or later failures. Cookies, client IDs and query variations do not exempt attempts. Fixed windows allow boundary bursts. The global budget trades flood protection for a possible 10-minute sign-in lockout if an attacker exhausts it; it does not cap all live transactions.

   At either ceiling, HTTP 429 returns only `{"error":{"code":"AUTHORIZATION_RATE_LIMITED"}}`, `Cache-Control: no-store` and integer `Retry-After` seconds until rollover (rounded up, at least 1). Definitive quota refusals write no KV/DO state and never enter the OAuth provider. Missing or invalid ingress addresses return the same refusal with `Retry-After: 600`, before any limiter lookup. Consent POST, callback, token/refresh/revoke and device/command/lease paths do not spend this budget; registration remains independent.

   Unavailable admission returns HTTP 503 `AUTH_CONFIG_UNAVAILABLE`, variable `REGISTRATION_LIMITER`, message `Authorization admission unavailable`, and `Cache-Control: no-store`. No OAuth KV writes follow. A failed reply after a committed admission may already have spent its units; admission is never retried or compensated. The strict zero-DO-write guarantee applies to definitive 429 refusals, not that uncertain 503 case.

   Only `CF-Connecting-IP` supplies the quota address: require one IPv4/IPv6 literal, canonicalize it and persist only its SHA-256 hash. Alternate headers never substitute. On direct public ingress Cloudflare supplies this quota signal; it is not owner identity. Same-zone Worker subrequests can influence it, so same-zone scripts must remain trusted or be blocked at ingress; cross-zone Worker callers may share a Cloudflare address. Arbitrary Worker-origin traffic does not have an unspoofable visitor address. No ingress or Pseudo IPv4 policy changes are included here.

   Use an OAuth-capable MCP client to log in with that client ID, its registered redirect URI, S256 PKCE and the configured resource. Follow `/authorize`, choose Allow, sign in at Clerk and return through `/callback` to the client's redirect URI. The login check ends at a successful token exchange. If exchanging manually instead of letting the client exchange, save the one-use code and matching verifier in private files without trailing newlines, then run:

   ```sh
   curl -sS --output '<private-token-response-file>' --write-out 'HTTP %{http_code}\n' --data-urlencode 'grant_type=authorization_code' --data-urlencode 'client_id=<registered-client-id>' --data-urlencode 'redirect_uri=<client-redirect-uri>' --data-urlencode 'resource=<api-resource>' --data-urlencode 'code@<private-code-file>' --data-urlencode 'code_verifier@<private-verifier-file>' '<worker-origin>/oauth/token'
   ```

   Expect 200 JSON including `access_token` and `token_type: "bearer"`; do not print the response. Codes are single-use, failed exchanges burn them, and refresh grants are refused. Check OAuth project access using a private config with this token:

   ```sh
   curl -sS -i --config '<oauth-curl-config>' '<worker-origin>/p/<project-id>/holder?subject=deploy-smoke'
   ```

   Expect 200 `{"ok":true,"value":null}` for an unused subject when the token matches the configured owner issuer and subject. Another Clerk user, or an absent `FORGE_OWNER_SUBJECT`, must get 403 `AUTH_FORBIDDEN`. The owner's token on `GET /p/<project-id>/status` must get 401; all admin routes still require the admin token.

6. **Rollback.** From `cloud/`, select the version you recorded before the deploy:

   ```sh
   bun x wrangler rollback <version-id> --config wrangler.local.jsonc
   ```

   Expect the selected version to become active. A rollback swaps code only. It does not undo the SQL migrations a project applies when it first opens (`src/core/state/migrations.ts` and the cloud domain migrations registered in `cloud/src/project.ts`), stored data, KV clients and grants, claims, registration counters or a rotated secret. After new code has opened a project, an older binary may refuse the upgraded store and the project may break; restore your private dump into an empty project if so. Wrangler's Durable Object class migrations are separate: Cloudflare refuses rollback across them, so do not delete namespaces or migrations to force it. See [rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

7. **Known limits.** Links point to the originating reviews; issue IDs are tracked in Forge. [forge-1121 (registration residuals)](https://github.com/harshanandak/forge/pull/406): provider-invalid requests consume quota, fixed windows allow boundary bursts, shared or Worker-origin IPs affect quotas, and pre-existing clients retain their old TTL.

Authorization-code redemption validates the code shape and stored code hash before allocating durable claim state or an alarm. The atomic claim still precedes the token exchange, so failed binding checks burn a valid code.

A proven replay of a consumed code durably revokes its grant before sweeping provider KV. Access verification checks that permanent marker, so a winner that saves its token after the sweep cannot reopen access. A concurrent loser leaves an unconsumed winner's grant active.

## OAuth holder revocation

`POST /oauth/revoke` takes an `application/x-www-form-urlencoded` body with exactly one nonempty `token` and `client_id`, and at most one `token_type_hint` (lookup order only). The body limit is 8192 bytes. The client must be registered with authentication method `none`; Authorization headers, client secrets and assertions are refused.

A live access token or a current/previous issued refresh token with its matching public client id can revoke the whole grant, including sibling access tokens. A public client id alone grants no authority. Successful and repeated revokes return empty HTTP 200 with `Cache-Control: no-store`; unknown, expired or wrong-client tokens for a known public client return the same response without revoking a victim.

Malformed requests return 400 `invalid_request`, unknown/non-public clients return 400 `invalid_client`, and unavailable durable state returns 503 rather than claiming an uncommitted revoke. OAuth paths require `GRANT_STATE`. Each access verification reads the permanent hashed grant marker after provider/identity validation, so stale or late KV writes cannot reopen access. Revocation does not sweep KV or recall work authorized before its commit.

GET discovery advertises `/oauth/revoke`, `authorization_code` and guarded `refresh_token`. A public client posts exactly one `grant_type=refresh_token`, full `refresh_token` and `client_id`; optional scope/resource cannot widen the original grant. Each token is durably spent before provider rotation. Proven reuse revokes the whole grant, including a concurrent winner's returned tokens. Claims stay spent after a provider failure or lost reply; unavailable state gives sanitized 503. Native revoke at `/oauth/token` remains refused.

Access lifetime is explicitly 3600 seconds, refresh lifetime 2592000 seconds, with no idle renewal. The first refresh pins the absolute grant deadline; fewer than 60 seconds remaining refuses, and near-boundary access is shortened. Upstream proof expiry remains an earlier limit and refresh never renews it. Cleanup after deadline plus 30 seconds removes spent hashes but retains closed/revoked authority. Device credentials, CLI behavior and the admin-only device revoke route retain their contracts. CI-local workerd covers overlap, restart, late writes and claim/access-check-removal counterfactuals; deployed refresh remains unverified.

## Check a live Worker

```sh
CLOUD_BASE=https://<worker>.workers.dev CLOUD_LIVE=1 \
  CLOUD_ADMIN_TOKEN_FILE=~/.forge-cloud/forge-cloud-dev.token \
  bun conformance/conformance.ts main
```

Use the phase `latency` instead of `main` for claim p50 and p95 over 200 claims.

A live `main` run keeps the Worker's production limits, so it does not run the journeys that need the small limits of `wrangler.test.jsonc` (a 4096-byte page, 131072 stored bytes, 100 rows per table). It prints one `SKIP <name> -- <reason>` row for each skipped journey and never skips by catching a failure: whether a journey runs is decided before its body starts, and an eligible journey that fails is a `FAIL`. Live limits are not discovered. The skipped journeys are:

- **Needs the test Worker's wrapper:** the 8 device login journeys (the local Clerk double), the 2 fault-header journeys (the wrapper's fault headers) and the 19 typed command journeys (the admitted fixture project). The typed restart check in the `restart` phase also skips, because it needs the typed state the main run saves.
- **Needs the small CI limits:** the byte-bounded export and identical restore, the `DUMP_CHANGED` check between export pages (it needs a real continuation cursor under the small page limit), and the project size guard (131072 bytes, 100 rows per table).
- **Needs an incomplete upload answered early:** the 9 MiB header-only restore. The local Worker answers it with `RESTORE_TOO_LARGE` before a body arrives; deployed ingress is not covered by that transport assumption, so this is a transport exclusion, not a project limit. The 8 MiB body cap is checked only in CI.

That is 33 skipped journeys in `main`. Two journeys run live on adapted input: the restore-order check and the staged-row validation cut their restore pages from the real dump of a small project, in table and row order, into at least four pages. These test the restore protocol (order, abandonment, row checks), not where the server cuts an export. CI still runs all the original journeys against the small limits, and a CI job fails if any of them is skipped there. A passing live `main` is narrower than the two-machine proof: it checks the route behavior of the deployed Worker, not the step-by-step dump and restore comparison of every table in the two-machine runbook.

## Delete

From `cloud/`: `bun x wrangler delete --config wrangler.local.jsonc`. This removes the Worker and
all project data in its Durable Objects. Dump the projects first if you need them.

## Credentialed record client

`createCloudRecordClient` in `src/assembly/cloud-state-client.ts` reads and commits
records for one bound cloud project through the checked HTTP state adapter.
It reuses the lease client's exact origin/project transport check, the stored
origin/identity/project credential key, wire device mapping and safe refusals.
A mismatch fails before sending. Named devices must match the credential;
project roots are removed and the bound cloud project name goes on the wire.
Reads return checked server facts without opening a local state owner.
No operation logs in, rotates credentials, writes a local fallback or resends.
An unusable or lost commit reply is `UNAVAILABLE`, with reconciliation required:
retain the exact commit input and request ID until acceptance is established.
An explicit replay uses that same request; do not rerun the domain command to
recover an uncertain write. An already-aborted commit keeps its cancellation code;
cancellation during a commit attempt requires reconciliation, as a lost reply does.
The async state provider and memory/decision routing are separate integrations.
