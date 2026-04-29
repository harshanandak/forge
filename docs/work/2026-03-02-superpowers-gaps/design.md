# Design Doc: superpowers-gaps

**Feature**: superpowers-gaps
**Date**: 2026-03-02
**Status**: Phase 3 complete — ready for /dev
**Branch**: feat/superpowers-gaps
**Beads**: forge-6od (in_progress)

---

## Purpose

Fill 5 workflow gaps identified in the OBRA/Superpowers integration research (`docs/research/superpowers.md`, `docs/research/superpowers-integration.md`, beads `forge-6od`):

1. **Worktree isolation** — `/plan` had no entry gate; planning could run on any branch, contaminating unrelated feature branches (discovered when superpowers-gaps commits leaked into forge-test-suite-v2 history)
2. **YAGNI enforcement** — No gate in `/plan` Phase 3 prevents over-scoped tasks
3. **DRY enforcement** — No gate in `/plan` Phase 2 checks for existing implementations before planning new ones
4. **Verification-before-completion** — `/dev` task completion and `/check` don't require end-to-end verification, only unit test passage
5. **Systematic debugging** — No structured investigation workflow when validation fails

These gaps mean: planning commits bleed into wrong branches (isolation), code gets planned that already exists (DRY), tasks get created that aren't in the design (YAGNI), and validation failures get "fixed" without root-cause investigation (debug).

---

## Success Criteria

1. ✅ `/plan` has a HARD-GATE at entry that checks the current branch, stops if not on master, then creates `feat/<slug>` + `.worktrees/<slug>` before any Phase 1 work begins (commit `86eaec8`)
2. ✅ `/plan` Phase 3 branch creation explicitly uses `git checkout master` as base, not the current branch (commit `9b31bd9`)
3. `/plan` Phase 2 includes an explicit DRY check step that searches for existing implementations before finalizing approach
4. `/plan` Phase 3 task-writing includes a YAGNI filter: each task must map to a requirement in the design doc; tasks without a design doc anchor are flagged
5. `/dev` task completion HARD-GATE requires actual behavior verification (run the feature/function, not just unit tests) before marking a task done
6. `/check` is renamed to `/validate` and upgraded: failure path triggers automatic 4-phase systematic debug mode (Reproduce → Root-cause → Fix → Verify) with HARD-GATE: no fix without completed root-cause phase
7. AGENTS.md, `docs/WORKFLOW.md`, and workflow table updated to reflect `/validate` naming and new capabilities
8. All existing tests pass after changes

---

## Out of Scope

- Separate `/debug` command — debug mode is embedded inside `/validate`
- New review subagent for YAGNI/DRY at code-writing time — enforcement is at planning stage
- Changes to `/dev` subagent architecture (spec → quality review stays 2-stage; scope compliance is handled in `/plan` pre-work)
- Changing how Beads integrates with existing commands
- Any changes to `/ship`, `/review`, `/premerge`, `/verify`

---

## Approach Selected: A+B Hybrid (inline gates + automatic review)

**Why not A alone (inline gates only)**: User explicitly wants best quality and automatic process evaluation. Inline planning gates catch scope creep at planning time, but the automatic 4-phase debug mode in `/validate` provides automated enforcement at validation time.

**Why not B alone (new subagent per task)**: Adding a scope compliance reviewer as a 3rd subagent per task in `/dev` would slow every task. YAGNI/DRY enforcement is better done at planning time (before any code is written) rather than per-task.

**The hybrid**:
- **Pre-code enforcement** (planning): DRY check in Phase 2, YAGNI filter in Phase 3 — catch problems before code is written
- **Post-code enforcement** (validation): Verification HARD-GATE in `/dev` task completion, automatic debug mode in `/validate` — catch problems before shipping

---

## Implementation Plan (High-Level)

### Change 1: DRY gate in `/plan` Phase 2
**File**: `.claude/commands/plan.md`
**Where**: Phase 2, codebase exploration section
**What**: Add an explicit step: before finalizing the approach, search the codebase for existing implementations that could be reused or extended. Document what was found and whether the new work extends existing code or starts fresh.

### Change 2: YAGNI filter in `/plan` Phase 3
**File**: `.claude/commands/plan.md`
**Where**: Phase 3, Step 5 (task list creation)
**What**: Add a YAGNI filter step after initial task drafting: for each task, confirm it maps to a specific requirement in the design doc. Tasks without a clear design doc anchor must be either (a) traced back to a requirement or (b) removed. Present any removed tasks to the user as "out of scope" before finalizing.

### Change 3: Verification HARD-GATE in `/dev` task completion
**File**: `.claude/commands/dev.md`
**Where**: Task completion HARD-GATE (currently at line ~178)
**What**: Upgrade the completion gate to require: in addition to tests passing, run the actual implemented function/feature and observe real output. This is the "verification-before-completion" pattern from Superpowers — tests can pass but behavior can still be wrong.

### Change 4: Rename `/check` to `/validate` + add debug mode
**Files**:
- `.claude/commands/check.md` → rename to `.claude/commands/validate.md`
- All references to `/check` in AGENTS.md, `docs/WORKFLOW.md`, `docs/plans/`, `.claude/rules/workflow.md`
**What**:
- Rename the command file
- Add failure path: when any validation step fails, automatically enter 4-phase debug mode:
  - **Phase D1: Reproduce** — confirm failure is deterministic, get exact error output
  - **Phase D2: Root-cause trace** — trace the failure to its actual source (not symptoms)
  - **Phase D3: Fix** — minimal targeted fix for the root cause
  - **Phase D4: Verify** — re-run full validation, confirm fix works end-to-end
- HARD-GATE: No fix commit without completing Phase D2 (root-cause confirmed in writing)
- After fix, automatically re-run validation from the beginning

---

## Constraints

- **Additive only**: No restructuring of existing phases, no removing steps
- **Lean gates**: YAGNI filter = checklist, not a new phase. DRY check = one search step, not a research loop. Gates should add ~2-3 lines of instruction, not new procedures.
- **No new ceremony**: Debug mode in `/validate` activates only on failure. Passing runs are unchanged.
- **Ambiguity policy**: Follow existing `/dev` decision gate (7-dimension scoring). Low-impact spec gaps → agent makes reasonable choice, documents in decisions file. High-impact gaps → pause and ask.

---

## Edge Cases (from Q&A)

1. **YAGNI filter removes all tasks**: If every task is flagged as out-of-scope, the design doc needs more requirements. Present this as "design doc doesn't cover all tasks — needs amendment" rather than error.
2. **DRY check finds partial match**: If codebase has something 80% similar, document it as "extend existing" in the approach — don't create a net-new implementation.
3. **Debug mode loops**: If Phase D3 fix doesn't resolve Phase D4 verify, re-enter Phase D1 with more specific reproduction steps. Max 3 debug cycles before surfacing to user with full context.
4. **Validation passes on re-run after fix, but fix is wrong**: Phase D4 requires not just "tests pass" but "behavior is correct" — run actual feature, not just tests.

---

## Ambiguity Policy

Follow existing `/dev` decision gate (7-dimension scoring system):
- Score ≤ threshold: Agent makes reasonable choice, documents in `docs/plans/YYYY-MM-DD-superpowers-gaps-decisions.md`
- Score > threshold: Pause and ask user

Phase 1 Q&A pre-resolved all major design questions. Remaining ambiguity should be rare.

---

## Technical Research

### YAGNI/DRY Enforcement — Key Findings

**Critical discovery**: Superpowers `writing-plans/SKILL.md` only contains "DRY. YAGNI. TDD." as aspirational bullet points — no actual gates or enforcement mechanisms. Our approach (proper HARD-GATE wording) is stronger than Superpowers' implementation.

**Effective YAGNI gate wording** (from Claude Code system prompts, Cursor rules, community research):
- "Do not add features, refactor, or improve beyond what was asked."
- "Only make changes that are directly requested or clearly necessary."
- "YAGNI: No speculative implementation." (applied during GREEN phase)

**Effective DRY gate wording**:
- "Check if logic already exists before writing new code." (Cursor rules)
- "Before creating new code, search the codebase for existing implementations" + explicit grep/glob tool calls

**Critical gotcha**: Aspirational lists ("DRY. YAGNI.") are ignored under pressure. Effective enforcement requires imperative gate language AND explicit search commands (not just "check"). Agents hallucinate that nothing equivalent exists if not forced to search with tools.

### Verification-Before-Completion — Key Findings

From `superpowers:verification-before-completion/SKILL.md`:

**Iron Law**: `NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE`

**5-step gate**:
1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
5. ONLY THEN: Make the claim

**Enforcement**: "Skip any step = lying, not verifying"

**Common failures table** (forbidden substitutes):
- "Tests pass" ← `"Previous run", "should pass"` is not evidence
- "Bug fixed" ← `"Code changed, assumed fixed"` is not evidence
- "Requirements met" ← `"Tests passing"` alone is not sufficient

**Red Flags — STOP**: Using "should", "probably", "seems to"; expressing satisfaction ("Great!", "Done!") before verification; trusting agent success reports.

### Systematic Debugging — Key Findings

From `superpowers:systematic-debugging/SKILL.md`:

**Iron Law**: `NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST`

**4-phase structure** (MUST complete each before proceeding):
- Phase 1: Root Cause Investigation (reproduce, trace data flow)
- Phase 2: Pattern Analysis (find working examples, compare references)
- Phase 3: Hypothesis and Testing (form SINGLE hypothesis, test MINIMALLY)
- Phase 4: Implementation (failing test FIRST, ONE change at a time)

**3-fix architectural HARD-GATE**: If >= 3 fix attempts fail → STOP, question architecture. Do NOT attempt Fix #4.

**Red Flags — STOP** (return to Phase 1):
- "Quick fix for now, investigate later"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"

**Key principle**: "Fix at source, not at symptom." Seeing symptoms ≠ understanding root cause.

### Rename Scope (/check → /validate)

**Files affected**: 25 files, ~70+ instances
- Command file: `.claude/commands/check.md` → `.claude/commands/validate.md`
- Implementation: `lib/commands/check.js` → `lib/commands/validate.js`
- Test file: `test/commands/check.test.js` → `test/commands/validate.test.js`
- Stage references in all command docs (dev.md, plan.md, ship.md, review.md, premerge.md, verify.md, research.md, rollback.md)
- Docs: AGENTS.md, docs/WORKFLOW.md, docs/TOOLCHAIN.md, docs/VALIDATION.md, docs/EXAMPLES.md, docs/README-v1.3.md, docs/ROADMAP.md, docs/MANUAL_REVIEW_GUIDE.md, docs/ENHANCED_ONBOARDING.md
- GitHub: .github/CONTRIBUTING.md, .github/pull_request_template.md, .github/agentic-workflows/behavioral-test.md
- Rules: .claude/rules/workflow.md

**Strategy**: Batch sed replacement across all files for `/check` → `/validate`, then manually update:
- File renames (check.md → validate.md, check.js → validate.js, check.test.js → validate.test.js)
- `<HARD-GATE: /check exit>` tag names
- Function names in check.js that reference "check" semantically

### OWASP Analysis

All changes are to `.md` instruction files and `.js` command implementations. No security surface: no user input, no cryptography, no access control, no external service calls.

Risk: Near-zero. No OWASP categories apply to this change type.

### TDD Test Scenarios

**Test 1 (Happy path — YAGNI filter)**:
- Input: plan Phase 3 with 5 tasks, 3 mapped to design doc, 2 not mapped
- Expected: `extractTasksFromDesign()` returns flagged tasks list: 2 tasks with `yaggniFlag: true`
- Test file: `test/commands/plan.phases.test.js`

**Test 2 (Happy path — /validate rename)**:
- Input: `executeValidate({ skip: ['lint', 'security', 'tests'] })`
- Expected: returns `{ success: boolean, checks: object, summary: string }` (same shape as check)
- Test file: `test/commands/validate.test.js`

**Test 3 (Verification gate — no completion without evidence)**:
- Input: `validateCompletion({ claimed: 'tests pass', evidence: null })`
- Expected: throws or returns `{ valid: false, reason: 'No fresh run evidence provided' }`
- Test file: `test/commands/validate.test.js`

**Test 4 (Edge case — all tasks flagged as YAGNI)**:
- Input: plan Phase 3 with design doc that has no matching tasks
- Expected: returns `{ allFlagged: true, message: 'Design doc doesn\'t cover all tasks — needs amendment' }`
- Test file: `test/commands/plan.phases.test.js`

**Test 5 (Debug mode — 3-fix architectural gate)**:
- Input: `debugMode({ fixAttempts: 3, error: 'test failure' })`
- Expected: returns `{ escalate: true, message: 'STOP: 3+ fixes attempted. Question architecture before Fix #4.' }`
- Test file: `test/commands/validate.test.js`

---

## Sources

- `docs/research/superpowers.md` — Full Superpowers analysis, 14 skills, HARD-GATE pattern
- `docs/research/superpowers-integration.md` — 5 integration options, decision matrix, recommended path
- `forge-6od` — Confirmed gaps list with primary sources
- `.claude/commands/plan.md` — Current plan command state (HARD-GATE blocks confirmed present)
- `.claude/commands/dev.md` — Current dev command state (two-stage review confirmed present)
- `.claude/commands/check.md` — Current check command state (verification-before-completion confirmed missing)
