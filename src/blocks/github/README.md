# GitHub provider

`forge/github` is the provider for the generic pull request block. GitHub API
logic stays here. It uses the configured executable through the supervised
process port, argv arrays and JSON stdin. The host supplies the canonical
project root through `process.cwd` and selects only the configured environment names; this block does not discover credentials, infer
an account or change global `gh` authentication.

`github.status` and `github.use` verify `/user` against an explicit account
and host from config or host `identity`. They are observational validation
operations. A different authenticated login is `IDENTITY_MISMATCH` before
any provider mutation. Conflicting host/config identity is refused.

`github.read` accepts only `{ "action": "status", "payload": {
"repository": "owner/repo", "number": 42 } }`. It declares `external:process` and `environment:read`, without a domain or external mutation effect.
GraphQL queries collect core state, the exact-head check rollup, reviews,
threads and labels. Every connection has validated page information, totals,
unique node identities and bounded cursor progress. Missing/unreadable pages
are `INCOMPLETE`; they never become an empty clean result. Required checks
include classic branch protection and effective ruleset checks. The block
re-reads core/protection and required checks after collection and refuses
changes during the observation. Review and latest-thread-comment edits
contribute to the activity timestamp. Configured blocking labels are
returned as unresolved findings; `forge/pr` supplies their merge policy.

`github.call` declares `github:write` and `external:write`. It accepts only
these catalog-described actions:

| Action    | Behavior                                                                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`  | Create with explicit title, body, head, base and draft selection; return a validated PR link.                                                                                                                                                  |
| `reply`   | Verify that the exact `threadId` belongs to the PR, then reply to that thread.                                                                                                                                                                 |
| `resolve` | Verify that the exact `threadId` belongs to the PR, then resolve only that thread.                                                                                                                                                             |
| `rerun`   | Verify the specific workflow run belongs to this PR and current head, then rerun its failed jobs.                                                                                                                                              |
| `merge`   | Low-level conditional REST squash merge with the explicit expected SHA, title and body. Refuse coauthor trailers. Lease and computed merge policy belong to `pr.merge`; granting this low-level operation authorizes direct provider mutation. |

No operation exposes a generic API path, shell command, resolve-all, force
push or account switch. Failed/timed-out/truncated mutation responses are
`EFFECT_UNCERTAIN` and require a read/reconcile step. Mutations are never
automatically retried. Provider stderr and error bodies are not returned.

## Explicit configuration

| Key              | Meaning and bounds                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `envNames`       | Required explicit environment-variable names, at most 256 names of at most 256 characters. Empty selects none. PATH, PATHEXT, platform and auth variables must be named when needed. |
| `executable`     | Required provider executable path/name, 1–4096 characters. Missing is typed `UNAVAILABLE` with an installation/provider-selection remedy.                                            |
| `account`        | Exact provider login, up to 39 characters. Required here or through host `identity`; never guessed.                                                                                  |
| `host`           | Provider hostname, up to 253 characters. Required here or through host `identity`; no URL, userinfo, path or port is accepted.                                                       |
| `timeoutMs`      | Required per-command timeout, 1–300000 ms, capped by the remaining invocation deadline.                                                                                              |
| `maxOutputBytes` | Required process-output budget, 1024–1048576 bytes. Truncation is refused.                                                                                                           |
| `pageSize`       | Required connection/REST page size, 1–100.                                                                                                                                           |
| `maxPages`       | Required per-connection page cap, 1–100. Exhaustion is incomplete, including a full final REST page whose end has not been established.                                              |

Unknown config keys are rejected. Config and accepted state contain no
credentials. Only the host-selected invocation environment may contain auth
material. Git location/config injection variables and provider debug/repo
overrides are filtered; terminal prompts and interactive pagination are
disabled. Commands use the exact invocation signal and cannot outlive their
scope. No pool, daemon, watcher or cache is introduced.

Repository casing is canonicalized for shared PR identity. Account routing
and credential acquisition are intentionally owned by the separate accounts
block. Installed fake-provider journeys exercise these mechanisms without
live GitHub mutations.
