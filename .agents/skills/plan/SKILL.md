---
name: plan
description: >
  Forge PLAN stage — first stop when starting a NEW or unscoped feature. Sets up an
  isolated worktree up front, then runs one-question-at-a-time brainstorming for design
  intent, commits a design doc, does technical/OWASP/DRY + codebase research, and produces a
  TDD task list for /dev. Trigger on "let's plan X", "scope a new feature", "brainstorm before we
  build", "write a design doc", "break this into tasks", or "set up a worktree and task list
  before coding". Reach for this even when the ask sounds like only design or only scoping —
  plan owns intent → research → task-list setup as one stage. NOT for driving a feature to a
  merged PR (that is smith), NOT for implementing tasks that already exist (dev), NOT for a
  standalone deep-research pass into an approved design doc (research), NOT for reporting
  where work stands or what is stale (status), and NOT for everyday issue create/list/close or
  picking the next ready issue (issue-basics / triage-ready).
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
next: dev
terminal: false
subskills:
  - research
---

Plan a feature from scratch: brainstorm design intent, research technical approach, then set up branch, worktree, and a complete task list ready for /dev.

# Plan

> **Chain (HARD-GATE):** the next skill after `plan` is `dev`. `plan` composes the `research` sub-skill for its Phase 2 technical bundle. Do not skip ahead past `dev`.

`/plan` is the default planning super-skill. A full invocation runs the three legacy sections below (intent, research, setup/task list), but v3 treats the internal planning work as callable sub-skills:

- `plan.intent_capture`
- `plan.parallel_research`
- `plan.parallel_critics`
- `plan.synthesis`
- `plan.final_lock`

Do not assume every invocation must run every sub-skill. Run only the requested/required sub-skill when the user asks for partial planning work, and record skipped nodes as skipped rather than silently deleting them from the graph. External planner artifacts may satisfy `/dev` entry without running `/plan`, per D34, if they provide the required structured task list and acceptance criteria.

Planning template behavior is resolved through the runtime graph and `.forge/config.yaml`, not through a separate planner-only config file. Use `forge options why <plan-subskill>`, `forge options diff`, and `forge options lint` to inspect configured planning mode, convergence threshold, critic set, and partial invocation choices.

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
   a. forge worktree create <slug> --branch feat/<slug>
   b. cd .worktrees/<slug>
4. Confirm: "Working in isolated worktree: .worktrees/<slug> (branch: feat/<slug>)"
5. Create the epic issue and record the stage transition:
   ```bash
   forge create --title="<feature-name>" --type=epic
   forge update <id> --status=in_progress
   # Record the none→plan stage transition kernel-natively on the Forge issue.
   forge comment <id> "Stage: none → plan"
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
/plan <feature-slug> --only=critics # Partial invocation: run one planning sub-skill and record evidence
/plan <feature-slug> --only=lock    # Partial invocation: lock an already-supported plan
```

---


### Multi-developer conflict check (soft block)

Before proceeding to Phase 1, check for cross-developer conflicts:

```bash
# Auto-sync to get latest team state
forge sync || true

# Check for conflicts with this issue's planned work area
bash scripts/conflict-detect.sh --issue <forge-id>
```

If exit code 2 (validation error): show error message, abort — do not show conflict prompt.

If exit code 1 (conflicts found):
- Display the conflict output to the developer
- Ask: "Other developers are working in overlapping areas. Proceed anyway? (y/n)"
- If `n`: exit cleanly, no side effects
- If `y`: log override via `forge comment <id> "Conflict override: proceeding despite overlap with <conflicting-issues>"`, then continue to Phase 1
- Audit: record conflict override per OWASP A09

If exit code 0: proceed silently to Phase 1.

---

### Parallel PR coordination check (soft block)

Before proceeding to Phase 1, check for merge conflicts and dependency issues with in-flight PRs:

```bash
# Run merge simulation if on a feature branch
current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "master" ]] && [[ "$current_branch" != "main" ]]; then
  bash scripts/pr-coordinator.sh merge-sim "$current_branch" 2>&1 || true
fi

# Show current merge queue
bash scripts/pr-coordinator.sh merge-order 2>&1 || true

# Check for stale worktrees (informational)
bash scripts/pr-coordinator.sh stale-worktrees 2>&1 || true
```

If merge conflicts or unmet dependencies are found:
- Display the findings to the developer
- Ask: "In-flight PRs have potential conflicts. Proceed with planning anyway? (y/n)"
- If `n`: exit cleanly, no side effects
- If `y`: log override via `forge comment <id> "PR coordination override: proceeding despite in-flight conflicts"`, then continue to Phase 1

---

### Team identity verification

Before starting planning, verify team identity is mapped:

```bash
forge team verify 2>&1 || true
```

If verify reports issues, address them before proceeding (the output will include `FORGE_AGENT_7f3a:PROMPT:` directives with exact commands to run).

---

## Phase 1: Design Intent (Brainstorming)

**Goal**: Capture WHAT to build — purpose, constraints, success criteria, edge cases, approach.

### Step 0: Dependency ripple check (advisory)

Before exploring context or asking questions, check for potential conflicts with in-flight work:

```bash
# If a Forge issue ID is known (e.g., from /status or forge ready):
# Advisory only — runs when the dep-guard tooling is present; a failure is non-fatal.
if [ -f scripts/dep-guard.sh ]; then
  bash scripts/dep-guard.sh check-ripple <forge-issue-id> || echo "dep-guard ripple check skipped (advisory)"
fi

# If no issue exists yet (first-time plan):
forge list --status=open,in_progress
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
   - Add dependency (`forge issue dep add <source> <target>`)
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

Save to `docs/work/YYYY-MM-DD-<slug>/plan.md` with these sections:
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
git add docs/work/YYYY-MM-DD-<slug>/plan.md
git commit -m "docs: add design doc for <slug>"
```

---

**--strategic flag** (for major architecture changes):

After committing the design doc, push to a proposal branch and open PR:
```bash
git checkout -b feat/<slug>-proposal
git push -u origin feat/<slug>-proposal
gh pr create --title "Design: <feature-name>" \
  --body "Design doc for review. See docs/work/YYYY-MM-DD-<slug>/plan.md"
```

**STOP here.** Present the PR URL. Wait for the user to merge the proposal PR.
After merge, run `/plan <slug> --continue` to proceed to Phase 2 + 3.

---

```
<HARD-GATE: Phase 1 exit>
Do NOT begin Phase 2 (web research) until:
1. User has approved the design in this session OR external-planner evidence satisfies the `/dev` entry contract from D34
2. Design doc exists at docs/work/YYYY-MM-DD-<slug>/plan.md
3. Design doc includes: success criteria, edge cases, out-of-scope, ambiguity policy
4. Design doc is committed to git
</HARD-GATE>
```

---

## Phase 2: Technical Research

**Goal**: Find HOW to build it — best practices, known issues, security risks, TDD scenarios.

Record the phase transition before starting research (kernel-native):
```bash
forge comment <id> "Stage: plan → research"
```

Delegate the technical investigation to the **research** skill, which owns this bundle so it
can be invoked on its own and reused mid-flow by other stages:

```
Skill("research")   # run in "Plan bundle" mode for this feature's design doc
```

Hand research the approved approach and the design doc path. It runs the following in parallel
and appends the results under a `## Technical Research` section in the design doc (not a
separate file):

- **Web research** — best practices, implementation patterns, and known gotchas for the chosen
  approach. (For an external market/vendor landscape, research escalates to
  `parallel-deep-research`; code-level questions use WebSearch/Context7.)
- **OWASP Top 10 analysis** — for each relevant category: the risk, whether it applies, and the
  mitigation to implement.
- **DRY check** — Grep/Glob/Read for existing implementations; if found, switch "Approach
  selected" to "extend existing <file>:<line>" instead of "create new".
- **Blast-radius search** (mandatory for remove/rename/replace) — grep the ENTIRE repo (exact +
  case-insensitive + filename glob) and record every hit (including `package.json`, setup
  scripts, `.github/workflows/`, agent config, and docs), adding a cleanup task for each.
- **Codebase exploration** (Explore agent) — similar patterns to reuse, affected files, and
  test infrastructure to leverage.
- **TDD test scenarios** — at least 3: happy path, error/failure path, and one Phase-1 edge case.

If the research skill is not available in the active toolset, run the same bundle inline with
WebSearch/WebFetch, Grep/Glob/Read, and the Explore agent — the Phase 2 exit gate below verifies
the outputs regardless of who produced them.

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

Record the phase transition before starting setup (kernel-native):
```bash
forge comment <id> "Stage: research → setup"
```

### Step 1: Link child issues to the epic

The epic was created in the Entry HARD-GATE (Phase 1 entry). If this feature requires child issues (sub-tasks tracked separately), create them now and link to the epic:

```bash
forge create --title="<sub-task-name>" --type=feature --parent=<epic-id>
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

  # Step 2c: Create an isolated worktree rooted on master
  git checkout master
  forge worktree create <slug> --branch feat/<slug>
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
- **File ownership**: Each task MUST include an `OWNS:` line listing files it will modify
- No two tasks in the same wave can own the same file
- Cross-wave ownership is allowed (sequential execution prevents conflicts)

**YAGNI filter** (after initial task draft, before saving):

For each task, confirm it maps to a specific requirement, success criterion, or edge case in the design doc. Run `applyYAGNIFilter({ task, designDoc })` for each task.

- Tasks that match → keep as-is.
- Tasks with no anchor → flagged as "potential scope creep". Present flagged tasks to the user: "These tasks have no anchor in the design doc. Keep (specify which requirement it serves) or remove?"
- If ALL tasks are flagged → return `allFlagged: true` and tell the user: "Design doc doesn't cover all tasks — needs amendment." Do not save the task list until the design doc is updated or tasks are removed.

**Before finalizing**: flag any tasks that touch areas not fully specified in the design doc. Present flagged tasks to user for quick clarification before saving.

Save to `docs/work/YYYY-MM-DD-<slug>/tasks.md`.

### Step 5b: Issue context (design + acceptance)

After saving the task list, attach design context and acceptance criteria to the Forge issue so downstream stages (`/dev`, `/validate`, `/review`) can retrieve it without re-reading the design doc. These are native Kernel issue fields — no separate tracker required.

```bash
# Link design metadata (task count + task file path) to the Forge issue
forge update <id> --design "<task-count> tasks | docs/work/YYYY-MM-DD-<slug>/tasks.md"

# Record the success criteria from the design doc on the issue
forge update <id> --acceptance "<success-criteria from design doc>"
```

Both commands must exit with code 0. If either fails, investigate (wrong issue ID? bad flag value?) before continuing.

### Step 5c: Contract extraction and logic-level dependency review (advisory, optional)

After saving the task list and issue context, extract and store contract metadata, then run the logic-level Phase 3 dependency review. **This step uses the `dep-guard` dependency tooling; on a kernel-only setup it is skipped — it is advisory and never a hard block.**

```bash
if [ -f scripts/dep-guard.sh ]; then
  # extract-contracts exits 1 when there simply are no contracts (normal, not an error),
  # so store-contracts only runs when contracts were actually extracted.
  if bash scripts/dep-guard.sh extract-contracts docs/work/YYYY-MM-DD-<slug>/tasks.md > /tmp/contracts.txt; then
    # Contracts found — store them. A real store-contracts failure stays visible (not masked).
    bash scripts/dep-guard.sh store-contracts <id> "$(cat /tmp/contracts.txt)"
  fi
  # check-ripple is advisory (needs the dependency-guard tooling); a failure is non-fatal.
  bash scripts/dep-guard.sh check-ripple <id> || echo "dep-guard ripple check skipped (advisory)"
fi
```

`extract-contracts` exits 1 when no contracts are found (not an error — just nothing to store). `store-contracts` must exit 0 if called.

When available, `check-ripple` is advisory but logic-aware. It should:
- read the issue data via JSON
- analyze import/call-chain, contract, and behavioral dependency signals
- show rubric score, confidence, issue pairs, and proposed dependency updates with pros/cons
- stop for user approval whenever a dependency mutation is proposed

If the user approves a dependency mutation, apply it explicitly (only when the tooling is present):

```bash
bash scripts/dep-guard.sh apply-decision <id> <dependent-id> <depends-on-id> "<approval rationale>"
```

That approval step must inspect blockers with `forge issue blocked` (and `forge issue children <epic-id>` for the epic rollup), summarize `forge ready`, and persist the decision via `forge update` plus `forge comment`. The Forge Kernel is the canonical machine-readable decision record; the plan docs hold only the concise summary.

### Step 6: User review

Present the full task list. Allow the user to reorder, split, or remove tasks.

---

```
<HARD-GATE: /plan exit>
For a full `/plan` handoff only, do NOT hand off from `/plan` to `/dev` until ALL are confirmed:
1. git branch --show-current output shows feat/<slug>
2. git worktree list shows .worktrees/<slug>
3. Baseline tests ran — either passing OR user confirmed to proceed past failures
4. Forge issue is created and in_progress (`forge issue show <id>` confirms status=in_progress)
5. Task list exists at docs/work/YYYY-MM-DD-<slug>/tasks.md
6. User has confirmed task list is correct
7. Design captured on the Forge issue — `forge update <id> --design ...` ran successfully (exit code 0)
8. Acceptance criteria captured on the Forge issue — `forge update <id> --acceptance ...` ran successfully (exit code 0)
9. Contract metadata stored via `dep-guard store-contracts` (exit code 0) — or skipped if no contracts found OR the beads-backed dep-guard tooling is unavailable
10. `dep-guard check-ripple` reviewed with the user before any `apply-decision` dependency mutation — or skipped when the dep-guard tooling is unavailable

If `/dev` is entered from an external planner, this `/plan` exit gate is not required. Instead, the external artifact must satisfy the L1 `/dev` entry contract: structured task list, acceptance criteria, and enough design intent for TDD implementation.

If only a sub-skill was invoked, do not claim full `/plan` completion. Record that sub-skill's evidence, gate outcome, and skipped graph nodes.
</HARD-GATE>
```

After all HARD-GATE items pass, confirm issue context and record the stage transition kernel-natively on the Forge issue:

```bash
# Confirm the issue carries design + acceptance context.
forge issue show <id>

# Record the plan→dev transition kernel-natively (Stage:/Summary:/Decisions:/Artifacts:/Next: envelope).
forge comment <id> "Stage: plan complete → ready for dev
Summary: <design approach chosen, task count>
Decisions: <key trade-offs resolved during Q&A>
Artifacts: docs/work/YYYY-MM-DD-<slug>/plan.md docs/work/YYYY-MM-DD-<slug>/tasks.md
Next: <first dev task focus area>"
```

---

## Dynamic Phase 3 Output

Phase 3 output is generated from the live Forge issue, branch/worktree setup, baseline validation, and task list paths at runtime. It reports the Forge issue, branch, worktree, `docs/work/YYYY-MM-DD-<slug>/plan.md`, and `docs/work/YYYY-MM-DD-<slug>/tasks.md` from the actual run instead of a static example.

## Integration with Workflow

```
Utility: /status     -> Understand current context before starting

Default template:
  /plan     -> Optional default planner; external planners may satisfy /dev entry
  /dev      -> Implement each task with subagent-driven TDD and continuous validation
  /ship     -> Push + create PR
  /review   -> Address GitHub Actions, Greptile, SonarCloud
  /verify   -> Post-merge CI check on default branch

Manual/support surfaces:
  /validate  -> Cold-start or recovery validation, not a required stage boundary

Pre-merge gate: doc updates + CI-green checkpoint embedded in /ship and /review (not a separate stage).
```

## Tips

- **Phase 1 quality = /dev autonomy**: Every ambiguity resolved in Phase 1 is a decision gate that won't fire during /dev
- **One question at a time**: Don't dump all questions at once — dialogue produces better design decisions than a questionnaire
- **Task granularity**: Target 2-5 minutes per task. If a task takes longer, split it
- **Uncertain tasks go last**: Anything ambiguous at the end of the task list can be deferred if blocked without stopping other work
- **Baseline failures matter**: Pre-existing test failures hide regressions. Fix or explicitly document them before /dev starts
