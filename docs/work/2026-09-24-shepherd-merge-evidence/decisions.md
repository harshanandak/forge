# Decisions and evidence

## 2026-09-24: bounded root-cause repair

The user authorized the next repair while preserving the wider objective of
faster, easier and reliable CI and merging. Reuse the existing two issues and
deliver their shared mechanism in one PR. Known successful workflow comments
are informational; unknown or actionable feedback continues to block.

Both issue leases were proved for `shepherd-review-root-20260924`. Work uses
`fix/shepherd-merge-evidence` based on freshly fetched `origin/master`.
The shared root and other worktrees remain untouched. Sol owns implementation;
the main agent owns issue state, coordination and integration.

## Spec review corrections

The first regression run reproduced 11 failures: missing adapter identity/URL,
known informational comments blocking, and actionable comments losing blocker
evidence. The shared correction passed the original 100-test focused set.

Spec review identified overly broad wording about human-shaped comments and
an overly broad numeric threshold match. Preserve existing human direct-comment
semantics; human prose never grants a bot-specific classification or clears
another blocker. Match the current package-size producer's literal 10 MB
threshold, with its integer arithmetic, rather than recognizing arbitrary
size-policy formats. Unknown/customized formats remain visible blockers.

A single earlier host-load reading was not representative. Fresh three-sample
performance counters showed 69-89% CPU and about 4 GiB available memory. Use the
supported two-unit validation budget after review; an idle machine is not a
prerequisite. These readings are observations, not a performance benchmark.

## Focused verification

Both spec corrections reproduced as failing tests before the correction. The
final combined command covered `test/pr-pull.test.js`,
`test/pr-state-adapter.test.js` and `test/shepherd-merge-safety.test.js`:
175 passed, zero failed, 423 assertions, 3.55s runner / 5.41s wall time.
Strict lint on the four changed source/test files passed in 4.81s; the existing
Node package module-type diagnostic is separate from ESLint warnings.

The adapter keeps its `id` alias and adds canonical `commentId` and `url`.
The existing issue-comment query fetches the URL without another request.
`evidence.botComments` keeps its ID-list shape; `direct-comment` blockers carry
observed identity and clear action guidance, including a missing-identity reason.

## Independent review

The final spec review approved the corrected producer matching and end-to-end
evidence projection. A separate quality review approved the implementation,
security boundary, meaningful regressions, compatibility, and documentation.
Both reviews found no remaining blocker. These are source-level reviews, not
claims of canonical validation or live PR behavior; those remain the next proof.

The user subsequently requested Opus 5.5 review. The completed review approved
the patch and proposed three useful documentation/test improvements, assigned
to Sol before canonical validation. See `opus-review.md` for the model evidence,
accepted improvements, deferred display concern, and startup limitation.

Sol completed the three accepted improvements without another runtime logic
change. Focused Shepherd safety and auto-action tests passed: 81 tests, zero
failures, 149 assertions, 4.06s runner / 7.21s wall time. Strict lint on the four
touched files passed in 25.55s, with only the existing Node module-type diagnostic.
The main agent reviewed the small follow-up before canonical validation.
