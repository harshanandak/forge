# Task List: logic-level-dependency-detection

**Design doc**: `docs/plans/2026-03-18-logic-level-dependency-detection-design.md`
**Beads**: `forge-9zv`
**Branch**: `codex/logic-level-dependency-detection`

Baseline note:
- `bun install` succeeded in this worktree.
- `bun test` failed before feature work starts due pre-existing shell-script test failures in this environment.
- User chose to proceed with Phase 3 task planning while treating the current baseline failures as pre-existing context.

YAGNI check:
- No tasks were flagged as scope creep.
- Every task maps to a design-doc success criterion, Beads integration requirement, or day-one edge case.

---

## Task 1: Scaffold the Phase 3 analyzer and structured result contract

File(s): `package.json`, `bun.lock`, `lib/dep-guard/analyzer.js`, `lib/dep-guard/task-parser.js`, `test/lib/dep-guard/analyzer.test.js`

What to implement: Add the parser dependency needed for JavaScript repository analysis and create the Node analyzer scaffold that `dep-guard.sh` will call. Implement `analyzePhase3Dependencies()`, `normalizePhase3Input()`, and `parseTaskFile()` so the analyzer returns a stable JSON contract containing issue pairs, detector scores, rubric output, confidence, proposed dependency updates, and approval-needed state. This task establishes the canonical schema that later detector tasks extend.

TDD steps:
  1. Write test: `test/lib/dep-guard/analyzer.test.js` — assert `analyzePhase3Dependencies()` rejects invalid input, `parseTaskFile()` normalizes task blocks, and a valid minimal input returns an object with `issues`, `scores`, `confidence`, `proposals`, and `needsUserDecision`.
  2. Run test: confirm it fails with missing-module or missing-export errors because the analyzer files and dependency are not implemented yet.
  3. Implement: add the parser dependency in `package.json`, update `bun.lock`, and create `lib/dep-guard/analyzer.js` plus `lib/dep-guard/task-parser.js` with the normalized result schema.
  4. Run test: confirm the scaffold tests pass and the analyzer emits the expected top-level JSON shape.
  5. Commit: `feat: scaffold logic dependency analyzer`

Expected output: running the analyzer against a fixture task list prints structured JSON with empty detector findings instead of crashing.

---

## Task 2: Implement import and call-chain dependency detection

File(s): `lib/dep-guard/analyzer.js`, `lib/dep-guard/import-detector.js`, `test/lib/dep-guard/analyzer.test.js`

What to implement: Build `scoreImportDependencies()` in `lib/dep-guard/import-detector.js` and wire it into `analyzePhase3Dependencies()`. Use the parser to inspect CommonJS and ESM imports, requires, and direct call sites so the analyzer can determine when a planned contract change affects another open issue through import or call-chain evidence. Return structured evidence including source file, consumer file, symbol name, and score contribution.

TDD steps:
  1. Write test: `test/lib/dep-guard/analyzer.test.js` — create fixtures where one issue changes `parseProgress()` and another issue imports or calls it through a shared module. Assert `scoreImportDependencies()` reports a dependency candidate with evidence and a non-zero import score.
  2. Run test: confirm it fails because import/call-chain evidence is not yet detected.
  3. Implement: add `lib/dep-guard/import-detector.js`, parse mixed CommonJS/ESM files, and feed import/call-chain findings into the analyzer output.
  4. Run test: confirm import/call-chain cases now produce the expected issue pair, evidence list, and score contribution.
  5. Commit: `feat: add import dependency detector`

Expected output: analyzer output includes an `importCallChain` section with concrete consumer evidence instead of only keyword overlap.

---

## Task 3: Implement type and contract dependency detection

File(s): `lib/dep-guard/analyzer.js`, `lib/dep-guard/task-parser.js`, `lib/dep-guard/contract-detector.js`, `test/lib/dep-guard/analyzer.test.js`

What to implement: Build `scoreContractDependencies()` in `lib/dep-guard/contract-detector.js` so the analyzer can compare task-list-derived contracts, stored Beads contracts, and symbol-level task intent. Detect when one issue changes a shared function, data format, command contract, or return shape used by another open issue, even without direct file overlap. Reuse `parseTaskFile()` to extract exact task contracts and reconcile them against stored `contracts@...` Beads notes.

TDD steps:
  1. Write test: `test/lib/dep-guard/analyzer.test.js` — assert that changing `formatPlanSummary()` or a CLI output schema triggers a contract dependency finding against another issue that expects the old shape. Include a no-match case where stored contracts exist but should not score.
  2. Run test: confirm it fails because contract/type dependency scoring is missing.
  3. Implement: add `lib/dep-guard/contract-detector.js`, match task-derived contracts against Beads contract metadata, and feed typed contract findings into `analyzePhase3Dependencies()`.
  4. Run test: confirm contract overlap cases produce structured evidence, score contributions, and no false positive in the non-match case.
  5. Commit: `feat: add contract dependency detector`

Expected output: analyzer output includes a `contractDependencies` section naming the overlapping symbols or contracts and the issues they affect.

---

## Task 4: Implement behavioral dependency scoring and rubric aggregation

File(s): `lib/dep-guard/analyzer.js`, `lib/dep-guard/behavior-detector.js`, `lib/dep-guard/rubric.js`, `test/lib/dep-guard/analyzer.test.js`

What to implement: Add `scoreBehavioralDependencies()`, `aggregateRubricScores()`, and `needsUserEscalation()` so the analyzer can reason about rule and behavior changes that are described in tasks but not always tied to explicit symbols. The rubric must combine import/call-chain, contract, and behavioral scores; mark detector disagreements; flag uncertainty; and set `needsUserDecision` whenever detectors conflict or confidence drops below the 70% threshold.

TDD steps:
  1. Write test: `test/lib/dep-guard/analyzer.test.js` — cover (a) behavioral change with no explicit function name, (b) detector disagreement across the three categories, and (c) sub-70% confidence causing escalation. Assert `needsUserDecision` becomes `true` and the rubric summary explains why.
  2. Run test: confirm it fails because behavioral scoring and rubric aggregation are not implemented.
  3. Implement: add `lib/dep-guard/behavior-detector.js` and `lib/dep-guard/rubric.js`, score behavioral signals from task phrasing, and aggregate detector outputs into a weighted rubric summary.
  4. Run test: confirm the analyzer now distinguishes high-confidence pass cases from conflict and low-confidence escalation cases.
  5. Commit: `feat: add behavioral dependency rubric`

Expected output: analyzer output includes `rubric`, `confidence`, `detectorConflicts`, and `needsUserDecision` fields with human-readable reasons.

---

## Task 5: Upgrade `dep-guard.sh check-ripple` to use the Node analyzer and Beads JSON

File(s): `scripts/dep-guard.sh`, `scripts/dep-guard-analyze.js`, `test/scripts/dep-guard.test.js`

What to implement: Replace the current keyword-only `cmd_check_ripple()` path with a JSON-first flow that reads issue data via `bd show --json` and `bd list --json`, calls `scripts/dep-guard-analyze.js`, and renders structured results. The output must show issue pairs, rubric score, confidence, proposed dependency updates, and pros/cons instead of a pure keyword report. Preserve safe shell wrappers and keep the old keyword matcher only as a clearly labeled fallback when the analyzer cannot run.

TDD steps:
  1. Write test: `test/scripts/dep-guard.test.js` — mock `bd ... --json` output and assert `check-ripple` prints rubric scores, confidence, detector categories, and dependency proposals for a known overlap case. Add a fallback-path test when the analyzer returns an error.
  2. Run test: confirm it fails because `check-ripple` still emits the v1 keyword-only report.
  3. Implement: add `scripts/dep-guard-analyze.js`, update `cmd_check_ripple()` to call the analyzer, consume JSON Beads data, and render the richer review output.
  4. Run test: confirm the new structured output appears and the fallback path is explicit instead of silently pretending no conflict.
  5. Commit: `feat: integrate analyzer into check-ripple`

Expected output: `check-ripple forge-9zv` prints a structured dependency review with scores, proposals, and detector-specific evidence.

---

## Task 6: Add approval-aware Beads mutation and decision persistence

File(s): `scripts/dep-guard.sh`, `test/scripts/dep-guard.test.js`

What to implement: Add a new approval-focused subcommand path such as `cmd_apply_decision()` so approved dependency changes can be applied safely through Beads. The implementation must run `bd dep add`, validate with `bd dep cycles`, show the resulting `bd graph`, summarize `bd ready` impact, write the current decision status via `bd set-state`, and store the human-approved rationale via `bd comments add`. It must also avoid mutating dependencies before approval and surface cycle risks as user-facing blockers.

TDD steps:
  1. Write test: `test/scripts/dep-guard.test.js` — mock Beads commands and assert an approved decision (a) adds the dependency, (b) rejects cycle-creating updates, (c) writes a state label, (d) records a comment, and (e) includes graph/ready output in the confirmation summary.
  2. Run test: confirm it fails because there is no approval-aware mutation flow yet.
  3. Implement: add the new subcommand, cycle check, state update, comment recording, and graph/ready summary logic in `scripts/dep-guard.sh`.
  4. Run test: confirm approved decisions persist correctly and cycle cases stop before mutation.
  5. Commit: `feat: add Beads approval flow for dependency decisions`

Expected output: approving a dependency decision records the mutation in Beads, validates it, and leaves a queryable status trail.

---

## Task 7: Update `/plan` to use Beads-aware worktree setup and Phase 3 approval review

File(s): `.claude/commands/plan.md`, `test/scripts/dep-guard.test.js`

What to implement: Update the planning workflow documentation so it reflects the new Phase 3 behavior. Replace raw worktree guidance with `bd worktree create` where appropriate, document that Phase 3 uses logic-level analysis rather than file-only independence checks, add the explicit user approval checkpoint for dependency mutations, and describe Beads as canonical state with docs as summary only. The guidance must also mention the pre-existing baseline test failure handling: if baseline tests fail, the agent reports the failures and asks whether to proceed.

TDD steps:
  1. Write test: `test/scripts/dep-guard.test.js` — assert `plan.md` mentions `bd worktree create`, `bd dep cycles`, `bd set-state`, `bd comments`, and the user-approval checkpoint for dependency updates.
  2. Run test: confirm it fails because the current `plan.md` still describes keyword-only Phase 3 re-checking and raw worktree creation.
  3. Implement: update `.claude/commands/plan.md` with the new Phase 3 Beads-aware review flow and worktree setup language.
  4. Run test: confirm the doc integration tests pass and the updated plan text reflects the new Beads workflow.
  5. Commit: `docs: update plan workflow for logic dependency review`

Expected output: `/plan` documentation describes a Beads-aware, approval-driven Phase 3 instead of a keyword-only re-check.

---

## Task 8: Sync command docs and validate the logic-dependency workflow

File(s): `.claude/commands/plan.md`, `.codex/skills/plan/SKILL.md`, `.cursor/commands/plan.md`, `.cline/workflows/plan.md`, `.kilocode/workflows/plan.md`, `.opencode/commands/plan.md`, `.roo/commands/plan.md`, `.github/prompts/plan.prompt.md`, `.forge/sync-manifest.json`, `test/lib/dep-guard/analyzer.test.js`, `test/scripts/dep-guard.test.js`

What to implement: Run `scripts/sync-commands.js` so the updated planning workflow propagates to the synced command surfaces, then validate the new analyzer and dep-guard behavior with targeted tests. If the baseline shell-environment failures are still present, record that they are pre-existing and separate them from any regressions caused by the new feature.

TDD steps:
  1. Write test: extend `test/scripts/dep-guard.test.js` or related sync assertions to verify the updated plan workflow is present after sync and no drift remains for the synced command files.
  2. Run test: confirm it fails before syncing or before the new workflow text is propagated.
  3. Implement: run `node scripts/sync-commands.js`, inspect the synced outputs, and update any affected tests for the final workflow wording.
  4. Run test: confirm targeted analyzer and dep-guard tests pass, then run broader validation as far as the pre-existing baseline allows.
  5. Commit: `chore: sync logic dependency plan changes`

Expected output: synced command files are up to date, targeted logic-dependency tests pass, and any remaining failures are clearly identified as pre-existing baseline issues rather than feature regressions.

