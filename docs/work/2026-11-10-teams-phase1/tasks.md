# Team phase 1 ordered tasks

Decisions needed: none. Follow [the plan](plan.md), including the release evidence boundary and closed-layer release gate (forge-1077).

Each numbered task is 1 PR with a ceiling of 300 changed lines, including tests, schemas, adapter metadata and documentation. The tier is **security** for every task because each changes authentication, authorization, accepted authority or data exposure. Estimated sizes are budgets, not measured diffs. If the concrete patch exceeds its budget, split that task under the same issue before implementation; preserve its dependency and refusal tests. A listed new file is proposed, not a claim that it exists. Seam tasks also own their public package exports, declarations and adapter metadata within the same budget. Team bootstrap task 8 owns its separate package/build entry. Declare new login operations once in the accounts block catalog during task 17; generate CLI/MCP bindings rather than adding a handwritten command.

For each task: demonstrate its named negative acceptance case failing before the change, implement the minimum change, then demonstrate both positive and negative cases. Inject time, HTTP and platform ports. Run the mapped suite and the repository's required checks on the final head. No task authorizes accounts, resources, deployment, live migration or a deployment CLI. Do not claim released team behavior from these CI fixtures.

Task numbers define a valid serial order. The explicit dependencies permit narrower parallel work only after their prerequisite contracts land. Membership may use the test verifier after tasks 1 to 3, without waiting for hosted sign-in. Team command routes remain unavailable until their final authorization predicates land. Never enable an incomplete close path.

## Authentication contract first

### 1. Verified identity seam

- Issue/tier/size: forge-1012; security; 180 lines. Depends on: none.
- Goal/files: define exact issuer plus subject and an injected `IdentityVerifier` in new `src/ports/identity.ts`; add a test-only verifier and `test/contract/identity.test.ts`.
- Acceptance: 2 issuers with the same subject remain distinct; empty subject, wrong audience and expired proof fail. Unknown proof cannot become a principal. Entire suite runs offline in CI with no account or provider package.

### 2. Public-to-team dependency guard

- Issue/tier/size: forge-1054; security; 240 lines. Depends on: 1.
- Goal/files: extend `test/structure/lib/imports.ts`; add `test/structure/team-boundary.integration.test.ts` and bad-import fixtures. Define `team/` as the removable implementation boundary.
- Acceptance: reject static/type imports, re-exports, dynamic imports, aliases and a barrel path from public code into team code; reject nonliteral loading at composition boundaries. Public package smoke works with `team/` absent. The guard fails on each motivating fixture.

### 3. Configured OIDC verifier

- Issue/tier/size: forge-1012; security; 280 lines. Depends on: 1.
- Goal/files: add `src/adapters/oidc/{index.ts,adapter.json}` and `test/adapters/oidc/verify.test.ts`; update `docs/dependencies.md` only if a verifier dependency is needed.
- Acceptance: locally signed tokens pass for configured issuer/audience/algorithm; wrong issuer, forged signature, expired token, token-supplied key URL and unbounded refresh fail. Test rotated keys and one-refresh unknown-key refusal with an injected HTTP port.

### 4. Device login challenge

- Issue/tier/size: forge-1012; security; 260 lines. Depends on: 1, 3.
- Goal/files: add open `cloud/src/auth/device-login.ts` and `test/cloud/auth/device-login.test.ts`; expose an injected identity-to-device issuance callback.
- Acceptance: challenge expiry, polling limits and explicit human approval precede single redemption; a second device cannot redeem the first device's result. No raw provider credential reaches the result or logs.

### 5. OAuth authorization-server adapter

- Issue/tier/size: forge-1012; security; 290 lines. Depends on: 1, 3.
- Goal/files: add `src/adapters/workers-oauth/{index.ts,adapter.json}`, `test/adapters/workers-oauth/flow.test.ts`; update `cloud/package.json`, its lockfile and `docs/dependencies.md` for a pinned provider package.
- Acceptance: fake upstream and in-memory storage prove PKCE S256, exact redirect, consent/deny, callback state and audience/resource binding; reused code, absent verifier and cross-client callback fail. Keep protocol behavior inside the dependency adapter.

### 6. Clerk upstream binding

- Issue/tier/size: forge-1012; security; 240 lines. Depends on: 3, 5.
- Goal/files: add `src/adapters/clerk/{index.ts,adapter.json}` and `test/adapters/clerk/upstream.test.ts`; use configured OIDC verification without a Clerk-specific person key.
- Acceptance: recorded fake upstream responses produce the same identity contract as a second issuer; active-org/email/display changes cannot grant project access. Consent denial and provider outage fail closed. No Clerk account is required for this suite.

### 7. Worker and remote MCP identity composition

- Issue/tier/size: forge-1012; security; 280 lines. Depends on: 4, 5, 6.
- Goal/files: add open `cloud/src/auth/compose.ts`, `src/ports/authorization.ts` and `test/cloud/auth/composition.test.ts`; adapt the factory in `cloud/src/worker.ts`.
- Acceptance: fake Worker requests and MCP calls receive verified identities only through the configured verifier; wrong-resource credentials and forged headers fail. Open single-owner behavior passes without a team build; missing team authorization never allows a team request.

## Membership, then person-bound credentials

### 8. Stable people and organization membership

- Issue/tier/size: forge-1054; security; 280 lines. Depends on: 1, 2, 3.
- Goal/files: add `team/identity.ts`, `team/directory.ts`, `team/migrations.ts` and `test/team/directory.test.ts` for stable person/org IDs and 1 default team per organization.
- Acceptance: issuer/subject mapping is unique, email collisions never merge people, last-owner removal fails, and org administration grants no content access. Use only the test verifier.

### 9. Explicit project grants and team composition

- Issue/tier/size: forge-1054; security; 290 lines. Depends on: 7, 8.
- Goal/files: add `team/authorization.ts`, `team/cloud/worker.ts`, `team/project-binding.ts`, `test/team/grants.test.ts`; extend public factory injection in `cloud/src/project.ts` only if needed.
- Acceptance: two organizations cannot read or mutate each other's project; a viewer reads but cannot write; org admin without an explicit grant cannot dump/status/read counts. Copied manifests do not grant access. Existing admin bearer cannot bypass team grants. Manifest fields stay unchanged.

### 10. Membership propagation and fencing

- Issue/tier/size: forge-1054; security; 290 lines. Depends on: 9.
- Goal/files: add `team/membership.ts`, `team/projection.ts` and `test/team/removal.test.ts` for idempotent changes, project acknowledgements and expiring authorization projections.
- Acceptance: role reduction fences the next commit; partition reports removal pending and the stale project refuses access after its 60-second freshness lease. Completion requires every affected project's acknowledgement or fail-closed state. Audit records no secret or content body.

### 11. Person-bound device token records

- Issue/tier/size: forge-1055; security; 280 lines. Depends on: 7, 9, 10.
- Goal/files: add `team/credentials.ts`, extend `team/migrations.ts`, adapt `cloud/src/tokens.ts` through an open authorization hook, and add `test/team/devices.test.ts`.
- Acceptance: bind person/org/project/device/scope/epochs and store only token hashes; spoofed actor/session/harness labels cannot impersonate. Old single-owner token fixtures still pass, but legacy tokens cannot authorize team routes without enrollment.

### 12. Narrow agent-session exchange

- Issue/tier/size: forge-1055; security; 260 lines. Depends on: 11.
- Goal/files: add `team/sessions.ts` and `test/team/sessions.test.ts`; bind parent credential and stable execution session.
- Acceptance: effective scope intersects requested, parent and current grants; expiry is at most 15 minutes and never beyond parent expiry. Reject membership, restore and approval delegation. Rotation changes credential ID without transferring the held session.

### 13. Revocation cascade and commit-time recheck

- Issue/tier/size: forge-1055; security; 290 lines. Depends on: 10, 11, 12.
- Goal/files: add `team/revocation.ts`, adapt pre-commit authorization injection in `cloud/src/project.ts`, and add `test/team/revocation-race.test.ts`.
- Acceptance: pause body streaming, revoke, resume and require no accepted write; device revoke invalidates only its descendants, while person removal fences all their project sessions. Expiry and saved-result replay never renew authority. Assert no await between final authorization and commit.

### 14. Keychain and agent broker contract

- Issue/tier/size: forge-1055; security; 220 lines. Depends on: 4, 12.
- Goal/files: add `src/ports/credentials.ts`, `src/assembly/credential-broker.ts` and `test/assembly/credential-broker.test.ts` for vault-backed devices and a private agent channel.
- Acceptance: a fake vault round-trips a device secret; a failed/locked vault returns unavailable with no file fallback. Spawn arguments, logs, errors and prompts contain no secret; child delivery expires and cannot outlive the parent.

### 15. Windows credential vault

- Issue/tier/size: forge-1055; security; 280 lines. Depends on: 14.
- Goal/files: add `src/adapters/keychain/{windows.ts,adapter.json}` and `test/adapters/keychain/windows.test.ts`; use the existing owned platform boundary rather than shell interpolation.
- Acceptance: fake native calls prove store/read/delete, locked-vault refusal, per-user isolation and exact service/account binding. No secret enters process arguments or stdout. Flag interactive OS readback as release evidence still pending.

### 16. macOS credential vault

- Issue/tier/size: forge-1055; security; 260 lines. Depends on: 14, 15.
- Goal/files: add `src/adapters/keychain/macos.ts`, extend its adapter metadata and add `test/adapters/keychain/macos.test.ts` using an injected platform port. Any native FFI call stays behind the existing dependency owner, injected by assembly.
- Acceptance: fake Keychain calls prove store/read/delete and denied-access behavior without credential arguments, prompts or plaintext fallback. Run the shared vault contract suite. Require later interactive OS readback.

### 17. Linux vault and login assembly

- Issue/tier/size: forge-1055; security; 290 lines. Depends on: 14, 15, 16.
- Goal/files: add `src/adapters/keychain/linux.ts`, `test/adapters/keychain/linux.test.ts`; wire `src/assembly/credential-broker.ts` and `src/assembly/identity.ts` to the selected vault and login contract.
- Acceptance: fake Secret Service proves store/read/delete; headless or locked service returns unavailable. Injected end-to-end login stores one device credential and issues one narrower agent session without changing local-only session labels. Require later interactive OS readback.

## Shared commands, cache and lanes

### 18. Async project command and query seam

- Issue/tier/size: forge-1056; security; 250 lines. Depends on: 9, 13.
- Goal/files: add `src/ports/project-commands.ts`, `team/commands/dispatch.ts`, `team/queries.ts` and `test/team/commands/dispatch.test.ts`; adapt `src/assembly/state-client.ts` at the command boundary.
- Acceptance: only versioned allowlisted commands reach the server owner; raw SQL, unknown commands and caller code fail. A disconnected command cannot fall back to the local writer. Synchronous state transactions contain no network call.

### 19. Issue allocation and revisioned edits

- Issue/tier/size: forge-1056; security; 290 lines. Depends on: 18.
- Goal/files: add `team/commands/issues.ts`, `test/team/commands/issues.test.ts`; extract the needed provider-neutral entry seam in `src/blocks/work/entry.cts` and its declared schemas.
- Acceptance: two devices create distinct final IDs; expected-revision mismatch preserves the current record. Assignee and active executor remain separate. Mutation, authenticated event and scoped request result commit together or all roll back.

### 20. Graph and parent validation

- Issue/tier/size: forge-1056; security; 260 lines. Depends on: 19.
- Goal/files: add `team/commands/graph.ts`, `test/team/commands/graph-race.test.ts`; reuse work-block graph validation through its public command seam.
- Acceptance: simultaneous graph edits that would create a cycle cannot both commit; parent and dependency changes validate current read sets. Reject cross-project references without revealing hidden titles or existence.

### 21. Comments, links and checkpoints

- Issue/tier/size: forge-1056; security; 280 lines. Depends on: 19.
- Goal/files: add `team/commands/appends.ts` and `test/team/commands/appends.test.ts`; extend work schemas only for server-authenticated provenance.
- Acceptance: timeout after commit plus same-ID retry creates 1 append/event; changed input under that ID fails. Server acceptance time differs from client draft time; untrusted text cannot alter attribution or issue access.

### 22. Lease competition and request reconciliation

- Issue/tier/size: forge-1056; security; 280 lines. Depends on: 13, 18, 19.
- Goal/files: add `team/commands/leases.ts`, `test/team/commands/lease-race.test.ts`; adapt request scoping in `cloud/src/project.ts`.
- Acceptance: 100 simultaneous cross-device claims grant exactly 1 holder. Saved grants fail after expiry, takeover or authority-epoch change; same request reconciles an uncertain result without a second effect. Check current access before disclosing any saved outcome.

### 23. Close preparation with fail-closed acceptance

- Issue/tier/size: forge-1056; security; 220 lines. Depends on: 19, 21, 22.
- Goal/files: add `team/commands/close.ts`, `test/team/commands/close-pending.test.ts`; expose a provider-neutral final-close predicate from `src/blocks/work/entry.cts`.
- Acceptance: validate expected revision, held generation and project binding, then refuse close until task 33 installs policy/evidence verification. A client cannot bypass through unrestricted `withoutReceipt`, a legacy route or missing provider.

### 24. Access-filtered project pull

- Issue/tier/size: forge-1057; security; 280 lines. Depends on: 18, 19, 21.
- Goal/files: extend `team/queries.ts`; add `team/cursors.ts` and `test/team/pull.test.ts` for bounded snapshots/deltas.
- Acceptance: cursor binds person/project/access epoch/authority epoch and server sequence. A cursor from another user or epoch fails; filtering precedes snippets, counts and pagination. Retried pages preserve a consistent high-water mark or demand a clean restart.

### 25. Disposable read cache

- Issue/tier/size: forge-1057; security; 260 lines. Depends on: 24.
- Goal/files: add `team/cli/cache.ts`, `team/cli/compose.ts`, `test/team/cache.test.ts`; inject through `src/assembly/state.ts` and `src/assembly/levels.ts`.
- Acceptance: cache key includes person/project/access/authority epochs; display last contact and staleness. Rebuild loses no pending proposal, and reconnect purges revoked visibility before serving refreshed reads. A stale cache grants no mutation authority.

### 26. Durable append proposals and reconnect

- Issue/tier/size: forge-1057; security; 290 lines. Depends on: 21, 24, 25.
- Goal/files: add `team/cli/outbox.ts`, `team/cli/reconnect.ts` and `test/team/reconnect.test.ts`.
- Acceptance: persist request ID before send, reconcile uncertain results, retain both stale drafts and map temporary IDs after acceptance. Queue create/comment/evidence/decision proposals only; never claim, close, approve, activate policy or mutate graph offline. Removed access cannot reroute queued secrets to another project.

### 27. Shared lane capacity and fairness

- Issue/tier/size: forge-1058; security; 280 lines. Depends on: 19, 22.
- Goal/files: add `team/lanes.ts`, `team/fairness.ts` and `test/team/lane-capacity.test.ts`; add reservation schemas in team modules.
- Acceptance: competing starts at the last project slot admit 1 reservation. All devices share the person's cap; deterministic per-person FIFO and round-robin admission prevent one person's agents from taking every queued turn. Device load may refuse locally without creating a second authority.

### 28. Reserve, local Git effect and acknowledge

- Issue/tier/size: forge-1058; security; 290 lines. Depends on: 27.
- Goal/files: add `team/cli/lane-start.ts`, `test/team/lane-start.test.ts`; adapt the public lane seam in `src/blocks/work/entry.cts` and lane input schemas.
- Acceptance: crash after worktree creation is adoptable with the same reservation ID and no double count. Local paths and process locks stay local. Failed local Git work cancels or leaves an explicit recoverable reservation.

### 29. Handoff and interrupted lane recovery

- Issue/tier/size: forge-1058; security; 270 lines. Depends on: 10, 13, 28.
- Goal/files: add `team/lane-recovery.ts`, `test/team/lane-recovery.test.ts`; adapt existing local cleanup-journal calls through the public seam.
- Acceptance: removal/offline expiry refuses renewal while preserving commits. Authorized handoff increments generation, fences the old session and never deletes another device's files. Release still checks issue-close prerequisites.

## Policy, approval, evidence and memory

### 30. Accepted team policy constraints

- Issue/tier/size: forge-1059; security; 290 lines. Depends on: 9, 18, 23.
- Goal/files: add `team/policy.ts`, `test/team/policy.test.ts`; inject generic constraints into `src/core/config/layers.ts` and `src/core/config/laws.ts` through the open authorization contract.
- Acceptance: bind activation to approved Git commit and exact policy digest; a personal/invocation override, missing enforcing block or changed command cannot weaken it. Stricter local limits pass. Weakening stays pending independent approval from task 31.

### 31. Authenticated human approval and exceptions

- Issue/tier/size: forge-1059; security; 290 lines. Depends on: 10, 12, 30.
- Goal/files: add `team/approvals.ts`, `test/team/approvals.test.ts`; extend `src/assembly/approval.ts` only with a provider-neutral verifier hook.
- Acceptance: maintainer capability covers ordinary exceptions; protected actions require a different authenticated human. Bind nonce, action/input/head/policy/epochs and expiry; consume once in acceptance. Author, same-sponsor agent, replay and removed approver fail. No eligible approver means pause.

### 32. Registered runner attestations

- Issue/tier/size: forge-1059; security; 290 lines. Depends on: 13, 30.
- Goal/files: add `team/evidence.ts`, `team/runners.ts`, `test/team/evidence.test.ts`; expose generic evidence verification in `src/blocks/check/receipt.ts` and `src/blocks/check/entry.cts`.
- Acceptance: attest project/repo/head/input/command/policy with enrolled runner identity; forged PASS, cross-project receipt and mismatched snapshot fail. Runner revocation and trust class affect current eligibility. Historical provenance survives member removal without implying current approval eligibility.

### 33. Final protected close gate

- Issue/tier/size: forge-1059; security; 280 lines. Depends on: 23, 30, 31, 32.
- Goal/files: complete `team/commands/close.ts`, add `test/team/commands/close-race.test.ts`; wire the public work/check acceptance predicate.
- Acceptance: after asynchronous PR/head lookup, recheck all grants, policy, approver and fences in the commit transaction. Two closes create 1 accepted close event. Changed head, cross-project evidence and an unrestricted exception fail. Return current state on same-ID reconciliation.

### 34. Explicit memory publication

- Issue/tier/size: forge-1060; security; 270 lines. Depends on: 13, 24, 26, 30, 31.
- Goal/files: add `team/memory-publish.ts`, `test/team/memory-publish.test.ts`; expose generic publication hooks in `src/blocks/memory/index.cts` and memory schema inputs.
- Acceptance: exact source revision, consent and destination grant precede publication. Matching scope never uploads device notes or transcripts. Stale source or changed policy refuses adoption; restricted content requires a separate project.

### 35. Authorized memory reads on every surface

- Issue/tier/size: forge-1060; security; 290 lines. Depends on: 24, 25, 34.
- Goal/files: add `team/memory-query.ts`, `test/team/memory-query.test.ts`; bind `src/assembly/levels.ts` and `templates/delivery/harness/memory-start.mjs` through authorized query contracts.
- Acceptance: unauthorized show/search/count/snippet/peer/startup/export paths disclose no note content or existence. A second project needs its own grant. Startup consumes only filtered results; an agent cannot widen the query through a scope label.

### 36. Removal purge and truthful forget

- Issue/tier/size: forge-1060; security; 240 lines. Depends on: 10, 25, 35.
- Goal/files: add `team/memory-purge.ts`, `test/team/memory-purge.test.ts`; document serving purge and retained history in `docs/reference/cloud.md`.
- Acceptance: removed member loses server access; reconnect purges served cache/search material. Forget removes active serving entries and produces content-minimal audit, while explicitly reporting event/backup retention. Do not claim erasure of downloaded copies or historical plaintext.

## Recovery and combined proof

### 37. Versioned team export envelope

- Issue/tier/size: forge-1061; security; 270 lines. Depends on: 29, 33, 36.
- Goal/files: add `src/ports/authority.ts`, `team/recovery/export.ts`, `test/team/recovery/export.test.ts`; add generic hooks to `cloud/src/dump.ts`.
- Acceptance: paged envelope includes tenant/project lineage, sequences and verified schema references; no token, hash, private device note or upstream credential is exported. Access and high-water mark are rechecked; retain current byte/row bounds.

### 38. Empty-target restore with a fresh epoch

- Issue/tier/size: forge-1061; security; 290 lines. Depends on: 37.
- Goal/files: add `team/recovery/restore.ts`, `test/team/recovery/restore.test.ts`; adapt activation hooks in `cloud/src/project.ts` and `cloud/src/dump.ts`.
- Acceptance: every team row/reference validates before visibility; last-page fault exposes no partial project. Imported leases, approvals, cursors, request results and credentials grant no authority. Current destination grants and a new epoch are required; a nonempty target fails.

### 39. One-writer personal-to-team cutover

- Issue/tier/size: forge-1061; security; 280 lines. Depends on: 38.
- Goal/files: add `team/recovery/cutover.ts`, `test/team/recovery/cutover.test.ts`; extend `docs/reference/cloud.md` with freeze, verification, activation and reverse paths.
- Acceptance: compare every imported table's counts/digests, retain unverified legacy attribution, and activate 1 writer. A pre-activation fault reopens only the source; a post-activation fault requires target freeze/delta reconciliation/new epoch. Never revive the stale source automatically.

### 40. Conservative quotas and licensed composition

- Issue/tier/size: forge-1061; security; 290 lines. Depends on: 27, 37, 38.
- Goal/files: add `team/admission.ts`, `team/entitlement.ts`, `test/team/admission.test.ts`; update the team build composition and recovery runbook.
- Acceptance: reserve bounded safety headroom for events, audit and request results before reaching 10,000 rows/table or 8 MiB stored. Quota/entitlement failure blocks new commercial admission but preserves release/revoke/export/recovery and reserved completion. Missing enterprise license refuses new self-hosted team admission; open single-owner functionality has no license dependency.

### 41. Packaged two-person and alternate-issuer journey

- Issue/tier/size: forge-1061; security; 290 lines. Depends on: 17, 20, 26, 29, 33, 36, 39, 40.
- Goal/files: add `test/team/packed.integration.test.ts`, `test/team/fixtures/journey.ts` and `team/README.md`; package the team composition against public exports and record release gaps.
- Acceptance: run every scenario in the plan's 2-organization/2-member/third-principal journey, including 100 claim racers, lane crash, offline conflict, independent approval, one close, removal during a request and fresh-epoch restore. Repeat with non-Clerk OIDC. Break grant/fence/receipt checks individually and require the journey to fail. Public package smoke omits `team/`. Mark hosted sign-in, deployed-runtime behavior and desktop keychain readback unverified until separately proved; forge-1077 blocks release.

## Coverage and handoff

| Issue      | Tasks      | Exit condition                                                                        |
| ---------- | ---------- | ------------------------------------------------------------------------------------- |
| forge-1012 | 1, 3 to 7  | Account-free identity, login and OAuth/MCP contracts; hosted proof explicitly pending |
| forge-1054 | 2, 8 to 10 | Import guard, explicit project grants and acknowledged removal                        |
| forge-1055 | 11 to 17   | Person-bound credentials, cascade and vault-backed broker contracts                   |
| forge-1056 | 18 to 23   | Typed commands, fenced leases and unavailable-until-verified close                    |
| forge-1057 | 24 to 26   | Filtered reads, disposable cache and separate durable proposals                       |
| forge-1058 | 27 to 29   | Fair project reservations, local effects and fenced handoff                           |
| forge-1059 | 30 to 33   | Accepted policy, independent approval, trusted evidence and complete close            |
| forge-1060 | 34 to 36   | Explicit publication, authorized reads and serving purge                              |
| forge-1061 | 37 to 41   | Bounded recovery, one-writer cutover and combined fixture proof                       |

All tasks already have an issue. No new child issue, claim, release or close is part of this docs lane. Record implementation evidence against each mapped issue, including all acceptance cases, artifacts, decisions and next step. The lead owns lease state and merge. Before release, complete forge-1077 and the separately authorized live/desktop proof; passing fixtures alone does not close those gaps.
