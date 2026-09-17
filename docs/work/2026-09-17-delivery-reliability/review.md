# Delivery plan review and evidence record

Date: 2026-09-17. Planning issue: `86c08a2e-7ccc-4da0-8912-1fd4ec5e3495`.
Source baseline: `origin/master` `bd1abbd8ab63b590fd916dad379e0a575542fcc7`.
This record distinguishes review opinion, source evidence and executed proof. A model's GO is not implementation approval or runtime certification.

## Reviewers and scope

| Reviewer | Actual route / attribution | Scope and outcome |
|---|---|---|
| Sol | Dispatcher selected `gpt-5.6-sol`, high | Tracked source and old push patch inspection; findings below; no tests or code edits |
| Luna | Dispatcher selected `gpt-5.6-luna`, high | Package helper and live GitHub master/PR evidence; root cause remains unknown |
| Astra | Dispatcher selected `gpt-6-astra`, high | Initial GO with wording correction; final narrow review accepted the corrected two-lane plan and CI authority dependency; no source/runtime certification |
| Fable | Native bridge unavailable; direct installed Claude CLI requested `fable`, high, plan permission mode, no permission prompts | Completed CHANGES_REQUIRED critique; runtime primary model `claude-fable-5-1`; wrapper interrupted at time cap after a completed result became available |

Claude review was requested explicitly by the user. The native worker reported that `handoff_workflow` was not callable. The lead used the installed CLI without changing routing configuration or substituting a model. The frozen prompt is [review-input.md](review-input.md). It prohibits code, issue, configuration and test mutations.

The completed original report is preserved in [fable-review.md](fable-review.md). Session: `81f58c27-e85c-4c28-916f-9487829dbc92`. Its terminal JSON reports success/completed/end_turn, 26 turns and 916,304 ms; the parent wrapper exited 1 after the lead stopped the owned process tree at the time cap. Treat this as a completed critique with interrupted transport, not a pristine successful process run. The receipt names Fable as primary and also includes a small Haiku usage entry; the lead did not select that auxiliary model or infer its purpose. Fable wrote its own review artifact outside the repository, so its opening statement that nothing was written is not literally correct. No repository implementation mutation was observed.

## Material corrections already incorporated

1. **Freshness policy conflict.** Existing issue `8d51c08b...` requires current base at development/validation/ship/push. Just-in-time landing cannot be adopted silently. The plan now gives explicit replacement acceptance pending user approval and keeps the initial repair wave under current rules.
2. **Old patch conflicts and consumer detection.** Sol's merge simulation found conflicts in `push.js`, push tests and CHANGELOG. The old `scripts/test.js` existence-only check could select Forge behavior in an unrelated consumer repository. Recover behavior manually, reuse the stronger manifest/runner predicate and preserve receipt/shepherd additions.
3. **Wrong edge-test runtime.** CI runs Node against 19 `test-env` files importing `bun:test`, then masks the result. Use Bun and the existing required gate; deleting the error mask alone is incomplete.
4. **Worker-budget edge cases.** Below-cost Windows budgets must reject before subprocess or exclusive-lane launch. Propagate a validated existing `--shards` option through canonical validation and record the selected setting; do not add a pretend environment variable.
5. **Package failure is already exclusive.** Latest master still fails on Windows Node22; other OS/runtime matrix jobs passed. Capture phase timings and result/error/signal at the existing npm helper before selecting a fix. A null exit and total test duration alone do not prove registry/network time.
6. **Graft capacity and proof.** Optional experiment follows available reliability capacity. Compare against current search plus saved research, include setup/refresh, independently score correct source/callers and test freshness. No graph-driven skipping of required checks.
7. **Stop conditions.** Astra identified ambiguous wording that would stop a repair lane merely for reproducing its assigned failing test. Known in-scope failures remain diagnosis targets; unresolved required failures block landing/closure.
8. **Protected workflow edit prerequisite.** Fable's main new blocker was independently confirmed by Sol: the general workflow surface is protected, but the authorized `test.yml` writer only permits derived Bun-pin changes. Existing issues `a541c8ca...` and `2db62bdd...` own the missing legitimate edit path. The proposal now has two ready lanes and a blocked CI lane; no broad grant or human exemption is assumed.
9. **Planner versus full proof.** Fable highlighted that the existing push issue requests full-suite coverage while the planner can select targeted tests. Preserve full-run acceptance and explicitly select/prove full mode where required. A targeted push gate cannot mint or refresh a full receipt. Do not claim all planner runs are full runs.
10. **Budget evidence scope.** Record requested/effective concurrency in run evidence. Do not expand receipt identity or force a schema migration solely for a setting that preserves coverage.

## Fable recommendations corrected or declined

- Its suggested Node command conflicts with the Bun imports. Retain the source-verified Bun invocation.
- Its proposed human-commit probe is unnecessary: the same content-bound guard applies without a human exemption. Resolve the existing writer issues through the normal mechanism.
- Total test duration and a null install result do not establish that install alone consumed 60 seconds or that every hosted npm cache was cold. Retain measured phase diagnosis and safe bounded diagnostics; cause remains unknown.
- A path filter excluding `push.js` does not excuse relevant Windows proof. Master still runs the matrix; required final-head and merge-SHA checks must be healthy.
- A deliberately red throwaway PR adds external changes not authorized here. Use a local behavioral failing fixture; separately agree any additional live diagnostic experiment.
- The report's pending-CI-refresh note was overtaken by Luna's completed live inspection below. Historical source anchors and stale recommendations remain in the original report for provenance, not as instructions.

After these corrections, Astra returned GO for the revised planning proposal from the supplied evidence. Remaining dependencies: implementation authorization, a legitimate workflow writer before CI edits, and explicit freshness-policy acceptance before delayed branch refresh. No second broad review is needed to finish this planning artifact.

## Sol source anchors

- `lib/commands/push.js:294` package-command execution; `:373` existing receipt reuse; `:394` passthrough boundary.
- `lib/commands/validate.js:601` Forge capability predicate; `:682` hardcoded runner arguments; `:932` handler argument path.
- `scripts/test.js:312` planner; `:565` full runner; `:585` canonical Bun test-env invocation.
- `.github/workflows/test.yml:393` wrong runtime and ignored failure; `:574` CI Gate owning followup-tests.
- `scripts/test-full-suite.js:488` worker grants and forced-one behavior; budget regressions in `test/scripts/test-full-suite.test.js:670`.
- `lib/validation-receipt.js:90` completeness requirements.
- `lib/protected-state-surfaces.js:125` protected workflows; `lefthook.yml:14` unconditional pre-commit guard; `scripts/protected-state-check.js:451` exact authority verification.
- `lib/protected-state-authority.js:31` Bun workflow writer mapping and `:138` content-bound capability checks; `lib/bun-workflow-pins.js:381` rejects unrelated edits.
- `.forge/contributor-skills/protected-commit/SKILL.md:16` owning-writer requirement and `:52` missing-path handling.

These anchors refer to the recorded remote source baseline, not the potentially dirty shared-root files.

## Live hosted evidence from Luna

Latest master [Tests run 34961763392](https://github.com/harshanandak/forge/actions/runs/34961763392) is failed. Windows Node22 [job 104356802367](https://github.com/harshanandak/forge/actions/runs/34961763392/job/104356802367) failed the root tarball install assertion at `standalone-package-smoke.test.js:114`: status=null, test duration 60,154.41 ms, configured test limit 60,000 ms, one dangling process killed. Aggregate: 8,702 tests; 8,668 passed, one failed, 33 skipped, zero errors; 28,020 assertions. Windows Node24 and Ubuntu/macOS Node22/24 matrix jobs passed.

The successful [PR run 34953454360](https://github.com/harshanandak/forge/actions/runs/34953454360) is a different PR artifact, not same-SHA proof for merged master. Its Windows runs and approximately 24.4-second standalone-file result are controls for intermittency, not causal explanation. No new master Tests run appeared in the refreshed list.

Useful diagnostic anchors: shared synchronous npm helper `test/integration/standalone-package-smoke.test.js:14`; pack `:28`; resolved Windows Node/npm invocation `:34`; isolated Forge HOME/config `:65`; root package journey `:104`. The helper lacks phase/result diagnostics. Exclusive metadata is already present at line 3 and honored by the full-suite planner; prior child processes and hosted environment contention are not ruled out by that fact.

## Validation limits and next evidence

No source code, workflows, installed tools, machine settings, branch protection or implementation-issue acceptance was changed. No full source test suite or Graft benchmark was run as part of prose planning. Documentation checks and commit/push results are recorded by the lead's final handoff. The next stage must obtain fresh baseline evidence and run the meaningful negative regressions in tasks.md.

The root-cause fix for the package failure is intentionally unspecified until measured. Sustainable throughput, broader evidence reuse and selected-candidate scheduling remain proposed behavior. Broader policy changes and Graft adoption require their stated acceptance; this plan is not proof they already exist.

## September 17 conversation-learning extension

User requested that Codex conversation history, model capability effects and the earlier delivery recommendation be reconciled into this same plan. [conversation-learning.md](conversation-learning.md) records the sample, incident anchors, known limits, minimal detectors and controlled comparison design.

- Sol (`gpt-5.6-sol`, high) structurally scanned 78,662 records across two selected histories and reviewed bounded Forge-delivery neighborhoods. Five incidents and successful recovery controls were returned; this is neither a complete semantic audit nor a failure-rate estimate.
- The lead sampled the current planning thread's public user/assistant/tool events. It verified the publication-scope correction and retained progress, requirement-drift and transport/result incidents, excluding private reasoning and unrelated content.
- Luna (`gpt-5.6-luna`, high) checked tracked source and live issues. Existing immutable corpus, replay evidence and a zero-tool model-by-workflow evaluator already exist; the concrete gap is action/outcome/receipt linkage plus suitable incident fixtures. The current runtime cannot certify actual tool effects.
- Astra (`gpt-6-astra`, high) accepted the bounded addition with sampling, privacy, frozen-intervention, false-block and missing-data corrections. Those are incorporated; it did not rank models or certify unrun detectors.

The earlier pasted recommendation is superseded only where review established a conflict: CI writer prerequisite, selective stale-patch recovery, explicit freshness-policy decision, and deferred Graft pilot. The first reliability wave remains the priority. Scope remains planning and research preservation, with no implementation PR or model trial authorized by the document itself.
