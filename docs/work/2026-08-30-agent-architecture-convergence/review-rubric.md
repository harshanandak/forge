# Forge architecture review rubric

Every reviewer receives the same plan version and this rubric. Reviewers must not edit the repository.

## Required attribution

Report the requested route, the resolved provider/model identifier, and whether the requested model actually ran. If it is unavailable, return `INCOMPLETE`; do not silently substitute another model.

## Scoring

Score each category from 0 to 10, then report a weighted total from 0 to 100.

| Category | Weight | Test |
| --- | ---: | --- |
| Authority and correctness | 18 | Kernel truth, projections, actor/session/worktree identity, conflicts, and irreversible actions are unambiguous. |
| Simplicity and slop removal | 15 | The plan deletes, reuses, or postpones more than it invents. No speculative universal abstraction. |
| Sequencing and feasibility | 12 | Dependencies, migration order, compatibility, rollback, and first executable slice are credible. |
| Harness and skill portability | 10 | Skills and adapters work by capability without leaking one host's semantics into the core. |
| Permission and failure safety | 10 | Plugin effects, retries, cancellation, resume, and partial failure fail closed where authority matters. |
| Kernel performance | 10 | Core issue/run/claim commands remain local, deterministic, bounded, and independent of optional providers. |
| Memory selectivity and cost | 10 | Recall is scoped, provenance-aware, token-bounded, deletable, and off the authority write path. |
| Whole-system UX | 8 | Users can understand what ran, why it ran, what it cost, and what happens next without reading internals. |
| Evidence and testability | 7 | Claims have measurable gates, exact subjects, replayable fixtures, and falsifiers. |

## Required response

1. Status: `COMPLETE` or `INCOMPLETE`.
2. Exact route and resolved model identifier.
3. Category scores and weighted total.
4. Up to five blocking findings, each with the smallest correction.
5. Up to five non-blocking improvements.
6. Three items to delete, merge, reuse, or defer.
7. Recommended first implementation slice and why it is dependency-safe.
8. Verdict: `ACCEPT`, `REVISE`, or `REJECT`.

## Convergence gate

At least two full review rounds must run. A version converges only when every completed requested reviewer scores at least 90, the score spread is at most 5 points, no reviewer reports a blocker, and the latest round adds no new critical finding. Unavailable requested models remain visible as `INCOMPLETE`; they do not receive fabricated scores. Stop after three rounds if the gate still fails and preserve the dissent instead of tuning prose to game scores.
