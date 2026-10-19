# Pull request primitives

`forge/pr` owns pull request links, leases and accepted merge evidence. It asks a
configured provider for fresh observations on every `pr.status`, `pr.checks` and
`pr.threads` call. These reads do not write. `evidence` and `verdict` travel
together; no stored phase or previous verdict authorizes a merge.

The catalog describes all twelve operations and their input/output schemas.
`pr.claim` acquires a lease in this block's namespace; `pr.renew` and
`pr.release` require its held generation. A lease acquired by `forge/work`
does not authorize `pr.merge`. The subject is
`pr:<lowercase-owner/repository>:<number>`.

`pr.merge` requires `expectHead` (a full 40-character SHA) and
`expectRevision`. It gathers fresh evidence, computes the verdict, checks the
pinned head, writes a lease-fenced intent, invokes the conditional provider
merge, writes lease-fenced accepted evidence, then reads the provider again.
Validated SHAs are canonical lowercase at the input and provider boundaries. Uppercase hexadecimal remains valid input; comparisons, provider payloads and accepted evidence use the canonical value, including nested checks, reviews and protection proof.
The intent is fenced after executable resolution, immediately before process launch with no intervening await; the process timeout is capped by the remaining held lease. An expired or replaced lease stops acceptance even when the external merge
succeeded. A timeout or uncertain provider result requires reading and
reconciling before another mutation; the block does not retry mutations.

The computed outcomes are `INCOMPLETE`, `DRAFT`, `CONFLICTING`,
`CHECKS_FAILED`, `CHECKS_PENDING`, `REVIEW_BLOCKED`, `REVIEW_REQUIRED`,
`SETTLING`, `MERGE_READY`, `CLOSED` and `MERGED`. Missing, malformed,
unreadable, paginated-incomplete or future-dated evidence is incomplete.
Every counted observation must identify the current head: check and review `headSha`, aggregate `mergeableHeadSha`, and thread/finding `headSha`. Historical observations remain visible in evidence but are ignored before existence, approval, settle and blocking policy; verdict reasons report each stale category. Missing head bindings are incomplete. Old-head-only checks cannot satisfy `allowNoChecks: false`, even when optional checks are ignored. Codex/review-state authority uses the declared review records (bot authors are ordinary review authors); unknown extra provider fields supply no authority.

`protection` explicitly binds the required-check policy to both the current head and base. Its strict flag is mandatory. A strict policy additionally requires `baseComparison` for those exact SHAs; a behind head remains `CHECKS_PENDING`, and missing or stale comparison/policy evidence is `INCOMPLETE`. Strict `MERGE_READY` also requires the provider-reported `atomicBaseCondition` capability. GitHub reports false, so strict GitHub direct merges remain incomplete even when currently up to date. This protection is independent of configured optional-check and approval preferences.

Required checks must identify the current head and finish with strict
`SUCCESS`; optional runs may have the configured safe terminal conclusions.
Only authorizing reviews carry approval/change-request authority. Historical
comments and dismissed reviews do not authorize a merge or invalidate a later
head. The latest authorizing review per login must concern the current head.
Unresolved threads and configured blocking labels stop merge.

## Explicit configuration

Every listed key is required. There are no built-in workflow defaults.

| Key                                       | Meaning and bounds                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `envNames`                                | Required explicit environment-variable names, at most 256 names of at most 256 characters. Empty selects none. PATH, PATHEXT, platform and auth variables must be named when needed. |
| `provider.executable`                     | Executable path/name, 1–4096 characters; resolved through the process port.                                                                                                          |
| `provider.readArgs`, `provider.writeArgs` | Explicit argv arrays; at most 128 arguments of at most 4096 characters. Reads use the former; mutations use the latter.                                                              |
| `provider.timeoutMs`                      | Per-command timeout, 1–300000 ms; additionally capped by the invocation's remaining deadline.                                                                                        |
| `provider.maxOutputBytes`                 | Process output budget, 1024–1048576 bytes; truncation is refused.                                                                                                                    |
| `minApprovals`                            | Required latest exact-head approvals, 0–100.                                                                                                                                         |
| `settleMs`                                | Minimum time since the latest provider review/PR activity, 0–86400000 ms.                                                                                                            |
| `optionalChecks`                          | `safe-terminal` requires optional runs to finish as `SUCCESS`, `NEUTRAL` or `SKIPPED`; `ignore` ignores optional pending/failing runs. Neither relaxes protected required checks.    |
| `allowNoChecks`                           | Whether an explicitly known empty check/required set may proceed.                                                                                                                    |
| `blockingLabels`                          | Up to 100 label names, each at most 500 characters. Unresolved findings with these labels block.                                                                                     |
| `leaseMs`                                 | Acquisition/renewal duration, 1000–86400000 ms. The state owner fences expiry in its transaction.                                                                                    |
| `squashTitle`, `squashBody`               | Explicit squash text, at most 1000/65536 characters. `{repository}` and `{number}` are substituted. A merge may override either field; all text refuses `Co-Authored-By` trailers.   |

## Provider protocol

The provider is an argv-only process in the host's canonical clone root. Stdin
is JSON `{ "action": "status", "payload": { "repository": "owner/repo",
"number": 42 } }`; stdout must be the Forge result envelope
`{ "ok": true, "result": ... }`. The status result conforms to
`schemas/evidence.json`. Mutation actions are `create`, `reply`, `resolve`,
`rerun` and `merge`, with the payloads described by the catalog. Merge passes
the pinned head and explicit squash title/body and requires
`{ "merged": true, "headSha": "<pinned SHA>" }` in the result.

One production configuration can execute the installed Node CLI with
`--hook github.read` for reads and `--hook github.call` for writes, subject to
the host's normal admission and grants. Provider-specific API and account
verification belong to `forge/github`. Credentials belong only in the
host-selected environment, never this config, outputs or state.

`pr.create` stores the returned PR link. `pr.link` reads an existing PR before
storing it at `expectRevision`. `pr.reply` and `pr.resolve` require a specific
`threadId`; there is no resolve-all operation. `pr.rerun` requires a specific
positive `runId`.

The block uses bound `process`, `environment` and namespaced `state` services and
optionally the host's explicit `identity` environment. It adds no background
process, watcher, cache or retry loop. Process operations declare `external:process` and `environment:read`; the generic host requires those grants even for observational commands, so those reads are hidden by the current MCP read-only filter. Lease-only operations declare only `pr:write`. Invocation cancellation/deadline and
Git location-override filtering apply to every process launch.
