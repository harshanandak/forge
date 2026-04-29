# Task List: beads-plan-context

**Design doc**: docs/plans/2026-03-14-beads-plan-context-design.md
**Branch**: feat/beads-plan-context
**Beads**: forge-bmy

---

## Task 1: Create `scripts/beads-context.sh` with all 5 commands

File(s): `scripts/beads-context.sh`

What to implement: A bash script with 5 subcommands: `set-design`, `set-acceptance`, `update-progress`, `parse-progress`, `stage-transition`. Each command validates arguments, calls `bd update` with properly quoted values, checks exit codes, and outputs success/error messages. Must work on Windows (Git Bash), macOS, and Linux.

TDD steps:
  1. Write test: `scripts/beads-context.test.js` — test `set-design` with valid args → exit 0, `bd show` output contains formatted design line
  2. Run test: confirm it fails (script doesn't exist yet)
  3. Implement: `scripts/beads-context.sh` with all 5 commands, argument validation, quoting, error handling
  4. Run test: confirm it passes
  5. Commit: `feat: add beads-context.sh helper script`

Expected output: All 5 commands work — `set-design`, `set-acceptance`, `update-progress` write to Beads fields; `parse-progress` outputs formatted progress string; `stage-transition` writes standardized comment.

Anchors: Success criteria 5, 6; Edge cases 1-5; Decisions 7, 8

---

## Task 2: Add tests for error paths and edge cases

File(s): `scripts/beads-context.test.js`

What to implement: Additional test cases for: invalid issue ID (exit non-zero), special characters in task title (no injection), `parse-progress` with no notes ("No progress data"), missing required args (usage error).

TDD steps:
  1. Write test: error path — invalid issue ID → exit non-zero with clear error message
  2. Run test: confirm it fails (script returns 0 or wrong message)
  3. Implement: add argument validation and error messages to `beads-context.sh`
  4. Run test: confirm it passes
  5. Commit: `test: add error path and edge case tests for beads-context.sh`

Expected output: Script exits non-zero with clear messages for all error cases. Special characters in titles are properly escaped.

Anchors: TDD scenarios 2-4; Edge cases 1-4; OWASP A03

---

## Task 3: Update `/plan` Phase 3 to call `beads-context.sh`

File(s): `.claude/commands/plan.md`

What to implement: After Step 5 (task list saved) and before Step 6 (user review), add instructions to run:
1. `bash scripts/beads-context.sh set-design <id> <task-count> <task-file-path>`
2. `bash scripts/beads-context.sh set-acceptance <id> "<success-criteria>"`

Also add to `/plan` exit HARD-GATE:
7. `beads-context.sh set-design` ran successfully (exit code 0)
8. `beads-context.sh set-acceptance` ran successfully (exit code 0)

Add `stage-transition` call after the exit HARD-GATE:
`bash scripts/beads-context.sh stage-transition <id> plan dev`

TDD steps:
  1. Write test: `scripts/beads-context.test.js` — integration test: simulate `/plan` flow, verify `bd show` has design + acceptance populated
  2. Run test: confirm it fails (plan.md doesn't call the script yet)
  3. Implement: edit plan.md with new steps and HARD-GATE additions
  4. Run test: confirm it passes
  5. Commit: `feat: integrate beads-context.sh into /plan Phase 3`

Expected output: After `/plan` completes, `bd show <id>` displays DESIGN and ACCEPTANCE CRITERIA sections.

Anchors: Success criteria 1, 2, 9

---

## Task 4: Update `/dev` Step E to call `beads-context.sh`

File(s): `.claude/commands/dev.md`

What to implement: In the Step E HARD-GATE (after line 193), add:
7. `bash scripts/beads-context.sh update-progress <id> <task-num> <total> "<title>" <commit-sha> <test-count> <gate-count>` ran successfully (exit code 0)

If it fails: STOP. Show error. Do not proceed to next task.

Also update `/dev` exit section (line 251) to replace the existing `bd update --comment` with:
`bash scripts/beads-context.sh stage-transition <id> dev validate`

TDD steps:
  1. Write test: integration test — simulate task completion, verify `bd show` has progress note appended
  2. Run test: confirm it fails (dev.md doesn't call the script yet)
  3. Implement: edit dev.md with new HARD-GATE item and stage-transition call
  4. Run test: confirm it passes
  5. Commit: `feat: integrate beads-context.sh into /dev Step E`

Expected output: After each `/dev` task, `bd show` notes section has a new progress line. After `/dev` completion, a stage transition comment is recorded.

Anchors: Success criteria 3, 6, 9

---

## Task 5: Update `/status` to show compact progress

File(s): `.claude/commands/status.md`

What to implement: In Step 2 (Check Active Work), after `bd list --status in_progress`, add:
- For each in-progress issue, run `bash scripts/beads-context.sh parse-progress <id>`
- Display the compact output (e.g., "3/7 tasks done | Last: Validation logic (def5678)")
- Add hint: "→ bd show <id> for full context"

Update the Example Output section to show the new format.

TDD steps:
  1. Write test: verify `parse-progress` output format matches expected compact format
  2. Run test: confirm existing format doesn't match (no progress line yet)
  3. Implement: edit status.md with new instructions
  4. Run test: confirm it passes
  5. Commit: `feat: integrate beads-context.sh into /status`

Expected output: `/status` shows compact progress for in-progress issues with `bd show` hint.

Anchors: Success criteria 4; Decision 4

---

## Task 6: Add stage-transition calls to remaining stage exits

File(s): `.claude/commands/validate.md`, `.claude/commands/ship.md`, `.claude/commands/review.md`

What to implement: At each stage's exit HARD-GATE, add a `beads-context.sh stage-transition` call:
- `/validate` exit: `bash scripts/beads-context.sh stage-transition <id> validate ship`
- `/ship` exit: `bash scripts/beads-context.sh stage-transition <id> ship review`
- `/review` exit: `bash scripts/beads-context.sh stage-transition <id> review premerge`

TDD steps:
  1. Write test: verify stage-transition produces correct comment format for each stage pair
  2. Run test: confirm it fails (commands don't call script yet)
  3. Implement: edit 3 command files with stage-transition calls
  4. Run test: confirm it passes
  5. Commit: `feat: add stage-transition calls to validate, ship, review`

Expected output: After each stage completes, `bd show` comments section shows the transition.

Anchors: Success criteria 9; Decision 8

---

## Task 7: Verify sync compatibility and run full test suite

File(s): (no new files — verification only)

What to implement: Run `node scripts/sync-commands.js --check` to verify modified command files still sync correctly. Run `bun test` to verify all existing tests pass. Verify `bd show` output looks correct end-to-end.

TDD steps:
  1. Run: `node scripts/sync-commands.js --check` → no drift errors
  2. Run: `bun test` → all tests pass
  3. Run: manual end-to-end check — create test issue, run each script command, verify `bd show` output
  4. Commit: `test: verify sync compatibility and full test suite`

Expected output: Zero sync drift, zero test failures, clean `bd show` output.

Anchors: Success criteria 7, 8
