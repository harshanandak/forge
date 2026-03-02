# Design Doc: superpowers-gaps

**Feature**: superpowers-gaps
**Date**: 2026-03-02
**Status**: Phase 1 approved, Phase 2 pending
**Branch**: feat/superpowers-gaps (to be created in Phase 3)
**Beads**: forge-6od (existing issue, covers confirmed gaps)

---

## Purpose

Fill 4 workflow gaps identified in the OBRA/Superpowers integration research (`docs/research/superpowers.md`, `docs/research/superpowers-integration.md`, beads `forge-6od`):

1. **YAGNI enforcement** — No gate in `/plan` Phase 3 prevents over-scoped tasks
2. **DRY enforcement** — No gate in `/plan` Phase 2 checks for existing implementations before planning new ones
3. **Verification-before-completion** — `/dev` task completion and `/check` don't require end-to-end verification, only unit test passage
4. **Systematic debugging** — No structured investigation workflow when validation fails

These gaps mean: code gets planned that already exists (DRY), tasks get created that aren't in the design (YAGNI), and validation failures get "fixed" without root-cause investigation (debug).

---

## Success Criteria

1. `/plan` Phase 2 includes an explicit DRY check step that searches for existing implementations before finalizing approach
2. `/plan` Phase 3 task-writing includes a YAGNI filter: each task must map to a requirement in the design doc; tasks without a design doc anchor are flagged
3. `/dev` task completion HARD-GATE requires actual behavior verification (run the feature/function, not just unit tests) before marking a task done
4. `/check` is renamed to `/validate` and upgraded: failure path triggers automatic 4-phase systematic debug mode (Reproduce → Root-cause → Fix → Verify) with HARD-GATE: no fix without completed root-cause phase
5. AGENTS.md, `docs/WORKFLOW.md`, and workflow table updated to reflect `/validate` naming and new capabilities
6. All existing tests pass after changes

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

*(To be filled in Phase 2)*

---

## Sources

- `docs/research/superpowers.md` — Full Superpowers analysis, 14 skills, HARD-GATE pattern
- `docs/research/superpowers-integration.md` — 5 integration options, decision matrix, recommended path
- `forge-6od` — Confirmed gaps list with primary sources
- `.claude/commands/plan.md` — Current plan command state (HARD-GATE blocks confirmed present)
- `.claude/commands/dev.md` — Current dev command state (two-stage review confirmed present)
- `.claude/commands/check.md` — Current check command state (verification-before-completion confirmed missing)
