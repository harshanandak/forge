
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
   a. bd worktree create .worktrees/<slug> --branch feat/<slug>
   b. cd .worktrees/<slug>
4. Confirm: "Working in isolated worktree: .worktrees/<slug> (branch: feat/<slug>)"
5. Create the epic issue and record the stage transition:
   ```bash
   bd create --title="<feature-name>" --type=epic
   bd update <id> --status=in_progress
   bash scripts/beads-context.sh stage-transition <id> none plan
   ```
6. ONLY THEN begin Phase 1.

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


### Multi-developer conflict check (soft block)

Before proceeding to Phase 1, check for cross-developer conflicts:

```bash
# Auto-sync to get latest team state
bash scripts/sync-utils.sh auto-sync

# Check for conflicts with this issue's planned work area
bash scripts/conflict-detect.sh --issue <beads-id>
```

If exit code 2 (validation error): show error message, abort — do not show conflict prompt.

If exit code 1 (conflicts found):
- Display the conflict output to the developer
- Ask: "Other developers are working in overlapping areas. Proceed anyway? (y/n)"
- If `n`: exit cleanly, no side effects
- If `y`: log override via `bd comments add <id> "Conflict override: proceeding despite overlap with <conflicting-issues>"`, then continue to Phase 1
- Audit: record conflict override per OWASP A09

If exit code 0: proceed silently to Phase 1.

---

## Phase 1: Design Intent (Brainstorming)

**Goal**: Capture WHAT to build — purpose, constraints, success criteria, edge cases, approach.

### Step 0: Dependency ripple check (advisory)

Before exploring context or asking questions, check for potential conflicts with in-flight work:

```bash
# If a Beads issue ID is known (e.g., from /status or bd ready):
bash scripts/dep-guard.sh check-ripple <beads-issue-id>

# If no issue exists yet (first-time plan):
bd list --status=open,in_progress
```

Review the output. If overlaps are detected:
- Consider whether the overlapping issue should be a dependency
- Note any shared areas for the design Q&A
- This check is **advisory only** — always proceed to Step 1 regardless of findings

#### Ripple Analyst Agent (spawned when contract overlaps found)

When `check-ripple` detects overlapping issues AND contract metadata is available, spawn a Ripple Analyst subagent with this prompt:

**Input to agent**:
- Current issue's contract changes (from `extract-contracts` output)
- Consumer code snippets (from `find-consumers` output for each changed contract)
- Overlapping issue's title, description, and contract metadata

**Agent instructions**:
1. For each overlapping contract, imagine 2-3 concrete break scenarios:
   - "If [contract X] changes [specific behavior], then [consumer Y] will [specific failure]"
2. Rate overall impact as one of:
   - **NONE**: No real conflict despite keyword overlap
   - **LOW**: Consumers need trivial adjustment (add parameter, rename call)
   - **HIGH**: Consumer needs significant rework (parsing logic, data handling changes)
   - **CRITICAL**: Consumer is in an active in_progress issue's task list
3. **When uncertain, default to HIGH** — conservative over permissive
4. Recommend one action:
   - Add dependency (`bd dep add <source> <target>`)
   - Coordinate with other issue's developer
   - Scope down current feature to avoid overlap
   - Proceed as-is (no real conflict)

**Output format**:
```
Impact: [NONE|LOW|HIGH|CRITICAL]
Confidence: [high|medium|low]

Break scenarios:
1. [scenario description]
2. [scenario description]

Recommendation: [action]
Reason: [why this action]
```

This agent is advisory only. The developer always makes the final decision.

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
- **Ambiguity policy**: Use 7-dimension rubric scoring per /dev decision gate. >= 80% confidence: proceed and document. < 80%: stop and ask.

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

Record the phase transition before starting research:
```bash
bash scripts/beads-context.sh stage-transition <id> plan research
```

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

### Blast-radius search (mandatory for remove/rename/replace features)

If this feature involves **removing**, **renaming**, or **replacing** a concept, tool, or dependency:

1. Grep the ENTIRE codebase for the thing being removed/renamed:
   ```
   Grep("<thing-being-removed>")     # exact name
   Grep("<thing-being-removed>", -i)  # case-insensitive variant
   Glob("**/*<thing>*")              # files named after it
   ```

2. For EVERY match found:
   - Note the file path and line number in the design doc
   - Add a cleanup task to the task list (Phase 3)
   - Flag matches in unexpected packages or config files explicitly

3. Common hiding spots to check:
   - `package.json` (scripts, dependencies, description)
   - `install.sh` / setup scripts
   - CI/CD workflows (`.github/workflows/`)
   - Agent config files (`lib/agents/`, `.cursorrules`, etc.)
   - Documentation (`docs/`, `README.md`, `AGENTS.md`)
   - Import statements and require() calls

If no removal/rename is involved, this section is skipped.

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
4. If feature involves removal/rename: blast-radius search completed, all references added to task list
</HARD-GATE>
```

---

## Phase 3: Setup + Task List

**Goal**: Create branch, worktree, and a complete task list ready for /dev.

Record the phase transition before starting setup:
```bash
bash scripts/beads-context.sh stage-transition <id> research setup
```

### Step 1: Link child issues to the epic

The epic was created in the Entry HARD-GATE (Phase 1 entry). If this feature requires child issues (sub-tasks tracked separately), create them now and link to the epic:

```bash
bd create --title="<sub-task-name>" --type=feature --parent=<epic-id>
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

  # Step 2c: Create a Beads-aware worktree rooted on master
  git checkout master
  bd worktree create .worktrees/<slug> --branch feat/<slug>
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

### Step 5b: Beads context

After saving the task list, attach design context and acceptance criteria to the Beads issue so downstream stages (`/dev`, `/validate`, `/review`) can retrieve it without re-reading the design doc.

```bash
# Link design metadata (task count + task file path) to the Beads issue
bash scripts/beads-context.sh set-design <id> <task-count> docs/plans/YYYY-MM-DD-<slug>-tasks.md

# Record the success criteria from the design doc on the issue
bash scripts/beads-context.sh set-acceptance <id> "<success-criteria from design doc>"
```

Both commands must exit with code 0. If either fails, investigate (wrong issue ID? missing script?) before continuing.

### Step 5c: Contract extraction and logic-level dependency review

After saving the task list and Beads context, extract and store contract metadata, then run the logic-level Phase 3 dependency review:

```bash
# Extract contracts — only call store-contracts if extract succeeds (exit 0)
if bash scripts/dep-guard.sh extract-contracts docs/plans/YYYY-MM-DD-<slug>-tasks.md > /tmp/contracts.txt; then
  bash scripts/dep-guard.sh store-contracts <id> "$(cat /tmp/contracts.txt)"
else
  echo "No contracts found — skipping store-contracts"
fi

# Re-run ripple check using Beads JSON + logic-level analysis
bash scripts/dep-guard.sh check-ripple <id>
```

`extract-contracts` exits 1 when no contracts are found (not an error — just nothing to store). `store-contracts` must exit 0 if called.

`check-ripple` is now advisory but logic-aware. It should:
- read Beads issue data via JSON
- analyze import/call-chain, contract, and behavioral dependency signals
- show rubric score, confidence, issue pairs, and proposed dependency updates with pros/cons
- stop for user approval whenever a dependency mutation is proposed

If the user approves a dependency mutation, apply it explicitly:

```bash
bash scripts/dep-guard.sh apply-decision <id> <dependent-id> <depends-on-id> "<approval rationale>"
```

That approval step must validate with `bd dep cycles`, show `bd graph`, summarize `bd ready`, and persist the decision via `bd set-state` plus `bd comments`. Beads remains the canonical machine-readable decision record; the plan docs hold only the concise summary.

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
7. `beads-context.sh set-design` ran successfully (exit code 0)
8. `beads-context.sh set-acceptance` ran successfully (exit code 0)
9. `dep-guard.sh store-contracts` ran successfully (exit code 0) — or skipped if no contracts found
10. `dep-guard.sh check-ripple` ran successfully and any proposed dependency mutation was reviewed with the user before calling `apply-decision`
</HARD-GATE>
```

After all HARD-GATE items pass, record the stage transition on the Beads issue:

```bash
bash scripts/beads-context.sh stage-transition <id> plan dev
```

---

## Example Output (Phase 3 complete)

```
✓ Phase 1: Design intent captured
  - Design doc: docs/plans/2026-02-26-stripe-billing-design.md
  - Approach: Stripe SDK v4 (selected over v3)
  - Ambiguity policy: Rubric scoring (>= 80% proceed, < 80% ask)

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
