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

## Bounded residuals

GitHub's protected merge remains the final server-side enforcement after the local app-scoped proof. Rulesets-only policy retrieval and durable Kernel-backed verdict authority remain separate follow-ups; unsupported policy sources fail closed.
