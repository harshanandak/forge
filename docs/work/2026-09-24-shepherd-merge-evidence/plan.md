# Accurate Shepherd merge evidence

Primary issue: c8c322a9-0e3d-48ef-8ad3-17f0d7724311.
Related evidence defect: 1694b724-1368-4b30-804a-1d7676dadb63.

PR #574 demonstrated that successful package-size and test/review-trigger
comments from GitHub Actions become false review blockers. The adapter's `id`
and verdict's `commentId` mismatch then hides the responsible evidence.

Fix this shared classification and projection path together. Recognize only the
repository's stable informational workflow formats from the expected bot author;
do not exclude all GitHub Actions comments. Preserve unknown comments, failures,
human review requests, unresolved threads, freshness rules and required checks.
Every blocking direct comment must appear as an actionable reason with its
observed identity and link when available, distinct from a resolvable thread.

This is a Simple bug fix. Reuse existing helpers and contracts. No workflow
edits, added polling, new dependencies, automatic merging, gate exemptions,
daemon lifecycle changes, cleanup changes or test reductions are included.

Efficiency is fewer false review loops and enough evidence in one normal pull
to identify the real blocker. Record validation/push timings without claiming
a controlled speed improvement. Review first, run one canonical validation,
then let the unchanged push reuse its exact-head receipt.
