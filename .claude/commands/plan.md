---
description: Design intent → research → branch + worktree + task list
---

Plan a feature from scratch: brainstorm design intent, research technical approach, then set up branch, worktree, and a complete task list ready for /dev.

# Plan

This command runs in **3 phases**. Each phase ends with a HARD-GATE. Do not skip phases.

---

```
<HARD-GATE: /plan entry — worktree isolation>
Before ANY planning work begins:

1. Run: git branch --show-current
2. If the current branch is NOT master/main:
   - STOP. Do not begin Phase 1.
   - Tell the user: "You are on '<branch>'. Planning must start from a clean worktree on master.
     Run: git checkout master — then re-run /plan."
3. If on master, create the worktree NOW before asking any questions:
   a. git worktree add -b feat/<slug> .worktrees/<slug>
   b. cd .worktrees/<slug>
4. Confirm: "Working in isolated worktree: .worktrees/<slug> (branch: feat/<slug>)"
5. ONLY THEN begin Phase 1.

Rationale: Planning commits (design docs, task lists) belong only to this feature's branch.
If planning runs in the main directory on a non-master branch, those commits contaminate
whatever branch is currently checked out. The worktree ensures zero cross-contamination
between parallel features or sessions.
</HARD-GATE>
```

---

## Usage

```bash
/plan <feature-slug>
/plan <feature-slug> --strategic   # Major architecture change: creates design doc PR before Phase 2
/plan <feature-slug> --continue    # After --strategic PR is merged: run Phase 2 + 3
```

---

## Phase 1: Design Intent (Brainstorming)

**Goal**: Capture WHAT to build — purpose, constraints, success criteria, edge cases, approach.

### Step 1: Explore project context

Before asking any questions, read relevant files:
- Recent commits related to this area
- Existing code in affected modules
- Any related docs, tests, or prior research

### Step 2: Ask clarifying questions — one at a time

Ask each question in sequence. Wait for user response. Use multiple choice where possible.

Questions to cover (adapt to feature, don't ask mechanical copies):
1. **Purpose** — What problem does this solve? Who benefits?
2. **Constraints** — What must this NOT do? What are the hard limits?
3. **Success criteria** — How will we know it's done? What is the minimum viable result?
4. **Edge cases** — What happens when [key dependency] fails / [input] is missing / [state] is ambiguous?
5. **Technical preferences** — Library A or B? Pattern X or Y? (when real options exist)
6. **Ambiguity policy** — If a spec gap is found mid-dev, should the agent: (a) make a reasonable choice and document it, or (b) pause and wait for input?

### Step 3: Propose approaches

Propose 2-3 concrete approaches with:
- Trade-offs (speed vs safety, complexity vs flexibility)
- A clear recommendation with reasoning
- Get user approval on the chosen approach

### Step 4: Write design doc

Save to `docs/plans/YYYY-MM-DD-<slug>-design.md` with these sections:
- **Feature**: slug, date, status
- **Purpose**: what problem it solves
- **Success criteria**: measurable, specific
- **Out of scope**: explicit boundaries
- **Approach selected**: which option and why
- **Constraints**: hard limits
- **Edge cases**: decisions made during Q&A
- **Ambiguity policy**: agent's fallback when spec gaps arise mid-dev

Commit the design doc:
```bash
git add docs/plans/YYYY-MM-DD-<slug>-design.md
git commit -m "docs: add design doc for <slug>"
```

---

**--strategic flag** (for major architecture changes):

After committing the design doc, push to a proposal branch and open PR:
```bash
git checkout -b feat/<slug>-proposal
git push -u origin feat/<slug>-proposal
gh pr create --title "Design: <feature-name>" \
  --body "Design doc for review. See docs/plans/YYYY-MM-DD-<slug>-design.md"
```

**STOP here.** Present the PR URL. Wait for the user to merge the proposal PR.
After merge, run `/plan <slug> --continue` to proceed to Phase 2 + 3.

---

```
<HARD-GATE: Phase 1 exit>
Do NOT begin Phase 2 (web research) until:
1. User has approved the design in this session
2. Design doc exists at docs/plans/YYYY-MM-DD-<slug>-design.md
3. Design doc includes: success criteria, edge cases, out-of-scope, ambiguity policy
4. Design doc is committed to git
</HARD-GATE>
```

---

## Phase 2: Technical Research

**Goal**: Find HOW to build it — best practices, known issues, security risks, TDD scenarios.

Run these in parallel:

### Web research (parallel-deep-research skill)
```
Skill("parallel-deep-research")
```
Search for:
- "[tech stack] [feature] best practices [year]"
- "[library/framework] [feature] implementation patterns"
- "Known issues / gotchas with [approach selected]"

### OWASP Top 10 analysis

For this feature's risk surface, document each relevant OWASP category:
- What the risk is
- Whether it applies to this feature
- What mitigation will be implemented

### Codebase exploration (Explore agent)
- Similar existing patterns to reuse
- Files this feature will affect
- Existing test infrastructure to leverage

### DRY check (mandatory — use actual search tools)

Before finalizing the approach, run Grep/Glob/Read searches for existing implementations of the planned function or pattern. Do not rely on memory or assumptions — execute the searches.

```
Grep(searchTerm)   # e.g., the function or concept name
Glob("**/*.js")    # narrow to affected file types if needed
Read(matchedFile)  # inspect any match in context
```

If a match is found:
- Update the design doc's "Approach selected" section to say "extend existing [file/function]" — not "create new".
- Note the existing file path and line number in the design doc.

If no match is found: proceed. The DRY gate is cleared.

### TDD test scenarios

Identify at minimum 3 test scenarios:
- Happy path
- Error / failure path
- Edge case from Phase 1

Append all research findings to the design doc under a `## Technical Research` section (not a separate file).

---

```
<HARD-GATE: Phase 2 exit>
Do NOT begin Phase 3 (setup) until:
1. OWASP analysis is documented in design doc
2. At least 3 TDD test scenarios are identified
3. Approach selection is confirmed (which library/pattern to use)
</HARD-GATE>
```

---

## Phase 3: Setup + Task List

**Goal**: Create branch, worktree, Beads issue, and a complete task list ready for /dev.

### Step 1: Beads issue

```bash
bd create --title="<feature-name>" --type=feature
bd update <id> --status=in_progress
```

### Step 2: Branch + worktree

**ALWAYS branch from master, never from the current branch.** If the working directory is on any branch other than master, the new feature branch would inherit all unmerged changes from that branch — contaminating the new feature's history.

**Note**: If the Entry HARD-GATE already created the branch and worktree (and you are already inside `.worktrees/<slug>`), skip Steps 2b–2d — they are already done.

```bash
# Step 2a: Check if branch and worktree were already created by Entry HARD-GATE
CURRENT=$(git branch --show-current)
if [ "$CURRENT" = "feat/<slug>" ]; then
  echo "✓ Branch feat/<slug> already exists (Entry HARD-GATE created it) — skipping 2b–2d"
else
  # Step 2b: Verify .worktrees/ is gitignored — add if missing
  git check-ignore -v .worktrees/ || echo ".worktrees/" >> .gitignore

  # Step 2c: Create branch + worktree in one command (from master)
  # Using -b with worktree add avoids "branch already checked out" error
  git checkout master
  git worktree add -b feat/<slug> .worktrees/<slug>
  cd .worktrees/<slug>
fi
```

**Why this matters**: Multiple parallel features or sessions each get their own isolated worktree. Changes to one feature never bleed into another. The main working directory can stay on any branch without affecting new feature branches.

### Step 3: Project setup in worktree

Auto-detect and run install:
```bash
# e.g., bun install / npm install / pip install -r requirements.txt
```

### Step 4: Baseline test run

```bash
# Run full test suite in worktree
bun test   # or project test command
```

If tests fail: report which tests are failing and ask user whether to investigate or proceed anyway. Do not silently proceed past failing baseline tests.

### Step 5: Task list creation

Read the design doc. Break implementation into granular tasks.

**Task format** (each task MUST have ALL of these):
```
Task N: <descriptive title>
File(s): <exact file paths>
What to implement: <complete description — not "add feature X", but what specifically>
TDD steps:
  1. Write test: <test file path, what assertion, what input/output>
  2. Run test: confirm it fails with [specific expected error message]
  3. Implement: <exact function/class/component to write>
  4. Run test: confirm it passes
  5. Commit: `<type>: <message>`
Expected output: <what running the test/code produces when done>
```

**Ordering rules**:
- Foundational/shared modules FIRST (types, utils, constants)
- Feature logic SECOND
- Integration/wiring THIRD
- Uncertain/ambiguous tasks LAST (so they can be deferred if blocked)

**YAGNI filter** (after initial task draft, before saving):

For each task, confirm it maps to a specific requirement, success criterion, or edge case in the design doc. Run `applyYAGNIFilter({ task, designDoc })` for each task.

- Tasks that match → keep as-is.
- Tasks with no anchor → flagged as "potential scope creep". Present flagged tasks to the user: "These tasks have no anchor in the design doc. Keep (specify which requirement it serves) or remove?"
- If ALL tasks are flagged → return `allFlagged: true` and tell the user: "Design doc doesn't cover all tasks — needs amendment." Do not save the task list until the design doc is updated or tasks are removed.

**Before finalizing**: flag any tasks that touch areas not fully specified in the design doc. Present flagged tasks to user for quick clarification before saving.

Save to `docs/plans/YYYY-MM-DD-<slug>-tasks.md`.

### Step 6: User review

Present the full task list. Allow the user to reorder, split, or remove tasks.

---

```
<HARD-GATE: /plan exit>
Do NOT proceed to /dev until ALL are confirmed:
1. git branch --show-current output shows feat/<slug>
2. git worktree list shows .worktrees/<slug>
3. Baseline tests ran — either passing OR user confirmed to proceed past failures
4. Beads issue is created with status=in_progress
5. Task list exists at docs/plans/YYYY-MM-DD-<slug>-tasks.md
6. User has confirmed task list is correct
</HARD-GATE>
```

---

## Example Output (Phase 3 complete)

```
✓ Phase 1: Design intent captured
  - Design doc: docs/plans/2026-02-26-stripe-billing-design.md
  - Approach: Stripe SDK v4 (selected over v3)
  - Ambiguity policy: Make conservative choice + document in decisions log

✓ Phase 2: Technical research complete
  - OWASP Top 10: 3 risks identified, 3 mitigations planned
  - TDD scenarios: 5 identified
  - Sources: 8 references

✓ Phase 3: Setup complete
  - Beads: forge-xyz (in_progress)
  - Branch: feat/stripe-billing
  - Worktree: .worktrees/stripe-billing (baseline: 24/24 tests passing)
  - Task list: docs/plans/2026-02-26-stripe-billing-tasks.md (8 tasks)

⏸️  Task list ready for review. Confirm to proceed.

After confirming, run: /dev
```

## Integration with Workflow

```
Utility: /status     → Understand current context before starting
Stage 1: /plan       → Design intent → research → branch + worktree + task list (you are here)
Stage 2: /dev        → Implement each task with subagent-driven TDD
Stage 3: /validate      → Type check, lint, tests, security — all fresh output
Stage 4: /ship       → Push + create PR
Stage 5: /review     → Address GitHub Actions, Greptile, SonarCloud
Stage 6: /premerge   → Update docs, hand off PR to user
Stage 7: /verify     → Post-merge CI check on main
```

## Tips

- **Phase 1 quality = /dev autonomy**: Every ambiguity resolved in Phase 1 is a decision gate that won't fire during /dev
- **One question at a time**: Don't dump all questions at once — dialogue produces better design decisions than a questionnaire
- **Task granularity**: Target 2-5 minutes per task. If a task takes longer, split it
- **Uncertain tasks go last**: Anything ambiguous at the end of the task list can be deferred if blocked without stopping other work
- **Baseline failures matter**: Pre-existing test failures hide regressions. Fix or explicitly document them before /dev starts
