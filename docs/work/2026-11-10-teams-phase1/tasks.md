2026-11-11 (forge-1198): rewritten for open-source teams. The earlier 41 tasks, the closed-layer and enterprise-license release gate (forge-1077, closed as superseded) and the entitlement task are dropped. See [the plan](plan.md).

# Team phase 1 ordered tasks

Decisions needed: none.

## Before teams

Do not start task 1 until forge-1206 to forge-1210 (the forge-1203 cloud CLI slices) are merged and the owner works on 2 machines through the cloud. Those slices own login, `fct_` tokens, the command route and the lease client. Tasks below extend them and add no second login path.

## Phase 1: 2 people, 1 project

Each numbered task is 1 PR with a ceiling of 300 changed lines, including tests, schemas and documentation. The tier is **security** for every task because each changes authentication, authorization, accepted authority or data exposure. Estimated sizes are budgets, not measured diffs. If the concrete patch exceeds its budget, split that task under the same issue and keep its refusal tests. A listed file is proposed, not a claim that it exists. Members are people on one project; there are no organizations.

For each task: show the named negative case failing before the change (red in CI), implement the minimum change, then show positive and negative cases passing. Inject time, HTTP and platform ports. Run no tests locally; CI is the test gate. No task authorizes accounts, resources, deployment or live migration. Do not claim released team behavior from CI fixtures.

Task numbers define a valid serial order. Core never imports `team/`; the existing `test/structure/team-boundary.integration.test.ts` enforces that layering rule and stays frozen.

### 1. Project members and roles

- Issue/tier/size: forge-1054; security; 270 lines. Depends on: forge-1210.
- Goal/files: add a project member list (person ID, role owner, member or viewer) and the owner's add command in `team/members.ts`, reusing person records from `team/directory.ts`; test in `test/team/members.test.ts`.
- Acceptance: the same issuer plus subject maps to 1 person; an email collision never merges people; removing the last owner fails; the member list is not in the committed manifest.

### 2. Installed team authorization

- Issue/tier/size: forge-1054; security; 280 lines. Depends on: 1.
- Goal/files: add `team/authorization.ts` implementing `AuthorizationPort` (`src/ports/authorization.ts`) by project membership, and install it through the optional `team` argument in `cloud/src/auth/compose.ts`; test in `test/team/authorization.test.ts`.
- Acceptance: a viewer reads but cannot write; a non-member gets no content, counts or existence; the single-owner default still refuses a team request when no team policy is installed (`TEAM_AUTHORIZATION_UNAVAILABLE`); the existing admin bearer cannot bypass membership.

### 3. Removal fencing

- Issue/tier/size: forge-1054; security; 240 lines. Depends on: 1, 2.
- Goal/files: add `team/removal.ts` and an authority epoch in the project record, bumped in the same transaction that removes a member; test in `test/team/removal.test.ts`.
- Acceptance: removal fences the next commit on every device and session of that person; role reduction takes effect on the next commit; audit records hold no secret or content body.

### 4. Person-bound device tokens

- Issue/tier/size: forge-1055; security; 280 lines. Depends on: 2.
- Goal/files: add `team/credentials.ts`; adapt `cloud/src/tokens.ts` through an authorization hook so forge-1207 approval records the approving person on the `fct_` token; test in `test/team/devices.test.ts`.
- Acceptance: a token binds person, project, device and epoch and stores only the hash; spoofed actor, session or harness labels cannot impersonate; legacy owner tokens keep working for the single-owner path but cannot pass team authorization without a person.

### 5. Narrow agent session exchange

- Issue/tier/size: forge-1055; security; 250 lines. Depends on: 4.
- Goal/files: add `team/sessions.ts`; test in `test/team/sessions.test.ts`.
- Acceptance: effective scope intersects requested scope, parent grant and current role; expiry is at most 15 minutes and never beyond the parent; membership change and approval cannot be delegated; rotation changes the credential ID without transferring the held session.

### 6. Revocation cascade and commit-time recheck

- Issue/tier/size: forge-1055; security; 290 lines. Depends on: 3, 5.
- Goal/files: add `team/revocation.ts` and a pre-commit authorization hook in `cloud/src/project.ts`; test in `test/team/revocation-race.test.ts`.
- Acceptance: pause body streaming, revoke or remove, resume, and no write is accepted; device revoke affects only its descendants; a saved-result replay never renews authority; no await sits between the final check and commit.

### 7. Revisioned issue edits, graph and appends by member

- Issue/tier/size: forge-1056; security; 290 lines. Depends on: 6.
- Goal/files: extend `cloud/src/issue-commands.ts` (forge-1209) with parent and dependency edits, close preparation and server-derived provenance through `team/commands/`; test in `test/team/commands/issues.test.ts`.
- Acceptance: simultaneous edits that would form a cycle cannot both commit; a stale revision keeps the current record; a comment retry with the same ID creates 1 append; untrusted text cannot change attribution; close stays unavailable until task 11.

### 8. Lease competition across people

- Issue/tier/size: forge-1056; security; 270 lines. Depends on: 6, 7.
- Goal/files: add `team/commands/leases.ts`; adapt request scoping in `cloud/src/project.ts`; test in `test/team/commands/lease-race.test.ts`.
- Acceptance: 100 simultaneous claims from 2 people on 3 sessions grant exactly 1 holder; a saved grant fails after expiry, takeover or epoch change; assignee and active executor stay separate.

### 9. Filtered pull, disposable cache and offline proposals

- Issue/tier/size: forge-1057; security; 290 lines. Depends on: 7.
- Goal/files: add `team/queries.ts`, `team/cursors.ts` and `team/cli/outbox.ts`; test in `test/team/pull.test.ts` and `test/team/reconnect.test.ts`.
- Acceptance: a cursor binds person, project, epoch and server sequence, and fails for another person; filtering precedes counts and snippets; the cache is keyed by person, project and epoch and holds no mutation authority; a queued create or comment survives a restart and reconciles after reconnect; claim, close and approve are refused offline.

### 10. Independent human approval

- Issue/tier/size: forge-1059; security; 280 lines. Depends on: 6.
- Goal/files: add `team/approvals.ts`; extend `src/assembly/approval.ts` only with a provider-neutral verifier hook; test in `test/team/approvals.test.ts`.
- Acceptance: a protected action needs a different authenticated human; nonce, action, input, head and epoch are bound and consumed once; the author, the author's other agent, a replay and a removed approver all fail; no eligible approver means the action pauses.

### 11. Protected close

- Issue/tier/size: forge-1059; security; 270 lines. Depends on: 7, 10.
- Goal/files: complete `team/commands/close.ts` and wire the public work/check acceptance predicate; test in `test/team/commands/close-race.test.ts`.
- Acceptance: after the asynchronous PR and head lookup, membership, approver and epoch are rechecked in the commit transaction; 2 closes create 1 accepted close event; a changed head or a client-side exception fails. The close trusts a member's receipt; runner attestation is deferred.

### 12. Two-person journey

- Issue/tier/size: forge-1061; security; 290 lines. Depends on: 8, 9, 11.
- Goal/files: add `test/team/packed.integration.test.ts` and `test/team/fixtures/journey.ts`; package the open and team compositions and record unverified gaps.
- Acceptance: 1 project with 2 members and an unauthorized third principal; 100 claim racers, an offline conflict, independent approval, 1 close and a member removed mid-request; repeat with a non-Clerk OIDC issuer; break each of the grant, epoch and approval checks in turn and require the journey to fail. Mark hosted sign-in and deployed-runtime behavior unverified.

## Deferred until 2 people use it

| Deferred scope                                       | Line                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Organizations and org roles                          | Project members cover 2 people; add organizations when groups or projects multiply.        |
| 3 OS keychain adapters (Windows, macOS, Linux)       | The private credential file from forge-1208 serves the owner; add one vault at a time.     |
| Runner attestations                                  | Task 11 trusts a member's receipt; enroll runners when a second person's evidence matters. |
| Team memory (publication, authorized reads, purge)   | Notes stay private until a member asks to share them.                                      |
| Cutover and quotas                                   | The owner's data move is forge-1203 cutover; quotas wait for real load.                    |
| Shared lane capacity and fairness                    | A 2-person project needs no round-robin queue.                                             |
| Team policy constraints and versioned export/restore | Use the existing single-owner dump and restore until 2 people depend on it.                |

## Coverage and handoff

| Issue      | Tasks  | Exit condition                                                 |
| ---------- | ------ | -------------------------------------------------------------- |
| forge-1054 | 1 to 3 | Project members, installed authorization and removal fencing   |
| forge-1055 | 4 to 6 | Person-bound tokens, agent sessions and commit-time revocation |
| forge-1056 | 7, 8   | Revisioned member commands and fenced lease competition        |
| forge-1057 | 9      | Filtered pull, disposable cache and offline proposals          |
| forge-1059 | 10, 11 | Independent approval and the protected close                   |
| forge-1061 | 12     | Combined 2-person fixture proof                                |

forge-1058 and forge-1060 stay open with their scope deferred. All tasks already have an issue. No new child issue, claim, release or close is part of this docs lane. Record implementation evidence against each mapped issue, including acceptance cases, artifacts, decisions and next step. The lead owns lease state and merge. Passing fixtures does not close the hosted and desktop proof gaps.
