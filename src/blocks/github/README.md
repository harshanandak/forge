# GitHub provider

`forge/github` is the provider for the generic pull request block. GitHub API
logic stays here. It uses the configured executable through the supervised
process port, argv arrays and JSON stdin. The host supplies the canonical
project root through `process.cwd` and selects only the configured environment names; this block does not discover credentials, infer
an account or change global `gh` authentication.

Accepted SHA fields are normalized to lowercase at the request and API boundaries, including expected head/base, commit observations, rerun heads and merge receipts. Other text, including explicit squash messages, is preserved.

Review collection requests `authorCanPushToRepository` and exposes `authorizing: true` only for a known, non-ghost author with a literal true value. Unknown authority supplies neither an approval nor a change-request/pending blocker. Deleted or unreadable authors remain in the evidence as null, with their review id/state/head and no authority; a ghost login is likewise non-authorizing. See the [PullRequestReview reference](https://docs.github.com/en/graphql/reference/pulls#pullrequestreview).

Merge requires the exact complete `evidence` snapshot authorized by the caller's verdict, alongside expected head/base and explicit squash text. Its preflight reloads core state, checks, reviews and their authority, threads, labels and protection policy through the same bounded collector as status. If any observation differs, no mutation is launched; fresh evidence is returned so `forge/pr` can recompute the verdict and report blockers. Object-key order does not change snapshot identity. A matching snapshot proceeds with the exact expected head in the GitHub `sha` condition. This does not make mutable checks, labels or threads atomic with GitHub's merge operation.

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
include classic branch protection and effective ruleset checks. Both `requiresStrictStatusChecks` and `strict_required_status_checks_policy` are collected without defaults. Strict policy compares the immutable base/head SHAs and records the behind count, with core/policy readback refusing either moving ref. Active rules that lack a complete evaluator (including deployments, merge queues, pull-request review restrictions and unknown rule kinds) are `INCOMPLETE`; classic review, code-owner, restricted-push and signature requirements are likewise refused until fully supported. The only other accepted rule types are linear history, non-fast-forward protection and deletion protection, which conditional squash merge already respects. GitHub merge APIs provide an exact-head condition but no atomic base-SHA condition. This provider reports `atomicBaseCondition: false` and refuses strict direct merge before the REST mutation. Nonstrict direct merge requires `expectBase`, re-reads core and protection, and refuses observed base/head movement; that preflight is not an atomic base comparison-and-swap and makes no bypass-race guarantee. The block
re-reads core/protection and required checks after collection and refuses
changes during the observation. Review and latest-thread-comment edits
contribute to the activity timestamp when the review concerns the current head. Each check and review retains its actual commit SHA; aggregate mergeability, thread-resolution and label observations are stamped with the bracketed core head. `forge/pr` ignores and reports historical observations. Configured blocking labels are
returned as unresolved findings; `forge/pr` supplies their merge policy.

`github.call` declares `github:write` and `external:write`. It accepts only
these catalog-described actions:

Reply and resolution query only the named thread's type, repository and pull-request membership. Rerun queries only the current head and the named run, then rechecks the head before mutation. These targeted writes remain available when classic approvals or an unsupported ruleset make merge evidence incomplete. Full merge-policy collection remains required for status verdicts and merge validation.

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

Classic protection collection uses one invocation-local schema check before gathering merge evidence or direct merge preflight. All documented requirement fields are requested from one catalog, including deployment environments, approval counts, conversation/last-push requirements, locks, conflicts and actor-allowance counts. A new, missing or unreadable schema field is incomplete; so is an unrecognized returned requirement or an active unsupported requirement. Required deployments remain incomplete until head-bound deployment evaluation is implemented. Known status checks and strict policy are evaluated; squash/no-force/no-delete/no-create behavior satisfies linear-history and operation restrictions, and protection is applied regardless of administrator bypass. Other active requirements and nonempty actor/conflict connections fail closed. Reply/resolve/rerun do not need this policy or introspection query.

The schema coverage snapshot follows the [BranchProtectionRule reference](https://docs.github.com/en/graphql/reference/branches#branchprotectionrule). No persistent schema cache is added; unavailable introspection is incomplete.
