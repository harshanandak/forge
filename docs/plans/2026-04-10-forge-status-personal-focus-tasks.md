# Forge Status Personal Focus - Task List

**Issue**: `forge-sxg2`
**Branch**: `feat/forge-status-personal-focus`
**Design doc**: `docs/plans/2026-04-10-forge-status-personal-focus-design.md`
**Baseline**:
- `13 pass / 0 fail` on `bun test --timeout 15000 test/status-command.test.js test/commands/status-smart.test.js`
- `22 pass / 0 fail` on `bun test --timeout 15000 test/commands/status.test.js`

YAGNI check:
- Every task below maps directly to the zero-arg output requirements in the user request.
- PR integration, external issue classification, role config, and cross-repo sync are intentionally excluded from this task list.

---

## Wave 1: Discovery and data collection

## Task 1: Add zero-arg context discovery for branch and worktree state
Beads: `TBD`
File(s): `lib/commands/status.js`, `lib/detect-worktree.js`, `test/status-command.test.js`
OWNS: lib/commands/status.js, lib/detect-worktree.js, test/status-command.test.js
What to implement: Add a zero-arg entry path that gathers current branch, worktree type, main-worktree reference, and working-tree cleanliness. Preserve existing explicit `--workflow-state` and `--issue-id` behavior.
TDD steps:
  1. Write test: extend `test/status-command.test.js` to assert `handler([], {}, projectRoot)` returns context details instead of the current "Provide --workflow-state or --issue-id" placeholder.
  2. Run test: confirm it fails against the current zero-arg behavior.
  3. Implement: add context-discovery helpers and reuse `detectWorktree()` where possible.
  4. Run test: confirm it passes.
  5. Commit: `feat: add zero-arg status context discovery`
Expected output: `forge status` can always describe the current checkout before any issue/workflow lookup.

## Task 2: Build a local Beads snapshot reader for active, ready, and completed work
Beads: `TBD`
File(s): `lib/status/beads-snapshot.js`, `test/status-command.test.js`
OWNS: lib/status/beads-snapshot.js, test/status-command.test.js
What to implement: Read `.beads/issues.jsonl` with last-write-wins grouping and expose filtered groups for active assigned issues, ready issues, and recent completions. Resolve current developer identity from local git config.
TDD steps:
  1. Write test: add fixture-driven coverage in `test/status-command.test.js` for active-assigned filtering, ready filtering (`dependency_count === 0`), recent completion ordering, and malformed-row tolerance.
  2. Run test: confirm it fails because no Beads snapshot helper exists yet.
  3. Implement: add `lib/status/beads-snapshot.js` and wire it into the command.
  4. Run test: confirm it passes.
  5. Commit: `feat: add local beads snapshot reader for status`
Expected output: The command can build the three personal-work sections from local Beads state without calling GitHub or requiring extra flags.

---

## Wave 2: Workflow-cycle discovery and rendering

## Task 3: Auto-discover the current workflow cycle without reintroducing heuristics
Beads: `TBD`
File(s): `lib/commands/status.js`, `lib/workflow/state-manager.js`, `test/status-command.test.js`, `test/commands/status.test.js`
OWNS: lib/commands/status.js, lib/workflow/state-manager.js, test/status-command.test.js, test/commands/status.test.js
What to implement: Add workflow-cycle auto-discovery using this priority order: explicit flags, `.forge-state.json`, branch-to-issue slug match through design metadata, then single owned `in_progress` issue fallback. If multiple candidates remain, omit the workflow section instead of guessing.
TDD steps:
  1. Write test: extend `test/status-command.test.js` for `.forge-state.json` precedence, branch-slug issue matching, single-active-issue fallback, and ambiguous multi-issue fallback.
  2. Run test: confirm it fails because zero-arg workflow discovery does not exist.
  3. Implement: add discovery helpers while preserving existing authoritative state parsing and exports.
  4. Run test: confirm it passes.
  5. Commit: `feat: auto-discover current workflow cycle for zero-arg status`
Expected output: The workflow section appears only when authoritative state can be resolved safely.

## Task 4: Add the zero-arg presenter for context, active, ready, completions, and workflow
Beads: `TBD`
File(s): `lib/status/presenter.js`, `lib/commands/status.js`, `test/status-command.test.js`
OWNS: lib/status/presenter.js, lib/commands/status.js, test/status-command.test.js
What to implement: Render the new five-section dashboard for the zero-arg path. Keep explicit authoritative calls on the existing stage-centric formatter to avoid breaking current contract expectations.
TDD steps:
  1. Write test: assert formatted zero-arg output contains the five sections in order, prints sensible empty-state messages, and preserves the explicit authoritative output shape.
  2. Run test: confirm it fails because no dashboard presenter exists.
  3. Implement: add `lib/status/presenter.js` and route zero-arg calls through it.
  4. Run test: confirm it passes.
  5. Commit: `feat: add zero-arg personal status presenter`
Expected output: `forge status` answers "what should I work on right now?" in one local dashboard view.

---

## Wave 3: Regression coverage and command-surface cleanup

## Task 5: Lock down command compatibility and docs-facing behavior
Beads: `TBD`
File(s): `test/status-command.test.js`, `test/commands/status.test.js`, `test/commands/status-smart.test.js`, `lib/commands/status.js`
OWNS: test/status-command.test.js, test/commands/status.test.js, test/commands/status-smart.test.js, lib/commands/status.js
What to implement: Add regression coverage for legacy explicit flags, ambiguous workflow detection, missing Beads data, and linked-worktree output. Ensure the new zero-arg behavior does not regress the existing authoritative state contract or the smart-status command-doc integration tests.
TDD steps:
  1. Write test: extend the three status test files for the new edge cases and compatibility guarantees.
  2. Run test: confirm at least one new case fails before implementation is finalized.
  3. Implement: make the minimum command changes required to satisfy the new regression suite.
  4. Run test: confirm the targeted status suites pass.
  5. Commit: `test: cover zero-arg status compatibility and edge cases`
Expected output: The zero-arg redesign is protected by focused status-specific regression coverage.

---

## Review notes for /dev

1. Do not pull GitHub PR data into this slice unless the user explicitly expands scope.
2. Preserve `parseStatusInputs`, `resolveWorkflowState`, and explicit-authoritative formatting for current callers and tests.
3. Prefer a small `lib/status/` helper surface over adding more unrelated responsibilities to `lib/commands/status.js`.
4. Treat ambiguous current-issue detection as a display limitation, not a reason to guess.
