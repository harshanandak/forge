# Tasks

## Task 1 - Audited exact-SHA npm publication gate

Implement a Forge-owned deterministic npm workflow generator and content-bound protected-state audit record. Generate the workflow only through that API. The workflow must resolve the tag to one immutable SHA, run the complete supported release suite on it, expose an attributable success receipt, and make publish fail closed unless that exact receipt and checkout SHA match. Preserve OIDC provenance, version/tag/readiness/pack guards, and beta dist-tag behavior. Prove raw edits, stale records, missing evidence, and SHA mismatch are denied. Commit the TDD-backed result.

Owned files: release command/generator, protected-state authorization/checker, npm workflow, and their focused tests. Do not touch evaluation files.

## Task 2 - Behavioral evaluation runner and CLI

Add the controlled behavioral runner that consumes the merged immutable corpus, executes matched opaque arms through an injected executor, evaluates each case, and appends only privacy-safe exact-SHA evidence. Wire `forge skill eval <name> --full --tier 30|100|300` without changing existing static scoring. Missing, malformed, mismatched, or partial evidence is INCOMPLETE. Models and the runner have no merge authority. Add RED/GREEN runner and CLI tests and commit.

Owned files: behavioral runner, skill command, and their focused tests. Do not touch release or scorecard files.

## Task 3 - Promotion scorecard and vetoes

Add a pure deterministic scorer for PASS/FAIL/INCOMPLETE evidence implementing Wilson absolute intervals, case-clustered risk-stratified paired bootstrap, the preregistered safety/high-risk vetoes, and latency/token caps. Thirty cases are instrumentation-only, 100 is the decision gate, and 300 is confirmation; no winner is the default whenever evidence or thresholds are incomplete. Add RED/GREEN unit tests and commit.

Owned files: scorecard module and its tests. Do not touch release, CLI, or runner files.

## Task 4 - Integration, documentation, and final evidence

Integrate the three commits, run cross-seam tests, update the unreleased changelog, and confirm the generated workflow matches its canonical source. Run the full validation and release-readiness commands on the final SHA. Record issue handoff and open one PR. Do not tag or publish beta.5.

