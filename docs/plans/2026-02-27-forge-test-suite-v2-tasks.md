# Task List: Forge Test Suite v2

**Feature**: forge-test-suite-v2
**Beads**: forge-5vf
**Branch**: feat/forge-test-suite-v2
**Design doc**: docs/plans/2026-02-27-forge-test-suite-v2-design.md
**Baseline**: 107/107 tests passing

---

## Ordering Rationale

1. **Delete stale code first** (Tasks 1-2) — removes dead exports so new tests can't accidentally pass by testing removed code
2. **Unit tests for lib functions** (Tasks 3-5) — deterministic, fast, bun:test migration
3. **Structural command-file tests** (Task 6) — no lib dependency, can run independently
4. **commitlint script tests** (Task 7) — isolated, no lib dependency
5. **gh-aw behavioral workflow** (Tasks 8-10) — CI-only, built last after unit tests confirm baseline

---

## Task 1: Audit and delete stale lib exports

**File(s)**: `lib/commands/research.js`, `lib/commands/plan.js`

**What to implement**:
Grep entire codebase for imports/requires of `lib/commands/research.js` and the OpenSpec functions in `lib/commands/plan.js` (`createOpenSpecProposal`, `formatProposalPRBody`, `createProposalPR`). If zero usages found outside test files, delete `lib/commands/research.js` entirely and remove the three OpenSpec functions from `lib/commands/plan.js`. Update `package.json` exports if needed.

**TDD steps**:
1. Write test: none — this is a deletion task. Run `grep -r "require.*commands/research" . --include="*.js" --exclude-dir=node_modules --exclude-dir=test` and `grep -r "createOpenSpecProposal\|formatProposalPRBody\|createProposalPR" . --include="*.js" --exclude-dir=node_modules --exclude-dir=test` first.
2. Confirm zero usages outside test files
3. Delete `lib/commands/research.js`
4. Remove OpenSpec functions from `lib/commands/plan.js`
5. Run `bun test` — if any test now fails with "Cannot find module", that test was using the deleted code and must also be deleted in Task 2
6. Commit: `refactor: delete stale research lib and OpenSpec functions`

**Expected output**: `bun test` still passes all non-stale tests. Zero references to deleted exports in non-test files.

---

## Task 2: Delete stale test files

**File(s)**: `test/commands/research.test.js`, `test/commands/plan.test.js` (OpenSpec tests only)

**What to implement**:
Delete `test/commands/research.test.js` entirely — it tests `lib/commands/research.js` which no longer exists after Task 1. In `test/commands/plan.test.js`, remove the test blocks for `createOpenSpecProposal`, `formatProposalPRBody`, `createProposalPR`, and `createProposalPR`. Keep `detectScope`, `createBeadsIssue`, `createFeatureBranch`, `extractDesignDecisions` — these are still valid. Migrate kept tests from `node:test` to `bun:test` import syntax in the same step.

**TDD steps**:
1. Write test: none — deletion task
2. Delete `test/commands/research.test.js`
3. Remove OpenSpec test blocks from `test/commands/plan.test.js`
4. Migrate remaining `plan.test.js` imports: `require('node:test')` → `import { describe, test } from "bun:test"`, `require('node:assert/strict')` → `import { expect } from "bun:test"`
5. Run `bun test test/commands/plan.test.js` — must pass
6. Commit: `refactor: delete stale research tests and OpenSpec test blocks`

**Expected output**: `test/commands/research.test.js` does not exist. `test/commands/plan.test.js` has no OpenSpec references.

---

## Task 3: Add Phase 1/2/3 coverage to plan.test.js

**File(s)**: `test/commands/plan.test.js`, `lib/commands/plan.js`

**What to implement**:
Add test coverage for the new `/plan` workflow mechanics. Tests use `bun:test` with `mock.module` for `node:child_process` and `node:fs`. Add mock.module declarations at the top of the file BEFORE any lib import. Cover:

- `validateDesignDoc(content)` — returns `{ valid: true, sections: [...] }` for complete doc; `{ valid: false, missing: ['OWASP'] }` for missing OWASP section
- `validateDesignDoc` minimum content length check — OWASP section < 200 chars → invalid
- `validateDesignDoc` placeholder detection — doc containing "[describe" → invalid
- `validateTaskList(content)` — returns `{ valid: true, taskCount: N }` when ≥3 tasks with TDD steps; `{ valid: false, reason: '...' }` when < 50% of tasks have RED/GREEN/REFACTOR
- `readResearchDoc` now reads from `docs/plans/` (not `docs/research/`) — assert correct path
- `createFeatureBranch` with `--strategic` flag — assert proposal branch naming `feat/<slug>-proposal`

**TDD steps**:
1. Write test: `describe("validateDesignDoc")` block with 5 cases (happy path, missing OWASP, short OWASP, placeholder, missing HARD-GATE)
2. Run: confirm RED — `validateDesignDoc is not a function`
3. Implement `validateDesignDoc(content)` in `lib/commands/plan.js`
4. Run: confirm GREEN
5. Write test: `describe("validateTaskList")` block with 3 cases (≥3 tasks all with TDD, ≥3 tasks only 30% with TDD → invalid, < 3 tasks → invalid)
6. Run: confirm RED
7. Implement `validateTaskList(content)` in `lib/commands/plan.js`
8. Run: confirm GREEN
9. Write test: `readResearchDoc` path assertion — mock `fs.existsSync` to capture the path argument, assert it includes `docs/plans/`
10. Run: confirm GREEN or RED depending on current path in lib
11. Fix path in lib if needed
12. Commit: `test: add Phase 1/2/3 coverage to plan.test.js` then `feat: add validateDesignDoc and validateTaskList`

**Expected output**: All new tests pass. `validateDesignDoc` and `validateTaskList` exported from `lib/commands/plan.js`.

---

## Task 4: Add decision gate + subagent tests to dev.test.js

**File(s)**: `test/commands/dev.test.js`, `lib/commands/dev.js`

**What to implement**:
Migrate `test/commands/dev.test.js` from `node:test` to `bun:test`. Add `mock.module` for `node:child_process` at top before lib import. Add coverage for:

- `evaluateDecisionGate(score)` — score 0-3 → `{ route: 'PROCEED' }`, score 4-7 → `{ route: 'SPEC-REVIEWER' }`, score 8+ → `{ route: 'BLOCKED' }`
- `orderReviewers(task)` — always returns spec compliance reviewer BEFORE code quality reviewer (spec-before-quality HARD-GATE)
- `dispatchImplementer(task, designDoc)` — mock the subprocess call, assert it receives full task text (not just task number), assert it receives relevant design doc sections
- `dispatchImplementer` with missing task list → returns `{ success: false, error: 'task-list-not-found' }`

**TDD steps**:
1. Migrate existing `dev.test.js` imports to `bun:test` (same pattern as Task 2)
2. Add `mock.module("node:child_process", ...)` at top
3. Write test: `describe("evaluateDecisionGate")` — 3 score ranges, 3 boundary cases (0, 3, 4, 7, 8, 15)
4. Run: confirm RED — `evaluateDecisionGate is not a function`
5. Implement `evaluateDecisionGate(score)` in `lib/commands/dev.js`
6. Run: confirm GREEN
7. Write test: `describe("orderReviewers")` — assert spec reviewer index < quality reviewer index in returned array
8. Run: confirm RED or GREEN (may already exist)
9. Implement or fix `orderReviewers` if needed
10. Write test: `describe("dispatchImplementer")` — mock `execFileSync`, assert call args contain full task text
11. Run: confirm RED → implement → GREEN
12. Commit: `test: add decision gate and subagent dispatch tests` then `feat: implement evaluateDecisionGate and orderReviewers`

**Expected output**: Decision gate routing tested at all 6 boundary values. Spec-before-quality ordering verified. Subagent dispatch mock asserts correct arguments.

---

## Task 5: Add commitlint script tests

**File(s)**: `test/scripts/commitlint.test.js` (new file), `scripts/commitlint.js`

**What to implement**:
Create `test/scripts/commitlint.test.js`. Test the cross-platform commitlint runner. Use `bun:test` with `mock.module` for `node:child_process` and `node:fs`.

Cover:
- `getCommitlintRunner()` — `bun.lock` exists → returns `'bunx'`; no `bun.lock` → returns `'npx'`
- `getCommitlintRunner()` on Windows (`process.platform === 'win32'`) → shell option is `true`
- Missing commit message file argument → process exits with code 1 + error message
- Exit code propagation — if spawnSync returns `{ status: 1 }`, script exits with 1
- Exit code propagation — if spawnSync returns `{ status: 0 }`, script exits with 0

**TDD steps**:
1. Write test file with 5 test cases listed above
2. Run: confirm RED — `test/scripts/commitlint.test.js` doesn't exist yet, or functions not exported
3. Refactor `scripts/commitlint.js` to export `getCommitlintRunner()` for testability (extract from inline logic), keep `if (require.main === module)` guard for CLI usage
4. Run: confirm GREEN
5. Commit: `test: add commitlint script tests` then `refactor: extract getCommitlintRunner for testability`

**Expected output**: 5 tests passing for `scripts/commitlint.js`. Function exported without breaking lefthook hook behavior.

---

## Task 6: Add structural command-file tests

**File(s)**: `test/commands/plan-structure.test.js` (new file), `test/commands/dev-structure.test.js` (new file)

**What to implement**:
Using the same pattern as `test/ci-workflow.test.js` (reads a file and asserts content structure), create two test files that read `.claude/commands/plan.md` and `.claude/commands/dev.md` and assert required structural elements exist:

**plan-structure.test.js asserts:**
- `<!-- WORKFLOW-SYNC:START -->` and `<!-- WORKFLOW-SYNC:END -->` markers present
- Phase 1 header `## Phase 1` exists
- Phase 2 header `## Phase 2` exists
- Phase 3 header `## Phase 3` exists
- `<HARD-GATE: Phase 1 exit>` block exists
- `<HARD-GATE: Phase 2 exit>` block exists
- `<HARD-GATE: /plan exit>` block exists
- `Skill("parallel-web-search")` call present in Phase 2
- `git worktree add` command present in Phase 3
- `docs/plans/` path present (not `docs/research/`)
- `docs/plans/YYYY-MM-DD-<slug>-tasks.md` task list path format present

**dev-structure.test.js asserts:**
- `<HARD-GATE: /dev entry>` block exists
- Spec compliance reviewer step present (text: "Spec compliance reviewer" or "spec-before-quality")
- Code quality reviewer step present AFTER spec reviewer
- Decision gate scoring documented (text: "PROCEED", "SPEC-REVIEWER", "BLOCKED" all present)
- `docs/plans/` path present for task list reading
- `decisions.md` path present

**TDD steps**:
1. Write `test/commands/plan-structure.test.js` with all assertions (using `fs.readFileSync` + `includes()`, same pattern as ci-workflow.test.js)
2. Run: confirm which assertions pass/fail against current `.claude/commands/plan.md`
3. Fix any missing markers in `.claude/commands/plan.md` (add WORKFLOW-SYNC markers if missing)
4. Run: GREEN for plan-structure
5. Write `test/commands/dev-structure.test.js`
6. Run: confirm which pass/fail
7. Fix any missing markers in `.claude/commands/dev.md`
8. Run: GREEN for dev-structure
9. Commit: `test: add structural command-file tests for plan and dev`

**Expected output**: Both structural test files pass. `.claude/commands/plan.md` and `dev.md` contain all required structural markers.

---

## Task 7: Update test script in package.json

**File(s)**: `package.json`

**What to implement**:
Add the new test files to the `bun test` script in `package.json` so they run in CI:
- `test/commands/plan.test.js`
- `test/commands/dev.test.js`
- `test/commands/plan-structure.test.js`
- `test/commands/dev-structure.test.js`
- `test/scripts/commitlint.test.js`

Also verify `test/commands/check.test.js`, `test/commands/ship.test.js`, `test/commands/status.test.js` are already included or add them.

Run full `bun test` with the updated script to confirm all tests pass.

**TDD steps**:
1. Read current `package.json` test script
2. Add new test file paths
3. Run `bun test <all files>` — confirm all pass
4. Commit: `chore: add new test files to bun test script`

**Expected output**: `bun test` (using package.json script) runs all test files and all pass.

---

## Task 8: Create gh-aw behavioral workflow markdown

**File(s)**: `.github/workflows/behavioral-test.md` (new file), `.github/workflows/detect-command-file-changes.yml` (new file)

**What to implement**:
Create the gh-aw behavioral test workflow in markdown format. Two files:

**`detect-command-file-changes.yml`** — lightweight standard GitHub Actions YAML that triggers when `.claude/commands/plan.md`, `.claude/commands/dev.md`, or `AGENTS.md` changes on push to master. This fires `workflow_run` on the behavioral test.

**`.github/workflows/behavioral-test.md`** — gh-aw markdown workflow:

```yaml
---
name: forge-workflow-behavioral-test
description: "Tests that a real AI agent correctly follows the Forge /plan workflow"
on:
  - schedule: "0 3 * * SUN"
  - workflow_dispatch
  - workflow_run:
      workflows: ["detect-command-file-changes.yml"]
      types: [completed]
permissions:
  contents: read
  actions: read
secrets:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
engine:
  type: claude
  model: claude-sonnet-4-6
  max-turns: 20
tools:
  - bash
  - edit
  - github:
      toolsets: [repos, actions]
---
```

Markdown body instructs the agent to:
1. Create a temp directory as synthetic test repo
2. Run `/plan` on 3-4 rotating test prompts
3. Assert artifacts exist (design doc, task list)
4. Save Q&A transcript to temp file
5. Run judge evaluation (curl to OpenRouter with MiniMax M2.5)
6. Parse judge JSON output
7. Apply 3-layer scoring (blockers → dimensions → band)
8. Append score to `.github/behavioral-test-scores.json`
9. If FAIL → exit non-zero (fails the workflow run)
10. If INCONCLUSIVE (API error) → exit 0 with warning comment
11. Cleanup temp directory

**TDD steps**:
1. Write `detect-command-file-changes.yml` (standard YAML, no gh-aw)
2. Write `.github/workflows/behavioral-test.md` with frontmatter + markdown body
3. Run `gh aw compile .github/workflows/behavioral-test.md` to generate `.lock.yml`
4. Verify `.lock.yml` was created and is valid YAML
5. Commit: `feat: add gh-aw behavioral test workflow`

**Expected output**: Both files exist. `.github/workflows/behavioral-test.lock.yml` generated and committed.

---

## Task 9: Create judge scoring script

**File(s)**: `scripts/behavioral-judge.sh` (new file)

**What to implement**:
Bash script called by the behavioral test workflow to run the judge evaluation. Takes design doc path + task list path + Q&A transcript path as args. Calls OpenRouter MiniMax M2.5, parses response, applies 3-layer scoring, returns JSON result.

Covers all 16 loophole fixes:
- Layer 1 blocker checks (existence, content length, placeholder detection, timestamp recency, majority TDD threshold)
- Layer 2 weighted scoring (security ×3, TDD ×3, design ×2, structural ×1, max 45)
- Layer 3 trend comparison (read previous score from `.github/behavioral-test-scores.json`, compare per-dimension)
- INCONCLUSIVE on API errors (429/5xx)
- Calibration mode flag (first 4 runs don't enforce FAIL gate)
- Minimax M2.5 with MiniMax K2.5 fallback

**TDD steps**:
1. Write `test/scripts/behavioral-judge.test.js` with mocked OpenRouter responses covering:
   - All Layer 1 blockers fire correctly
   - Weighted scoring math (security 4/5 × 3 = 12, etc.)
   - INCONCLUSIVE on 429
   - Calibration mode: score below threshold but result is still PASS (with warning)
   - Trend alert: current score 20, previous was 29 → ≥8 point drop → alert
2. Run: confirm RED
3. Implement `scripts/behavioral-judge.sh` (bash) + export testable functions to a `lib/behavioral-judge.js` wrapper for unit testing
4. Run: confirm GREEN
5. Commit: `test: add behavioral judge scoring tests` then `feat: implement behavioral judge scoring script`

**Expected output**: Judge script handles all 16 loophole scenarios correctly. INCONCLUSIVE does not cause FAIL.

---

## Task 10: Add CI sync check for .lock.yml

**File(s)**: `.github/workflows/test.yml`

**What to implement**:
Add a job to `test.yml` that verifies `.github/workflows/behavioral-test.lock.yml` is in sync with `.github/workflows/behavioral-test.md`. On every PR and push, runs `gh aw compile --dry-run` and diffs output against committed `.lock.yml`. Fails if they diverge.

Also add: `test/workflows/behavioral-test-sync.test.js` that asserts the `.lock.yml` exists and is non-empty (structural sanity check without requiring gh-aw CLI in unit test environment).

**TDD steps**:
1. Write `test/workflows/behavioral-test-sync.test.js` — assert `.github/workflows/behavioral-test.lock.yml` exists and `behavioral-test.md` exists
2. Run: RED (files don't exist yet from Task 8)
3. After Task 8 creates the files, rerun: GREEN
4. Add sync check job to `.github/workflows/test.yml`
5. Run `gh pr checks` to verify new job appears
6. Commit: `test: add behavioral test lock file sync check`

**Expected output**: CI fails if `.lock.yml` is out of sync with `.md`. Structural test confirms both files exist.

---

## Parallelization Map

```
Sequential (must run in order):
  Task 1 (delete stale lib) → Task 2 (delete stale tests) → Task 3-5 (unit tests)

Parallel after Task 2:
  Track A: Tasks 3, 4, 5 (unit tests — independent of each other)
  Track B: Task 6 (structural tests — no lib dependency)
  Track C: Task 7 (package.json — wait for Tasks 3-6 to know file names)

Sequential after all unit/structural tests:
  Task 8 → Task 9 → Task 10 (behavioral workflow — builds on stable unit test foundation)
```
