# Decisions

## Stable-base prerequisite, not #471 scope expansion

The merge-authority defect is pre-existing control-plane work. It remains in this isolated lane and must be merged/installed before #471 is allowed to invoke merge authority.

## Caller lease is immutable authority

The expected head is never inferred from the first provider read. The caller supplies one full SHA; both reads and the server mutation must match it.

## Ownership is re-proved

An explicit issue ID and actor-scoped active Kernel claim are required before reads and again immediately before mutation. The same issue must also be the unique open `kernel_pr` linkage for the observed repository and numeric PR on both provider reads. The merge command never acquires, reclaims, or relinks authority. Command-owned Kernel drivers are deterministically disposed after successful and failed issue reads, and factory initialization failures close the driver before propagating.

## Protected policy is mandatory

Configured rules are supplemental. A branch-protection policy from the authoritative endpoint and literal successful observations are mandatory. The structured policy preserves each required context's app ID and matches it against complete paginated check-run observations for the exact head. Rollup-derived required sets, malformed payloads, wrong-app observations, contradictory states, skipped/neutral checks, and unknown policy state cannot authorize.

## Server closes the residual head race

Two client reads do not eliminate a force-push between read and mutation. GitHub receives `--match-head-commit` and no unsafe fallback exists.

The normalized repository identity is also an immutable caller-side lease: the initial and fresh contexts must name the same repository, and that initial normalized identity is the only repository forwarded to the mutation. A provider-shaped repository drift cannot redirect the merge.

## Provider and lifecycle observations fail closed

Review-thread evidence uses the already leased repository identity; no nested helper may rediscover a different repository. The ownership actor is resolved once, copied into an immutable environment snapshot, and reused for both ownership probes. Complete check-observation collections are unreadable if any member is malformed, and duplicate protection requirements with conflicting app IDs are unreadable policy.

Only explicit `OPEN` authorizes mutation; only explicit `MERGED` or `CLOSED` are terminal no-ops. Review-thread GraphQL pages require error-free data, arrays of structurally valid nodes, boolean page state, and progressing cursors. Check-run pages require consistent totals, exact-head observations, producing app IDs, and strict `COMPLETED` + `SUCCESS` agreement.

Terminal as well as continuing GraphQL pages require an explicit `endCursor` whose value is either a string or `null`; omission is unreadable. The shared PR-state adapter applies the same error-envelope, connection-shape, node-shape, nested-page, cursor-progress, and page-cap rules, so Shepherd and bundle consumers cannot project partial evidence as empty state.

Kernel PR linkage accepts only positive safe integers or canonical positive-decimal strings. Numeric coercions such as `0x2a`, `42e0`, `042`, and `42.0` are malformed linkage evidence, not aliases for PR 42.

Global CLI flags are stripped before guarded merge argument parsing. Both `forge merge --path ...` and `forge pr --path ... merge` reach the same authority path rather than failing with usage or interpreting a global flag as a merge selector.

## Exact-SHA review convergence

Candidate `7d02625888820f9afa83737cc30fbf1d20f955c5` is rejected. Required review lanes found missing mandatory settle, edited-comment freshness, malformed optional observation handling, shared nonterminal/success contradictions, incomplete head OIDs, protection-policy fallback, success-like optional conclusions, provider lifecycle defaults, non-canonical selectors, incomplete nested actor identity, and premature disposal of an injected Kernel broker. No review verdict for that SHA authorizes its replacement.

The replacement enforces an unconditional minimum ten-minute quiet period using the newest creation/edit/submission timestamp. Check-run and status-context collections validate provider enums collection-wide; only terminal `SUCCESS` is green, while optional `NEUTRAL`, `SKIPPED`, unknown, missing, or contradictory evidence blocks mutation. Pull requires full 40-character head OIDs. Authoritative protection parse failure never falls back to rollup-derived authorization; rollup data remains diagnostic only and accepts only canonical positive-decimal PR selectors. Shared provider state carries an explicit readability signal so missing lifecycle fields or malformed rollup members produce `ESCALATE`/`UNKNOWN`, and nested thread authors require a valid GraphQL actor type. Injected Kernel brokers retain caller ownership for same-command grounding; only internally created brokers are disposed by the issue-operation layer.

Candidate `3274e04cf71c24c255360fc70007e4dbd4e9687c` is also rejected. Its terminal exact-SHA review reproduced three remaining authority gaps: settle ignored the aggregate PR/review activity timestamp, optional GraphQL CheckRuns were dropped before complete-envelope validation, and ownership/binding helpers accepted incomplete identities or disposed injected resources. Shared Pull/Shepherd paths also needed a missing final-head read to stay unknown, canonical GraphQL selectors on every surface, actor type on nested pages, and explicit escalation for malformed non-auth provider responses.

The terminal amendment validates every REST and rollup observation before policy filtering, requires explicit CheckRun `COMPLETED` + `SUCCESS` and explicit StatusContext `SUCCESS`, requires structured policy entries to carry an explicit app identity field, and requires both ownership probes to return the frozen actor and claimant identities. Mandatory settle includes the newest aggregate activity timestamp. Injected binding drivers remain caller-owned. Pull requires valid full start and end heads without fallback, every review-thread GraphQL path rejects non-canonical PR selectors and requests nested actor type, and Shepherd converts malformed provider evidence into `ESCALATE`. Focused RED reproduced ten counterexamples; focused GREEN passed 191 tests and the bounded affected manifest passed 320 tests, with ESLint, 22 syntax checks, and `git diff --check` green.

Candidate `331943cce424ed57ef9afcd5dc773a89692fc41b` is rejected after two terminal review counterexamples; its Kernel/CLI lane passed. Review freshness now takes the maximum of every review's creation, update, and submission timestamps rather than preferring submission and discarding a later edit. The shared PR-state adapter now treats an unknown `mergeStateStatus` enum as unreadable evidence, normalizes its projection to `UNKNOWN`, and therefore routes Shepherd to `ESCALATE` rather than `MERGE_READY`. Both exact regressions were RED before implementation and GREEN afterward; the bounded affected manifest remained green.

Candidate `66d7b4d18d58ac007ce66ac8c31471111419bbc2` is rejected after the shared-projection lane proved that GitHub's explicit `UNKNOWN` enum and recognized `BLOCKED` state could still reach Shepherd `MERGE_READY`. The adapter now treats explicit `UNKNOWN` as non-readable authority evidence. At Shepherd's terminal handoff seam, only `CLEAN`, `HAS_HOOKS`, or `UNSTABLE` provider merge states may produce `MERGE_READY`; `UNKNOWN`, `BLOCKED`, `DRAFT`, inconsistent `BEHIND`, malformed values, and conflicts remain non-authorizing. The exact counterexamples were RED before the change and GREEN afterward; the bounded affected manifest remained green.

Candidate `7e7fa0cb2193db6c10b9a55b11844dde7e8eaf9a` is rejected after a predecessor review result proved its settle evidence still relied on the lossy `gh pr view --json reviews` projection, which omits review creation/edit timestamps. Merge authority now reads fully paginated GraphQL review evidence with mandatory `createdAt`, `updatedAt`, and `submittedAt`, preserves the latest activity across every review per author while retaining latest-submission semantics, and computes settle freshness from that source. Review authority is permanently agent/vendor agnostic: human and automated reviewers are governed by identical mechanism-based thread, submission, timestamp, head-binding, and resolution evidence; no name allowlists or vendor-specific trust exist.

Candidate `23f5854f069ccfb22324d1266f132b930745a9a3` is rejected after its agent-agnostic lane proved the merge path consumed timestamps but discarded normalized actor, state, and commit-head evidence. The GraphQL adapter now accepts only provider-defined review states and full 40-character commit OIDs, selects latest review state by submission time while retaining maximum activity across all reviews per author, and exposes complete normalized evidence to merge authority. Both initial and fresh mandatory gates now require readable review evidence, recognized actor types, valid timestamps, known states, exact-head binding for every active latest review, and no `CHANGES_REQUESTED` or `PENDING` latest state. `DISMISSED` review history is non-authorizing and may remain bound to an earlier head. These rules are mechanism-based and vendor-neutral.

Candidate `0b79eba52b99d37ec1579ffb2a15c20721e83d13` is rejected after exact-delta review found that pre-validation string coercion could turn object IDs into `"[object Object]"` and normalize a `[bot]` login to an empty author, silently dropping a blocking review. Review IDs and logins must now be nonempty strings before normalization, normalized authors must remain nonempty, and review evidence is marked readable only when repository identity allowed the GraphQL collection to run.

## Bounded residuals

GitHub's protected merge remains the final server-side enforcement after the local app-scoped proof. Rulesets-only policy retrieval and durable Kernel-backed verdict authority remain separate follow-ups; unsupported policy sources fail closed.
