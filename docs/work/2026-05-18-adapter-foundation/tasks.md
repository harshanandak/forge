# 0.0.18 Adapter Foundation Tasks

## Task 1: ReviewAdapter SPI

TDD:
- Add failing tests for ReviewAdapter method contract validation and lifecycle expectations.
- Implement `lib/review-adapter.js`.
- Document method inputs, outputs, and required adapter metadata.

Acceptance:
- Missing required methods fail validation.
- Valid review adapters pass validation.
- Contract docs are precise enough for user-authored adapters.

## Task 2: Greptile Adapter Compatibility

TDD:
- Add failing tests proving Greptile fixture parsing and scoring match existing `matchThreadsToCommits` behavior.
- Implement `lib/adapters/greptile-review-adapter.js`.
- Refactor `lib/greptile-match.js` to delegate while preserving its current public export.

Acceptance:
- Existing `matchThreadsToCommits` API is unchanged.
- Greptile unresolved-thread filtering and commit matching remain behaviorally compatible.

## Task 3: Adapter Scaffold And Fixture Replay CLI

TDD:
- Add failing CLI tests for `forge new adapter <name> --kind=review --template=greptile`.
- Add failing fixture replay tests for `forge adapter test <name> --fixture=<path>`.
- Implement the smallest CLI surface needed for scaffold generation and offline replay.

Acceptance:
- Scaffold command writes a review adapter starter in the expected local extension location.
- Fixture replay runs without GitHub network access.
- Any enable/disable/list support is local and minimal; defer if it would require runtime dispatch not in this PR.

## Task 4: Documentation And Workflow Artifacts

TDD:
- Add or update tests that check documented CLI examples if an existing docs test pattern exists.

Acceptance:
- Adapter contract, lifecycle, fixture expectations, compatibility notes, and non-scope are documented.
- `docs/work/2026-05-18-adapter-foundation/decisions.md` records any spec gaps.
- Covered issues and validation commands are ready for the PR body.
