# 0003 — GitHub as identity/auth for team mode

**Date**: 2026-07-09
**Status**: proposed

## Context

Local Forge has no real actor identity: writes are attributed to a loosely
supplied `actor` string, and there is no verified provenance tying a kernel
mutation to a real person (the actor-identity gap, kernel `d71a824b`). Team mode
(ADR-0002) introduces a shared libSQL server with per-project namespaces, which
needs (1) a way to identify the human at the CLI, (2) repo-scoped server access
that is not a personal long-lived token, (3) an authorization boundary for who
may read/write a project, and (4) scoped credentials to mint per-namespace access
to the server.

Forge already lives inside GitHub: repos, org membership, and the PR workflow are
the existing collaboration substrate. Building a bespoke identity system would
duplicate all of that.

## Decision

Use **GitHub as the identity and authorization provider for team mode.**

- **Human identity — OAuth device flow.** The CLI identifies the human via
  GitHub OAuth device flow (no browser redirect server needed for a CLI).
- **Server access — GitHub App.** The Forge server acts through a **GitHub App**
  with repo-scoped installation permissions, **not** a personal PAT — access is
  scoped to the repos/orgs where the App is installed and is independently
  revocable.
- **Actor model.** Actor = **GitHub identity + agent session-id**. The kernel
  `sessions` table already carries `actor` + `session_id`; team writes bind the
  GitHub identity to that session, giving verified provenance.
- **Authorization boundary.** **Repo / org membership is the team boundary** — a
  member's GitHub permission on the repo is the ACL for the corresponding
  project namespace.
- **Server credentials.** The GitHub-App identity layer **mints per-namespace
  libSQL JWTs** (ADR-0002 §C.2), so a client only ever holds a short-lived,
  namespace-scoped token.

## Consequences

- **Positive — reuse existing identity.** No bespoke user store, password reset,
  or invite system; teams are already on GitHub.
- **Positive — repo perms are the ACL.** Access control tracks GitHub
  membership automatically; removing someone from the repo removes their project
  access.
- **Positive — verified actor provenance.** Closes the actor-identity gap
  (`d71a824b`): every team write carries a GitHub-verified actor.
- **Trade-off — couples team mode to GitHub.** Mitigated by putting auth behind
  a provider seam so other OAuth/OIDC providers can be added later without
  touching the kernel.
- **Negative — GitHub App operational surface.** App registration, installation
  management, and token minting must be run and secured by the control plane.

## Alternatives considered

- **Custom auth (Forge-native accounts)** — rejected: rebuilds identity,
  membership, and invites that GitHub already provides, with no adoption benefit
  for a GitHub-resident audience.
- **Other OIDC providers (Google / Okta / GitLab)** — deferred, not rejected:
  added later behind the same provider seam once there is demand from non-GitHub
  teams.
- **Personal access tokens for server access** — rejected: long-lived,
  over-scoped, and not per-namespace; the GitHub App + minted JWTs are the
  scoped, revocable replacement.
