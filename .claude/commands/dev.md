---
description: Subagent-driven TDD implementation per task from /plan task list
---

Implement each task from the /plan task list using a subagent-driven loop: implementer → spec compliance reviewer → code quality reviewer per task.

# Dev

This command reads the task list created by `/plan` and implements each task using a three-stage subagent loop. TDD is enforced inside each implementer subagent.

## Usage

```bash
/dev
```

---

## Setup

### Step 1: Load context

```bash
# Find task list and design doc
ls docs/plans/
```

Read:
- **Task list**: `docs/plans/YYYY-MM-DD-<slug>-tasks.md` — extract ALL task text upfront
- **Design doc**: `docs/plans/YYYY-MM-DD-<slug>-design.md` — including ambiguity policy section

### Step 2: Create decisions log

Create an empty decisions log at the start of every /dev session:

```bash
# docs/plans/YYYY-MM-DD-<slug>-decisions.md
```

Format for each entry:
```
## Decision N
**Date**: YYYY-MM-DD
**Task**: Task N — <title>
**Gap**: [what the spec didn't cover]
**Score**: [filled checklist total]
**Route**: PROCEED / SPEC-REVIEWER / BLOCKED
**Choice made**: [if PROCEED: what was decided and why]
**Status**: RESOLVED / PENDING-DEVELOPER-INPUT
```

### Step 3: Pre-flight checks

```
<HARD-GATE: /dev start>
Do NOT write any code until ALL confirmed:
1. git branch --show-current output is NOT main or master
2. git worktree list shows the worktree path for this feature
3. Task list file confirmed to exist (use Read tool — do not assume)
4. Decisions log file created
</HARD-GATE>
```

---

## Per-Task Loop

Repeat for each task in the task list, in order:

### Step A: Dispatch implementer subagent

Provide the subagent with:
- **Full task text** (copy the complete task content — do NOT send just the file path)
- **Relevant design doc sections** for this task
- **Recent git log** showing what has already been implemented

The implementer subagent:
1. Asks clarifying questions before writing any code
2. Implements using RED-GREEN-REFACTOR
3. Self-reviews for correctness
4. Commits with a descriptive message

```
<HARD-GATE: TDD enforcement (inside implementer subagent)>
Do NOT write any production code until:
1. A FAILING test exists for that code
2. The test has been run and output shows it FAILING
3. The failure reason matches the expected missing behavior

If code was written before its test: delete it. Start with the test.
"The test would obviously fail" is not evidence. Run it and show the output.
</HARD-GATE>
```

---

### Step B: Decision gate (when implementer hits a spec gap)

If the implementer encounters something not specified in the design doc, STOP and fill this checklist BEFORE deciding how to proceed:

```
Gap: [describe exactly what the spec doesn't cover]

Score each dimension (0=No / 1=Possibly / 2=Yes):
[ ] 1. Files affected beyond the current task?
[ ] 2. Changes a function signature or public export?
[ ] 3. Changes a shared module used by other tasks?
[ ] 4. Changes or touches persistent data or schema?
[ ] 5. Changes user-visible behavior not discussed in design doc?
[ ] 6. Affects auth, permissions, or data exposure?
[ ] 7. Hard to reverse without cascading changes to other files?
TOTAL: ___ / 14

Mandatory overrides — any of these = automatically BLOCKED:
[ ] Security dimension (6) scored 2
[ ] Schema migration or data model change
[ ] Removes or changes an existing public API endpoint
[ ] Affects a task that is already implemented and committed
```

**Score routing**:
- **0-3**: PROCEED — make the decision, document in decisions log with full reasoning
- **4-7**: SPEC-REVIEWER — route this decision to spec reviewer. Continue other independent tasks while waiting
- **8+, or any mandatory override triggered**: BLOCKED — document in decisions log with Status=PENDING-DEVELOPER-INPUT. Complete all other independent tasks first. Surface to developer at /dev exit

Log the decision entry before continuing.

---

### Step C: Spec compliance review

After the implementer finishes the task, dispatch a **spec compliance reviewer** subagent.

Provide:
- Full task text (what was supposed to be implemented)
- Relevant design doc sections
- `git diff` for this task's commits

Reviewer checks:
- All requirements from the task text are implemented
- Nothing extra was added beyond task scope
- Edge cases documented in design doc are handled
- TDD evidence: test exists, test was run failing, then passing

If spec issues found: implementer fixes → re-review → repeat until ✅

```
<HARD-GATE: spec before quality>
Do NOT dispatch code quality reviewer until spec compliance reviewer returns ✅ for this task.
Running quality review before spec compliance is the wrong order.
</HARD-GATE>
```

---

### Step D: Code quality review

After spec ✅, dispatch a **code quality reviewer** subagent.

Provide:
- git SHAs for this task's commits
- The changed code (`git diff`)

Reviewer checks:
- Naming: clear, descriptive, consistent with codebase conventions
- Structure: functions not too long, proper separation of concerns
- Duplication: no copy-paste that could be extracted
- Test coverage: tests cover happy path and at least one error path
- No magic numbers, no commented-out code, no TODO without a Beads issue

If quality issues found: implementer fixes → re-review → repeat until ✅

---

### Step E: Task completion

```
<HARD-GATE: task completion>
Do NOT mark task complete or move to next task until ALL confirmed in this session:
1. Spec compliance reviewer returned ✅
2. Code quality reviewer returned ✅
3. Tests run fresh — output shows passing (not "should pass" or "was passing earlier")
4. Implementer has committed (git log shows the commit)
</HARD-GATE>
```

Mark task complete. Move to next task.

---

## /dev Completion

After all tasks are complete (or BLOCKED):

### Final code review

Dispatch a final code reviewer for the full implementation:
- Overall coherence: does the feature hang together as a whole?
- Cross-task consistency: naming, patterns, style consistent across all tasks?
- Integration: do all the pieces connect correctly?

### Surface BLOCKED decisions

If any decisions have Status=PENDING-DEVELOPER-INPUT:

```
⏸️  /dev blocked — developer input needed

The following decisions were deferred during implementation:

Decision 1: [gap description]
  Task: Task N — <title>
  Score: 11/14 (mandatory override: schema change)
  Options considered: [A] vs [B]
  Recommendation: [A] because [reason]
  Blocked tasks: Task 6, Task 7 (depend on this decision)

Decision 2: ...

Please review and respond. After decisions are resolved, the implementer
will complete the blocked tasks and re-run spec + quality review.
```

Wait for developer input. After decisions resolved: implement blocked tasks → spec review → quality review → complete.

### /dev exit gate

```
<HARD-GATE: /dev exit>
Do NOT declare /dev complete until:
1. All tasks are marked complete OR have BLOCKED status with PENDING-DEVELOPER-INPUT
2. BLOCKED decisions have been surfaced to developer and are awaiting input
3. Final code reviewer has approved (or issues fixed and re-reviewed)
4. All decisions in decisions log have Status of RESOLVED or PENDING-DEVELOPER-INPUT
5. No unresolved spec or quality issues remain
</HARD-GATE>
```

### Beads update

```bash
bd update <id> --comment "Implementation complete: N tasks done, M decisions logged"
```

---

## Decision Gate Calibration

The frequency of decision gates is a **plan quality metric**:
- **0 gates fired**: Excellent — Phase 1 Q&A covered all cases
- **1-2 gates fired**: Good — minor gaps, normal
- **3-5 gates fired**: Plan was incomplete — note for Phase 1 improvement next feature
- **5+ gates fired**: Phase 1 Q&A was insufficient — the ambiguity policy field needed to be more specific

Document the gate count in the final commit message.

---

## Example Output (all tasks complete)

```
✓ Task 1: Types and interfaces — COMPLETE
  Spec: ✅  Quality: ✅  Tests: 4/4 passing  Commit: abc1234
  Decision gates: 0

✓ Task 2: Validation logic — COMPLETE
  Spec: ✅  Quality: ✅  Tests: 8/8 passing  Commit: def5678
  Decision gates: 1 (PROCEED, score 2 — documented in decisions log)

✓ Task 3: API endpoint — COMPLETE
  Spec: ✅  Quality: ✅  Tests: 6/6 passing  Commit: ghi9012
  Decision gates: 0

✓ Final code review: ✅ (coherent, consistent, correctly integrated)

✓ Decisions log: docs/plans/2026-02-26-stripe-billing-decisions.md
  - Decision 1: RESOLVED (score 2, proceeded with conservative choice)
  - Decision gates fired: 1 (plan quality: Good)

✓ Beads updated: forge-xyz → implementation complete

Ready for /check
```

## Integration with Workflow

```
Utility: /status     → Understand current context before starting
Stage 1: /plan       → Design intent → research → branch + worktree + task list
Stage 2: /dev        → Implement each task with subagent-driven TDD (you are here)
Stage 3: /check      → Type check, lint, tests, security — all fresh output
Stage 4: /ship       → Push + create PR
Stage 5: /review     → Address GitHub Actions, Greptile, SonarCloud
Stage 6: /premerge   → Update docs, hand off PR to user
Stage 7: /verify     → Post-merge CI check on main
```

## Tips

- **Send full task text to subagents**: Never send the file path — copy the complete task text directly into the subagent prompt
- **TDD lives inside the implementer**: The implementer subagent is responsible for RED-GREEN-REFACTOR, not the orchestrating /dev session
- **Spec before quality — always**: A task that passes quality review but fails spec compliance has still failed
- **Decision gates are rare with a good plan**: If gates fire frequently, the Phase 1 Q&A needs more depth next time
- **BLOCKED ≠ failed**: Surfacing a blocked decision with documentation and a recommendation is the correct behavior
