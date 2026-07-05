# Plan Phase 3 — Setup + Task List (reference)

## Phase 3: Setup + Task List

**Goal**: Create branch, worktree, and a complete task list ready for /dev.

Record the phase transition before starting setup (optional context logging; kernel-only setups skip it — a real helper failure stays visible):
```bash
if [ -f scripts/beads-context.sh ]; then bash scripts/beads-context.sh stage-transition <id> research setup; fi
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

After saving the task list, attach design context and acceptance criteria to the Forge issue so downstream stages (`/dev`, `/validate`, `/review`) can retrieve it without re-reading the design doc. These are native Kernel issue fields — no Beads required.

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

After all HARD-GATE items pass, confirm issue context and record the stage transition. The structured transition helper is optional; on a kernel-only setup, log the handoff directly on the Forge issue:

```bash
# Confirm the issue carries design + acceptance context (helper when present; otherwise inspect the issue).
# Only falls back to `forge issue show` when the helper is absent — a real validate failure stays visible.
if [ -f scripts/beads-context.sh ]; then
  bash scripts/beads-context.sh validate <id>
else
  forge issue show <id>
fi

# Record the plan→dev transition (structured helper when present; kernel-native comment otherwise).
# The fallback comment mirrors the same envelope the helper emits (Stage:/Summary:/Decisions:/Artifacts:/Next:).
if [ -f scripts/beads-context.sh ]; then
  bash scripts/beads-context.sh stage-transition <id> plan dev \
    --summary "<design approach chosen, task count>" \
    --decisions "<key trade-offs resolved during Q&A>" \
    --artifacts "docs/work/YYYY-MM-DD-<slug>/design.md docs/work/YYYY-MM-DD-<slug>/tasks.md" \
    --next "<first dev task focus area>"
else
  forge comment <id> "Stage: plan complete → ready for dev
Summary: <design approach chosen, task count>
Decisions: <key trade-offs resolved during Q&A>
Artifacts: docs/work/YYYY-MM-DD-<slug>/design.md docs/work/YYYY-MM-DD-<slug>/tasks.md
Next: <first dev task focus area>"
fi
```

---
