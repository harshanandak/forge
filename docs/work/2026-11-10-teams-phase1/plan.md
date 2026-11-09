Decisions needed: none.

# Team phase 1 implementation plan

Build verified identity first, then let two people and their agents share one project through one connected authority. Keep every implementation PR at 300 changed lines or fewer, including tests and generated contract inputs. The ordered [task list](tasks.md) maps 41 PRs to forge-1012 and forge-1054 through forge-1061. This document approves no account creation, resource provisioning, deployment or migration of live data.

## Scope and settled decisions

The November 10 owner decision in the fifth forge-1052 comment supersedes the paper's hosting recommendation and the earlier unresolved open-core questions in forge-1012. The second forge-1012 comment supplies auth option D. The issue body predates that choice.

| Area        | Required behavior                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity    | Clerk signs in hosted humans. The Worker serves OAuth 2.1 for remote MCP through `@cloudflare/workers-oauth-provider`, with Clerk upstream. A configured OIDC verifier permits self-hosting without Clerk. |
| Credentials | Forge issues device credentials, stores device secrets in the OS keychain, and derives short-lived agent credentials under an accountable person.                                                          |
| Authority   | One connected authority accepts project commands. Local caches are disposable. Offline appends remain proposals.                                                                                           |
| Access      | Organization membership plus an explicit project grant. Organization administration alone grants no project content access.                                                                                |
| Approval    | Maintainers approve ordinary exceptions. A different authenticated human approves protected actions. An author's other agent cannot qualify.                                                               |
| Memory      | Explicit publication only. Device notes and raw transcripts remain private. Use separate granted projects for restricted content.                                                                          |
| Capacity    | Reserve lanes across the project, with fairness per person. Device CPU and RAM checks remain local.                                                                                                        |
| Licensing   | Build team modules here temporarily. Before release, forge-1077 moves them into a closed layer. Self-hosted teams require an enterprise license. Everything already merged stays open.                     |

The [research paper](../2026-11-09-teams-research/options-paper.md) remains the source for feature scenarios and later phases. Its eight contract slices become the smaller tasks here. Do not treat its old hosting choice as approval to release team source or remove existing open features.

## Evidence and current seams

Current-code evidence is rung 2, source inspection of fetched `origin/main` at `e908f64ea94cb4ad65a0e068c7514eb48ec71e2b`. Proposed files and interfaces below describe future implementation. No team runtime, identity-provider integration or live cloud journey has been proved by this docs PR.

| Inspected file                                         | Observed behavior and implication                                                                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud/src/worker.ts`                                  | Routes project paths to one object and checks a deployment admin bearer for devices, revoke, status, dump and restore. Add an injected request identity boundary; a route name is not a project grant.            |
| `cloud/src/project.ts`                                 | Serves lease operations and device administration. Rechecks device authorization after asynchronous body reads, then writes synchronously. Preserve that ordering for membership, policy and parent-token checks. |
| `cloud/src/tokens.ts`                                  | Stores device-token hashes, labels, expiry and revocation. `authorize` returns a device string. Add a verified principal result without interpreting labels as a human identity.                                  |
| `src/assembly/identity.ts`                             | Derives local session and harness labels from environment signals. Preserve local coordination; require a separate verified principal for connected authorization.                                                |
| `src/assembly/project-manifest.ts`                     | Accepts only schema, UUID and optional name. Keep organization bindings and credentials outside the committed manifest.                                                                                           |
| `src/assembly/state-client.ts`                         | Binds synchronous state methods to a local owner and context. Add an asynchronous command port rather than concealing HTTP inside those synchronous methods.                                                      |
| `src/core/state/README.md`                             | Documents atomic revision, read-set, event and request-result checks, synchronous transactions and generation fences. Reuse these invariants; keep team vocabulary outside core.                                  |
| `src/assembly/approval.ts`                             | Binds local approval proofs to exact operations and inputs. Connected approval needs authenticated humans and current project eligibility.                                                                        |
| `src/blocks/check/receipt.ts`                          | Exposes content hashing and receipt verification. A matching hash alone does not establish a trusted project runner.                                                                                              |
| `src/blocks/memory/index.cts`                          | Binds device/project stores and peer reads. Scope and level do not replace authorization on connected reads.                                                                                                      |
| `docs/reference/cloud.md`, `cloud/src/dump.ts`         | Describe paged recovery, empty targets and byte/row bounds. Team exports need versioned authorization metadata and fresh authority on restore.                                                                    |
| `CODING_STANDARDS.md`, `test/structure/lib/imports.ts` | Require dependency adapters and expose import scanning. Extend the scanner with a team dependency rule and motivating negative fixtures.                                                                          |

The tracked tree has one file in the research directory, the options paper. It has no `skills/plan/SKILL.md` or `docs/INDEX.md` at this revision. Use the brief's plan/tasks format and the current slicing conventions in `templates/delivery/skills/forge-cut/SKILL.md`; add no historical index or generated skill mirror.

## Order and account-free build boundary

1. Land task 1, the forge-1012 identity contract: issuer plus subject, injected verifiers and a test verifier. It requires no account, network or provider package.
2. Land task 2, the open/team dependency guard, before adding any team module. Land task 3, the configured OIDC verifier, against generated local keys and an injected HTTP transport.
3. Complete the forge-1012 protocol tasks against local fake upstreams. Membership tasks can start after tasks 1 to 3 with the test verifier; they do not wait for a Clerk tenant or a deployed Worker. Credential tasks depend on that auth contract and committed project grants.
4. Add organization membership and project-local grants, then person-bound devices and agents. Keep team routes unavailable unless the team composition installs authorization.
5. Add typed remote work commands in batches. Keep close refused until policy, independent approvals and trusted evidence pass task 33. Add filtered pull, cache/outbox separation and lane reservation without a local fallback writer.
6. Add policy, approval, runner evidence and the final close gate. Add explicit memory publication after access-filtered reads and policy exist.
7. Add bounded export, restore, cutover and quota protection, then run the combined account-free packaged journey. Resolve the closed-layer split in forge-1077 before any team release.

All 41 tasks can implement and test their contracts in CI without Clerk or Cloudflare accounts. Use injected clocks, locally generated OIDC signatures/JWKS, fake upstream HTTP, a fake Worker namespace and the SQL port with a disposable local database. Call Worker handlers as functions; do not invoke a deployment CLI. Real keychain adapters use fake OS boundaries for CI contract tests; desktop proof remains a separate release requirement.

| Evidence available without accounts                                                               | Evidence still required before release                                             |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Issuer/audience/subject validation, key rotation and upstream failure fixtures                    | Hosted Clerk configuration, redirect origins, upstream sign-in and logout behavior |
| Device approval polling, single redemption, keychain broker failures and agent scope intersection | Interactive login and persistent OS-keychain readback on supported desktops        |
| OAuth PKCE, consent, redirect allowlist, resource/audience and remote MCP authorization fixtures  | Remote MCP clients against an owner-provided hosted environment                    |
| Two-organization grants, revocation interleavings, fences and recovery under local ports          | Deployed Worker/Durable Object behavior under network interruption and restart     |
| Self-hosted issuer contract suite and licensed team composition fixture                           | Operator-managed enterprise installation with its configured OIDC issuer           |

CI PASS proves fixture behavior, rung 4. It does not prove hosted interoperability or authorize new resources. Record release evidence as incomplete until the owner supplies an environment through a separately authorized lane. Do not call phase 1 released merely because task 41 passes.

## Identity and credential contract

The proposed open `IdentityVerifier.verify` accepts credential material through an injected transport and returns a verified identity with exact issuer, nonempty subject, audience, expiry and authentication time. Verification selects only configured issuers, algorithms and audiences. Reject unsigned tokens, algorithm confusion, stale keys beyond a bounded cache, unknown key IDs after one refresh and network failure with no valid cached key. Never follow a token-supplied key URL. Do not normalize issuer or subject into an email or case-folded identity.

Map `(issuer, subject)` to a stable Forge person through `PersonDirectory`. Email, display name, browser active organization, Git author and `FORGE_SESSION` never supply this mapping. Bind the connected context to person, organization, project, device, session, credential ID, parent ID, scope and membership/authority epochs. Derive audit actor and sponsor on the server, ignoring caller attribution fields for authorization.

Use an explicit human-approved device login challenge with expiry, bounded polling and one successful redemption. Separate its code from OAuth authorization codes. Deliver a Forge device secret only to the initiating client and keep it in the OS keychain. The broker returns an unavailable result if storage fails; it never falls back to a plaintext file or command argument. Agents receive credentials through a private broker channel, with no persistence in prompts or transcripts.

Proposed agent lifetime is 15 minutes, capped by parent expiry. Effective scope is the intersection of parent grant, current project grant and requested scope. Exclude membership changes, operator restore, protected approval and project transfer from agent delegation. Rotation preserves the execution session but changes the public credential ID. Revoking a device fences its descendants; removing a person fences every device/session for that person's project access.

For remote MCP, the Worker is the OAuth server and Clerk is an upstream identity source. Forge still checks project grants on every tool call. The provider library owns protocol handling behind the open OAuth adapter; it does not own Forge membership. Use exact redirect registration, PKCE S256, client consent, callback state and resource/audience binding. Keep upstream credentials out of downstream token properties and domain audit. The [provider's upstream guide](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md) and [resource validation guide](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/advanced-configuration.md) inform these boundaries; builders must pin and inspect the selected version in their adapter PR, including its dependency ledger entry.

## Open interfaces and removable team modules

Expose only contracts with named task consumers. The names below are proposed, versioned interfaces, not existing exports. Interface types stay provider-neutral. Each seam task includes its typed public export in `package.json`, build declarations and its first consumer; include those lines in the task budget. Adapters own third-party libraries and OS calls as required by `CODING_STANDARDS.md`. The existing `src/adapters/process/adapter.json` owns `koffi`; a vault implementation must reuse that owner through an injected public port or choose a separately owned binding, never import its internals or declare a second owner.

| Open extension and proposed home                                                           | Consumer and responsibility                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VerifiedIdentity`, `IdentityVerifier` in `src/ports/identity.ts`                          | Open OIDC/Clerk identity adapters and `team/identity.ts`; prove issuer plus subject, never membership.                                                                    |
| `CredentialVault`, `CredentialBroker` in `src/ports/credentials.ts`                        | Open desktop adapters and `src/assembly/credential-broker.ts`; keychain persistence and ephemeral delegation delivery.                                                    |
| `RequestAuthorizer` in `src/ports/authorization.ts`                                        | Open cloud composition supplies single-owner behavior; `team/authorization.ts` supplies grants, scope and epochs. No default allow for an absent team provider.           |
| `ProjectCommandPort`, `ProjectQueryPort` in `src/ports/project-commands.ts`                | Open assembly dispatches async allowlisted operations; `team/commands/` and `team/queries.ts` implement team acceptance/filtering. Never expose raw SQL or uploaded code. |
| `PolicyConstraint`, `ApprovalVerifier`, `EvidenceVerifier` in `src/ports/authorization.ts` | Open assembly/check/work consume decisions and version bindings; `team/policy.ts`, `team/approvals.ts`, `team/evidence.ts` implement team rules.                          |
| `AuthorityLifecycle` in `src/ports/authority.ts`                                           | Open cloud dump/restore accepts validation and activation hooks; `team/recovery/` supplies team metadata, epochs and cutover.                                             |

Open adapters live under `src/adapters/oidc/`, `src/adapters/workers-oauth/`, `src/adapters/keychain/` and `src/adapters/clerk/`. Clerk remains optional at composition, with the OIDC verifier as the replacement. Do not require a Clerk account to import or run the single-owner distribution.

Team implementation lives only under root `team/`, with its own build entry, migrations and tests under `test/team/`. Proposed subdirectories are `team/cloud/`, `team/commands/`, `team/recovery/` and `team/cli/`. `team/cloud/worker.ts` imports the public cloud factory and installs team providers. `team/cli/compose.ts` imports public assembly factories and supplies team services. The public factories never import those composition roots. Use existing open work/check/memory commands through public contracts rather than copying their implementation.

Task 2 extends `test/structure/lib/imports.ts` and adds `test/structure/team-boundary.integration.test.ts`. It rejects imports from open `src/`, `cloud/`, `bin/`, `templates/` and public build entrypoints into `team/`, including type imports, re-exports, literal dynamic imports and package aliases resolved through exports. Reject nonliteral dynamic loading in those composition paths. Test both direct and barrel-mediated leaks. The public package/build must work with `team/` absent, and the team build must use only declared public exports. Add each new seam with its first consumer's contract suite; do not introduce empty generic plugin registries.

Every team PR lists its open interfaces, keeps team schema and authorization logic in `team/`, supplies a negative authorization case and runs the dependency guard plus public-package-without-team smoke. It must not add a team import or a team-specific condition to core. If a seam is insufficient, land a provider-neutral extension PR first under the same mapped issue. At forge-1077, move `team/` and its tests/build metadata to the closed layer and replace local imports with the same versioned public exports. Check licensing and distribution before release; a folder boundary does not itself make code private or change the current license.

## Authorization, acceptance and revocation

The organization registry serializes identity bindings, membership, last-owner protection and grant revisions. Each project stores its binding and current authorization projection. Organization membership does not imply project content access. A default team groups grants; it does not create another project copy. Keep the committed manifest unchanged (`src/assembly/project-manifest.ts`).

Removal begins by marking the member pending removal and denying new credential exchange. Fence every affected project's epoch, then collect acknowledgements. Completion means every affected project committed its fence or entered an authority-local fail-closed state. If a project cannot be reached, report removal pending, never global completion. To bound exposure during partition, project projections have renewable freshness leases, proposed maximum 60 seconds, and refuse protected reads/writes when stale. Never promise immediate cross-project revocation before acknowledgement; expose the remaining lease deadline.

Prepare network reads and cryptographic work before the project transaction. Inside one synchronous acceptance boundary, recheck membership freshness, role/scope, parent revocation, policy version, authority epoch, lease generation and read-set revisions, then atomically write mutation, event and idempotent result. No await may separate the final checks from commit. Audit records use server-derived person/device/session and content-minimal refusal metadata.

Scope idempotency by project, person and authority epoch; fingerprint operation and canonical input. Check current access before returning any saved result. Replaying a success cannot renew a lease, approval or credential. Keep accepted commands behind an allowlist and bounded schemas. Start close as unavailable until task 33 installs the complete evidence and approval predicate.

## Threat model

1. A member guesses another project ID: authorize before routing to content and before counts, pages or exports.
2. An organization admin has no project grant: deny content reads and writes, including recovery shortcuts.
3. A caller forges actor, email or harness labels: derive person and sponsor from verified credentials.
4. An attacker substitutes an issuer, audience or JWKS URL: accept only configured trust roots and algorithms.
5. An OAuth client steals a callback: bind state, PKCE, consent, redirect and resource to the initiating flow.
6. An agent requests broader scope: intersect current project, parent and requested scopes, with human-only actions excluded.
7. A device is revoked during body streaming: repeat parent and membership checks at synchronous commit.
8. A person is removed across projects: expose pending acknowledgements and fail closed after projection freshness expires.
9. A retry replays an old grant: scope requests to principal and epoch and revalidate current authority before returning results.
10. Two sessions race for a lease or final lane slot: serialize acceptance and increment generation on takeover.
11. A restored store contains old authority: mint a fresh epoch and invalidate imported leases, approvals, cursors and credentials.
12. An offline client writes accepted state locally: refuse shared mutation and preserve only labelled drafts/proposals.
13. An author uses their second agent as approver: compare authenticated humans and recheck eligibility at consumption.
14. A caller fabricates a PASS receipt: require enrolled-runner provenance bound to project, repo, head, input and policy.
15. A memory query or export leaks hidden content: filter every query path and purge revoked serving caches on reconnect.
16. A quota or crash prevents recovery: reserve safety headroom and keep release, revoke and export available.

## Recovery, acceptance and release

Cache identity includes person, project, access epoch and authority epoch. Store append proposals separately. Reconnect refreshes access, purges lost visibility, pulls accepted state, then reconciles proposals. Preserve both versions on conflict. Never retry an uncertain mutation under a new request ID before querying the original result.

Lane start reserves remotely, performs local Git work and acknowledges with the same reservation ID. Crash recovery adopts or cancels that reservation under a current fence. Handoff preserves commits and changes generation; it never deletes another device's worktree. Admission counts all a person's devices together. Use a deterministic FIFO queue per person with round-robin selection among eligible people; enforce project cap and an explicit per-person cap.

Keep paged recovery within the existing 10,000 rows per table, 8 MiB stored and 8 MiB restore-body bounds documented in `docs/reference/cloud.md`. Count added team tables, idempotency and audit records toward bounded admission. Reserve headroom for safety operations and refuse new spend before recovery becomes impossible. Larger bounds remain forge-1040 work.

Cutover first freezes the source, exports and verifies counts/digests, stages the target, maps legacy actors as unverified provenance, and activates exactly one writer with a new epoch. Before activation, abandon a failed target and reopen the original writer. After activation, freeze the target and reconcile its accepted delta into a new fenced recovery epoch; never simply reopen the stale source. Restore requires current destination grants and never imports credentials as authority.

Task 41 packages the open and team compositions, creates 2 organizations with 2 project members plus an unauthorized third principal, races 100 claims, recovers a lane crash, reconciles offline conflicts, approves protected work independently, closes once, removes a member mid-operation and exports/restores under fresh fencing. Repeat with a non-Clerk issuer and reject a missing enterprise entitlement. An entitlement outage blocks new commercial admission but never revoke, release, export or recovery. Record each scenario, counterfactual and exact package/head. Desktop and hosted evidence from the account boundary table remains required before release alongside forge-1077.

For this docs PR, run frozen install, generation, format check and lint only. CI runs the repository's documentation checks. No local test suite, external account or infrastructure action belongs to this lane.

## Deferred work

| Deferred scope                                                       | Reason and owner                                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Physical closed-layer split and enterprise distribution              | forge-1077 owns packaging, licensing and release. This plan establishes the import seam first.                                                         |
| New accounts, resources and live deployment                          | Requires a separately authorized environment lane; fixture implementation needs none.                                                                  |
| Multiple team groups, guests and cross-organization project transfer | Phase 2 of forge-1052; direct grants and one default team cover the 2-person journey.                                                                  |
| Restricted note collections and full historical erasure              | Phase 2 needs ACLs on every derived view plus retention/key separation. Phase 1 forget purges serving surfaces without promising event/backup erasure. |
| External tracker synchronization and cross-project reporting         | Phase 2/3 consumers of filtered commands; neither may allocate execution authority.                                                                    |
| Organization service principals, hosted runners and artifact hosting | Phase 3 introduces separate ownership, budgets, secret delivery and isolation. Phase 1 agents keep human sponsors.                                     |
| Larger recovery caps and performance promises                        | forge-1040 requires measurements before changing bounds. This plan preserves current limits.                                                           |
| Arbitrary non-Cloudflare deployment backend                          | A replaceable OIDC issuer does not provide a different storage/runtime backend. Enterprise self-hosting targets the Worker contract.                   |
| Broader harness/watch routing                                        | Existing forge-448, forge-449, forge-456 and forge-467 remain their owners' work; this plan tests principal binding at the command boundary.           |

No new child issues are needed: every task maps to an existing approved issue. Builders record scope, success criteria, constraints, edge cases and exclusions from its task before implementation. Each stage-exit comment records summary, decisions, artifacts and next, with the exact head and evidence rung. The lead retains claims, lane close and merge authority.
