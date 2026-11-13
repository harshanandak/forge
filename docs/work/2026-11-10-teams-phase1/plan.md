2026-11-11 owner decisions (forge-1198, supersedes the closed-layer, enterprise-license and entitlement parts of this plan and closes forge-1077 as superseded): team features are open source under MIT like the core, no license or entitlement check exists anywhere, and only the hosted service is paid. The first real cloud user is the owner on 2 machines plus cloud agents on 1 project, delivered by forge-1203 slices forge-1206 to forge-1210. Refresh tokens (forge-1125) follow the CLI cloud client (forge-1210 and its cross-device proof). Competing attempts are frozen except for trials.

Decisions needed: none.

# Team phase 1 implementation plan

Let 2 people and their agents share 1 project through one connected authority, using project members. Keep every implementation PR at 300 changed lines or fewer, including tests and generated contract inputs. The ordered [task list](tasks.md) maps 12 PRs to forge-1054 through forge-1057, forge-1059 and forge-1061. This document approves no account creation, resource provisioning, deployment or migration of live data.

## Before teams

Teams wait for the owner's own cloud journey. forge-1203 delivers it in 5 slices: forge-1206 (device challenges and token delivery), forge-1207 (owner approval through Clerk), forge-1208 (`forge auth login` and private credentials), forge-1209 (first project-authority issue commands) and forge-1210 (CLI lease client and the 3-session proof on 2 machines). Its plan is the source for the login, token and command routes. Do not start a task below until forge-1210 shows the owner working on 2 machines through the cloud. Refresh tokens (forge-1125) come after forge-1210 and its cross-device proof are complete. This plan reuses those routes and adds no second login path.

## Scope and settled decisions

The November 10 owner decision in the fifth forge-1052 comment supersedes the paper's hosting recommendation. The second forge-1012 comment supplies auth option D. The 2026-11-11 decisions above replace the earlier licensing rows.

| Area        | Required behavior                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity    | Clerk signs in hosted humans. A configured OIDC verifier permits self-hosting without Clerk. Both feed the same verified issuer plus subject contract.   |
| Credentials | Forge mints a per-device `fct_` token, bound to a person once teams land, and derives short-lived agent credentials under an accountable person.         |
| Authority   | One connected authority accepts project commands. Local caches are disposable. Offline appends remain proposals.                                         |
| Access      | Project membership with a role (owner, member, viewer). No organizations in phase 1. Anyone not on the member list gets no content, counts or existence. |
| Approval    | A different authenticated human approves protected actions. An author's other agent cannot qualify.                                                      |
| Licensing   | MIT for everything, team code included. Team code is a layer inside this repo, not a separate product. Only the hosted service is paid.                  |

The [research paper](../2026-11-09-teams-research/options-paper.md) stays the source for feature scenarios and later phases.

## Evidence and current seams

Current-code evidence is rung 2, source inspection of this PR's base (`7570a014`). Proposed files and interfaces describe future implementation. No team runtime or live cloud journey is proved by this docs PR.

| Inspected file                                                                         | Observed behavior and implication                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ports/authorization.ts`                                                           | `AuthorizationPort.authorize` takes a principal, project, action and authority. The default `singleOwnerPolicy` refuses every `team` request with `TEAM_AUTHORIZATION_UNAVAILABLE`. Keep this seam and default; a team policy replaces it only when installed. |
| `cloud/src/auth/compose.ts`                                                            | Takes an optional `team` port and falls back to `singleOwnerPolicy` when it is absent. Installing a port is the only switch.                                                                                                                                   |
| `cloud/src/tokens.ts`                                                                  | Stores device-token hashes, labels, expiry and revocation. A device token binds a device, not a person. Add a person binding without reading labels as identity.                                                                                               |
| `cloud/src/project.ts`                                                                 | Rechecks token authorization after asynchronous body reads, then writes synchronously. Preserve that ordering for membership checks.                                                                                                                           |
| `src/ports/identity-mint.ts`, `test/structure/identity-provenance.integration.test.ts` | Only the OIDC adapters may mint a `VerifiedIdentity`. Keep this provenance guard; it is a security guard.                                                                                                                                                      |
| `src/adapters/oidc/`, `cloud/src/adapters/workers-oauth/`                              | The pluggable OIDC verifier, OAuth server and Clerk upstream exist. Phase 1 reuses them.                                                                                                                                                                       |
| `team/directory.ts`, `team/identity.ts`, `team/migrations.ts`                          | A person and organization directory exists. Phase 1 uses its person records and ignores its organization records.                                                                                                                                              |
| `test/structure/team-boundary.integration.test.ts`                                     | Rejects imports from open code into `team/`. Keep it as a layering rule (core never imports `team/`). Freeze it: no more PRs on it unless a real leak shows up.                                                                                                |
| `src/assembly/project-manifest.ts`                                                     | Accepts only schema, UUID and optional name. Keep membership and credentials out of the committed manifest.                                                                                                                                                    |
| `src/assembly/state-client.ts`                                                         | Binds synchronous state methods to a local owner. Use the asynchronous command client from forge-1210 rather than hiding HTTP in these methods.                                                                                                                |
| `src/assembly/approval.ts`                                                             | Binds local approval proofs to exact operations and inputs. Connected approval needs authenticated humans and current membership.                                                                                                                              |

## Order and account-free build boundary

1. Finish forge-1206 to forge-1210 first (see Before teams).
2. Add project members and the installed team authorization port (tasks 1 to 3). They need only the test verifier.
3. Bind device tokens and agent sessions to a person, then fence on removal (tasks 4 to 6).
4. Add the remaining typed issue commands, filtered pull and the offline proposal queue (tasks 7 to 9).
5. Add independent approval, the protected close and the 2-person journey (tasks 10 to 12).

All 12 tasks implement and test their contracts in CI without Clerk or Cloudflare accounts. Use injected clocks, locally generated OIDC signatures and keys, fake upstream HTTP, a fake Worker namespace and a disposable local database. Call Worker handlers as functions; do not invoke a deployment CLI.

CI PASS proves fixture behavior, rung 4. It does not prove hosted Clerk behavior, deployed Durable Object behavior under restart, or desktop sign-in. Record those as unverified until the owner supplies an environment through a separately authorized lane.

## Identity and credential contract

`IdentityVerifier.verify` accepts credential material through an injected transport and returns a verified identity with exact issuer, nonempty subject, audience, expiry and authentication time. Reject unsigned tokens, algorithm confusion, unknown key IDs after one refresh and a token-supplied key URL. Do not normalize issuer or subject into an email.

Map `(issuer, subject)` to a stable Forge person through `team/directory.ts`. Email, display name, Git author and `FORGE_SESSION` never supply this mapping. Derive audit actor and sponsor on the server, ignoring caller attribution fields.

Phase 1 reuses the forge-1207 device approval and forge-1208 private credential file. A device token gains a person ID when a member approves it. Proposed agent lifetime is 15 minutes, capped by parent expiry. Effective scope is the intersection of parent grant, current member role and requested scope. Exclude membership changes and approval from agent delegation. Revoking a device fences its descendants; removing a member fences every device and session of that person.

## Authorization, acceptance and revocation

The project stores its member list and an authority epoch. A member is a person ID plus a role. The owner adds and removes members. Removing the last owner fails. The committed manifest stays unchanged.

Removal marks the member removed and bumps the epoch in the same transaction that removes access. One project means one authority, so removal completes at once with no cross-project acknowledgement. A person on 2 machines loses both on the next commit.

Prepare network reads and cryptographic work before the project transaction. Inside one synchronous acceptance boundary, recheck membership, role, parent revocation, authority epoch, lease generation and read-set revisions, then atomically write mutation, event and idempotent result. No await may separate the final checks from commit.

Scope idempotency by project, person and epoch; fingerprint the operation and canonical input. Check current access before returning any saved result. Start close as unavailable until task 11 installs the approval predicate.

## Threat model

1. A non-member guesses the project ID: authorize before routing to content, counts, pages or exports.
2. A caller forges actor, email or harness labels: derive person and sponsor from the verified credential.
3. An attacker substitutes an issuer, audience or key URL: accept only configured trust roots.
4. An agent requests broader scope: intersect parent, member role and requested scope; exclude human-only actions.
5. A member is removed during body streaming: repeat membership checks at the synchronous commit.
6. A retry replays an old grant: scope requests to person and epoch and revalidate current access.
7. Two sessions race for a lease: serialize acceptance and bump the generation on takeover.
8. An offline client writes accepted state locally: refuse shared mutation and keep only labelled proposals.
9. An author uses their second agent as approver: compare authenticated humans and recheck eligibility at consumption.
10. A removed member keeps a cache: key caches by person, project and epoch, and purge on reconnect.

## Recovery and acceptance

Cache identity includes person, project, access epoch and authority epoch. Store append proposals separately. Reconnect refreshes access, purges lost visibility, pulls accepted state, then reconciles proposals. Preserve both versions on conflict. Never retry an uncertain mutation under a new request ID before querying the original result.

Task 12 packages the open and team compositions, creates 1 project with 2 members plus an unauthorized third principal, races 100 claims, reconciles an offline conflict, approves protected work independently, closes once and removes a member mid-operation. It repeats with a non-Clerk OIDC issuer. Record each scenario, counterfactual and exact package and head. Hosted sign-in and deployed-runtime behavior stay unverified until separately proved.

For this docs PR, run frozen install, format check and lint only. CI runs the repository's documentation checks. No local test suite, external account or infrastructure action belongs to this lane.

## Deferred until 2 people use it

Each item keeps its existing issue as owner. None blocks phase 1.

| Deferred scope                                       | Line                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Organizations and org roles                          | Start with project members; add organizations when a second project or group needs shared membership. |
| 3 OS keychain adapters (Windows, macOS, Linux)       | forge-1208 stores credentials in a private file; add the owner's platform vault first when needed.    |
| Runner attestations                                  | Close evidence trusts a member's receipt until a runner enrollment story exists.                      |
| Team memory (publication, authorized reads, purge)   | Device and project notes stay private until a member asks to share them.                              |
| Cutover and quotas                                   | The owner's data move is forge-1203's cutover; per-tenant quotas wait for real load.                  |
| Shared lane capacity and fairness                    | A 2-person project needs no round-robin; revisit when queues form.                                    |
| Team policy constraints and versioned export/restore | Use the existing single-owner dump and restore; add team metadata when 2 people depend on it.         |
| Guests, groups, hosted runners, external trackers    | Phase 2 and 3 of forge-1052.                                                                          |

No new child issues are needed: every task maps to an existing issue. Builders record scope, success criteria, constraints, edge cases and exclusions from the task before implementation. Each stage-exit comment records summary, decisions, artifacts and next, with the exact head and evidence rung. The lead retains claims, lane close and merge authority.
