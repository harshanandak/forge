# Task List: superpowers-gaps

**Feature**: superpowers-gaps
**Design doc**: `docs/plans/2026-03-02-superpowers-gaps-design.md`
**Beads**: forge-6od
**Branch**: feat/superpowers-gaps
**Created**: 2026-03-02
**Baseline**: 1215 pass, 0 fail

---

## Overview

6 changes, ordered by dependency:
0a. **Task 0a**: ✅ Entry HARD-GATE in `/plan` — blocks planning if not on master, creates worktree before Phase 1 (DONE: 86eaec8)
0b. **Task 0b**: ✅ Branch isolation fix in `/plan` Phase 3 — always `git checkout master` before branching (DONE: 9b31bd9)
1. **Task 1**: DRY gate in `plan.md` Phase 2 (instruction change only — no lib/test change)
2. **Task 2**: YAGNI filter in `plan.md` Phase 3 + `lib/commands/plan.js` function + test
3. **Task 3**: Verification HARD-GATE in `dev.md` task completion (instruction change only)
4. **Task 4**: Rename `/check` → `/validate`: rename files, update lib, update tests, update all references

---

## Task 1: DRY gate in /plan Phase 2

**File(s)**:
- `.claude/commands/plan.md`

**What to implement**:
Add an explicit DRY search step to Phase 2's "Codebase exploration" section, immediately before the `HARD-GATE: Phase 2 exit` block. The step must require the agent to use actual search tools (Grep, Glob, Read) — not just "think about it" — to find existing implementations before finalizing the approach. If a match is found, the design doc's approach section must be updated to say "extend existing [file/function]" not "create new".

**TDD steps**:
1. Write test: `test/commands/plan.phases.test.js` — add test `'should detect DRY violation when existing implementation found'`
   - Input: mock codebase grep returning a match for a search term
   - Expected: `detectDRYViolation({ searchTerm: 'validateSlug', matches: [{ file: 'lib/utils.js', line: 42 }] })` returns `{ violation: true, existingFile: 'lib/utils.js', existingLine: 42 }`
2. Run test: `bun test test/commands/plan.phases.test.js` — confirm it fails (function doesn't exist yet)
3. Implement: add `detectDRYViolation(params)` to `lib/commands/plan.js` AND add DRY search step to `plan.md` Phase 2 codebase exploration section
4. Run test: confirm it passes
5. Commit: `feat: add DRY gate to /plan Phase 2 codebase exploration`

**Expected output**:
- `plan.md` Phase 2 has new step under "Codebase exploration": "DRY check — before finalizing approach, run grep/glob searches for existing implementations of [key concept from approach]. Document what was found. If match exists: update approach to 'extend [file]', not 'create new'."
- `lib/commands/plan.js` exports `detectDRYViolation({ searchTerm, matches })` returning `{ violation: bool, existingFile?, existingLine? }`
- Test passes

---

## Task 2: YAGNI filter in /plan Phase 3 task writing

**File(s)**:
- `.claude/commands/plan.md`
- `lib/commands/plan.js`
- `test/commands/plan.phases.test.js`

**What to implement**:
Add a YAGNI filter step to Phase 3 Step 5 (task list creation), after the initial task draft but before saving to file. For each task, the agent must confirm it maps to a specific requirement, success criterion, or edge case in the design doc. Tasks with no design doc anchor are flagged. Flagged tasks are presented to the user as "potential scope creep" with the anchor they couldn't find. The user decides: keep (and specify which requirement it serves) or remove.

Special case: if ALL tasks are flagged, return `allFlagged: true` and message "Design doc doesn't cover all tasks — needs amendment."

**TDD steps**:
1. Write test: `test/commands/plan.phases.test.js` — add 3 tests:
   - `'should pass YAGNI filter when task maps to design doc requirement'`
     - Input: `applyYAGNIFilter({ task: 'Add validateSlug function', designDoc: '## Success Criteria\n- validateSlug validates slug format' })`
     - Expected: `{ flagged: false, anchor: 'Success Criteria: validateSlug validates slug format' }`
   - `'should flag task with no design doc anchor'`
     - Input: `applyYAGNIFilter({ task: 'Add dark mode toggle', designDoc: '## Success Criteria\n- validateSlug validates slug format' })`
     - Expected: `{ flagged: true, reason: 'No matching requirement found in design doc' }`
   - `'should return allFlagged when all tasks fail YAGNI filter'`
     - Input: `applyYAGNIFilter({ tasks: ['Task A', 'Task B'], designDoc: '## Purpose\nFoo' })`
     - Expected: `{ allFlagged: true, message: "Design doc doesn't cover all tasks — needs amendment" }`
2. Run test: `bun test test/commands/plan.phases.test.js` — confirm all 3 fail
3. Implement: add `applyYAGNIFilter(params)` to `lib/commands/plan.js` AND add YAGNI filter step to `plan.md` Phase 3 Step 5
4. Run test: confirm all 3 pass
5. Commit: `feat: add YAGNI filter to /plan Phase 3 task writing`

**Expected output**:
- `plan.md` Phase 3 Step 5 has new step after "initial task draft": "YAGNI filter — for each task, find the design doc requirement it serves (success criterion, edge case, constraint). Tasks with no match → flag as 'potential scope creep'. Present flagged tasks to user. User decides: keep (specify requirement) or remove."
- `lib/commands/plan.js` exports `applyYAGNIFilter({ task|tasks, designDoc })` with correct behavior per tests above
- All 3 tests pass

---

## Task 3: Verification HARD-GATE in /dev task completion

**File(s)**:
- `.claude/commands/dev.md`

**What to implement**:
Upgrade the existing `<HARD-GATE: task completion>` block (currently at line ~178) to require fresh verification evidence before marking a task done. The current gate checks test passage only. The new gate must also require: run the actual implemented function/feature and observe real output. This is the "verification-before-completion" Iron Law from Superpowers: "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE."

The gate must explicitly:
1. Name what command proves completion
2. Require running it fresh (not "last run was fine")
3. Show the actual output
4. Forbid the phrases: "should pass", "looks good", "seems to work"

This is a `.md` instruction change only — no `lib/` change, no new test. The existing `dev.test.js` tests should continue to pass.

**TDD steps**:
1. Write test: `test/commands/dev.test.js` — add test `'should require fresh verification evidence in completion gate'`
   - Search for `HARD-GATE: task completion` in dev.md content
   - Expected: the gate text includes "fresh" AND "actual output" AND does NOT include any path that allows "should pass" without running
   - This is a documentation structure test: `const content = fs.readFileSync('.claude/commands/dev.md'); expect(content).toContain('fresh'); expect(content).toContain('actual output');`
2. Run test: `bun test test/commands/dev.test.js` — confirm it fails (current gate doesn't have this language)
3. Implement: update the `<HARD-GATE: task completion>` block in `dev.md` with the verification-before-completion language
4. Run test: confirm it passes
5. Commit: `feat: add verification-before-completion to /dev task completion gate`

**Expected output**:
- `dev.md` task completion HARD-GATE includes:
  - "Run the implemented function/feature and observe actual output (not just tests)"
  - "Forbidden: 'should pass', 'looks good', 'seems to work' — these are not evidence"
  - "Required: paste actual command + actual output before marking task done"
- Test passes

---

## Task 4: Rename /check → /validate + add 4-phase debug mode

This is the largest task. Split into 4 sub-tasks for clarity, but implement as one committed change (keep atomic).

### Task 4a: Rename core files

**File(s)**:
- `.claude/commands/check.md` → `.claude/commands/validate.md`
- `lib/commands/check.js` → `lib/commands/validate.js`
- `test/commands/check.test.js` → `test/commands/validate.test.js`

**What to implement**:
- Copy check.md to validate.md, update heading and command references inside
- Copy check.js to validate.js, update function name exports (`executeCheck` → `executeValidate`, etc.) and the `require()` path in validate.test.js
- Delete original check.md, check.js, check.test.js after copies are correct
- Verify tests pass: `bun test test/commands/validate.test.js`

**TDD steps**:
1. Write test: `test/commands/validate.test.js` (copy of check.test.js with updated imports/names)
   - Key test: `'should run all validations in sequence'` using `executeValidate()` instead of `executeCheck()`
   - Additional test: `'should export executeValidate function'` — `const { executeValidate } = require('../../lib/commands/validate.js'); expect(typeof executeValidate).toBe('function')`
2. Run test: `bun test test/commands/validate.test.js` — confirm it fails (validate.js doesn't exist)
3. Implement: create validate.js (copy+rename from check.js), create validate.md (copy+rename from check.md)
4. Run test: confirm it passes
5. Do NOT delete check.js/check.md yet — wait for Task 4d to update all references first

### Task 4b: Add 4-phase debug mode to validate.md

**File(s)**:
- `.claude/commands/validate.md`
- `lib/commands/validate.js`
- `test/commands/validate.test.js`

**What to implement**:
Add debug mode as a new section in `validate.md` that activates when any validation step fails. The section must implement the 4-phase systematic debug flow:
- Phase D1: Reproduce — confirm failure is deterministic, exact error output
- Phase D2: Root-cause trace — trace failure to source (not symptom)
- Phase D3: Fix — SINGLE minimal fix, ONE change at a time, FAILING TEST FIRST
- Phase D4: Verify — re-run full validation from beginning, confirm fix works end-to-end

HARD-GATE in debug mode: "NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST" and "3+ fix attempts = STOP, question architecture."

In `lib/commands/validate.js`, add:
- `executeDebugMode({ error, fixAttempts })` — returns `{ escalate: bool, phase: 'D1'|'D2'|'D3'|'D4' }`
- When `fixAttempts >= 3` → returns `{ escalate: true, message: 'STOP: 3+ fixes. Question architecture before Fix #4.' }`

**TDD steps**:
1. Write test: `test/commands/validate.test.js` — add 3 tests:
   - `'should enter debug mode on validation failure'`
     - Input: `executeDebugMode({ error: 'Test failed: expected 42, got 0', fixAttempts: 0 })`
     - Expected: `{ escalate: false, phase: 'D1' }`
   - `'should escalate when 3+ fix attempts'`
     - Input: `executeDebugMode({ error: 'still failing', fixAttempts: 3 })`
     - Expected: `{ escalate: true, message: ... }`
   - `'should require fresh verification before claiming fix works'`
     - Input: `executeDebugMode({ error: 'err', fixAttempts: 1, claim: 'should be fixed now' })`
     - Expected: `{ valid: false, reason: 'No fresh verification evidence — run validation fresh' }`
2. Run test: confirm all 3 fail
3. Implement: add `executeDebugMode()` to `lib/commands/validate.js` AND add 4-phase debug section to `validate.md`
4. Run test: confirm all 3 pass
5. Hold commit until Task 4c complete

### Task 4c: Update all /check references in command docs

**File(s)**:
- `.claude/commands/dev.md`
- `.claude/commands/plan.md`
- `.claude/commands/ship.md`
- `.claude/commands/review.md`
- `.claude/commands/premerge.md`
- `.claude/commands/verify.md`
- `.claude/commands/research.md`
- `.claude/commands/rollback.md`
- `.claude/rules/workflow.md`
- `AGENTS.md`

**What to implement**:
Replace all `/check` references with `/validate` in the files listed above. Also update:
- `check.md` → `validate.md` in any file link (`[.claude/commands/check.md]`)
- `<HARD-GATE: /check exit>` → `<HARD-GATE: /validate exit>`
- Stage description in workflow table: "Type check, lint, code review, security, tests" → "Validate: type check, lint, tests, security. On failure: 4-phase debug mode."

**TDD steps**:
1. Write test: `test/commands/validate.test.js` — add test:
   - `'AGENTS.md should reference /validate not /check'`
     - `const content = fs.readFileSync('AGENTS.md', 'utf-8'); expect(content).not.toContain('/check'); expect(content).toContain('/validate');`
2. Run test: confirm it fails (AGENTS.md still has /check)
3. Implement: batch-replace `/check` → `/validate` across all listed files
4. Run test: confirm it passes
5. Hold commit until Task 4d complete

### Task 4d: Update docs + GitHub files, delete old check files

**File(s)**:
- `docs/WORKFLOW.md`
- `docs/TOOLCHAIN.md`
- `docs/VALIDATION.md`
- `docs/EXAMPLES.md`
- `docs/README-v1.3.md`
- `docs/ROADMAP.md`
- `docs/MANUAL_REVIEW_GUIDE.md`
- `docs/ENHANCED_ONBOARDING.md`
- `.github/CONTRIBUTING.md`
- `.github/pull_request_template.md`
- `.github/agentic-workflows/behavioral-test.md`
- Delete: `.claude/commands/check.md`, `lib/commands/check.js`, `test/commands/check.test.js`

**What to implement**:
- Batch-replace `/check` → `/validate` in all docs/ and .github/ files
- Delete the original check.md, check.js, check.test.js (now superseded)
- Update `check.md` links in CONTRIBUTING.md to point to `validate.md`

**TDD steps**:
1. Write test: `test/commands/validate.test.js` — add test:
   - `'check.md should no longer exist'`
     - `const exists = fs.existsSync('.claude/commands/check.md'); expect(exists).toBe(false);`
2. Run test: confirm it fails (check.md still exists)
3. Implement: replace in all docs files, then delete check.md, check.js, check.test.js
4. Run test: confirm it passes
5. Now run FULL test suite: `bun test` — confirm 1215 pass, 0 fail (minus the removed check.test.js tests now in validate.test.js)
6. Commit all Task 4a-4d changes: `feat: rename /check to /validate with 4-phase debug mode on failure`

---

## Flagged Tasks (No Design Doc Anchor — Pre-Cleared with User)

None. All tasks above map directly to confirmed requirements in the design doc.

---

## Summary

| Task | Files Changed | Type | Effort |
|---|---|---|---|
| Task 1: DRY gate | plan.md, plan.js, plan.phases.test.js | feature | Small |
| Task 2: YAGNI filter | plan.md, plan.js, plan.phases.test.js | feature | Small |
| Task 3: Verification gate | dev.md, dev.test.js | feature | Tiny |
| Task 4a: Core rename | validate.md, validate.js, validate.test.js | refactor | Medium |
| Task 4b: Debug mode | validate.md, validate.js, validate.test.js | feature | Medium |
| Task 4c: Command doc refs | 9 command/rule files | refactor | Small |
| Task 4d: Docs + delete | 8 docs + 3 github + 3 deletes | refactor | Small |

**Total**: 7 sub-tasks, ~4 distinct TDD cycles
