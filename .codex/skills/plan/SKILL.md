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
---

Plan a feature from scratch: brainstorm design intent, research technical approach, then set up branch, worktree, and a complete task list ready for /dev.

# Plan

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
   # Optional context logging: run the transition helper only when present (kernel-only setups skip it).
   # Only skips when the helper is absent — a real logging failure from the helper stays visible.
   if [ -f scripts/beads-context.sh ]; then bash scripts/beads-context.sh stage-transition <id> none plan; fi
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

## The three phases

Plan runs three phases in order. Each phase's full step-by-step procedure lives in a
reference file — read the phase you are entering:

1. **Phase 1 — Design Intent (brainstorming):** one-question-at-a-time intent capture,
   then a design doc. See [references/phase1-design.md](references/phase1-design.md).
2. **Phase 2 — Technical Research:** web research, OWASP Top 10, DRY + blast-radius
   search, TDD scenarios. See [references/phase2-research.md](references/phase2-research.md).
3. **Phase 3 — Setup + Task List:** branch/worktree confirm, baseline tests, the TDD
   task list for /dev. See [references/phase3-setup.md](references/phase3-setup.md).

## Dynamic Phase 3 Output

Phase 3 output is generated from the live Forge issue, branch/worktree setup, baseline validation, and task list paths at runtime. It reports the Forge issue, branch, worktree, `docs/work/YYYY-MM-DD-<slug>/design.md`, and `docs/work/YYYY-MM-DD-<slug>/tasks.md` from the actual run instead of a static example.

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
