# Research: Forge Workflow V2 — Complete Refactor

**Feature slug**: `forge-workflow-v2`
**Date**: 2026-02-26
**Status**: Design complete, ready for /plan

---

## Objective

Refactor the Forge 9-stage workflow into a leaner 7-stage workflow that:
1. Absorbs Superpowers mechanics (brainstorming, subagent-driven-development, git worktrees, verification) natively — no Superpowers plugin install needed
2. Front-loads all design decisions so `/dev` runs autonomously with bypass permissions
3. Enforces hard gates at every stage exit (structural, not soft instructions)
4. Removes OpenSpec as a dependency — replaced by design doc + `--strategic` flag
5. Removes `/research` as a standalone stage — absorbed into `/plan` Phase 2
6. Introduces a decisions log and impact scoring framework for undocumented decisions during `/dev`

---

## Codebase Analysis

### Current Command Files (Baseline)

| Command | File | Key Mechanics | What Changes |
|---------|------|--------------|-------------|
| `/status` | `.claude/commands/status.md` | Reads PROGRESS.md, bd list, git log | No longer a numbered stage — utility only |
| `/research` | `.claude/commands/research.md` | Explore agent + parallel web search + OWASP → docs/research/ | Absorbed into /plan Phase 2. Command removed or kept as shortcut |
| `/plan` | `.claude/commands/plan.md` | Read research, determine scope, bd create, git branch | Expanded to 3 phases + task list. OpenSpec replaced by --strategic flag |
| `/dev` | `.claude/commands/dev.md` | TodoWrite + Task agents + RED-GREEN-REFACTOR | TodoWrite loop replaced by subagent-driven-development |
| `/check` | `.claude/commands/check.md` | type/lint/code-review/security/tests | Add HARD-GATE exit requiring fresh command output |
| `/ship` | `.claude/commands/ship.md` | Verify /check, bd update, git push, gh pr create | Add HARD-GATE entry + update PR body to reference design doc not research doc |
| `/review` | `.claude/commands/review.md` | GitHub Actions + Greptile + SonarCloud | Add HARD-GATE exit blocking when threads unresolved |
| `/premerge` | `.claude/commands/premerge.md` | Docs update + bd sync + OpenSpec archive + hand off | Remove OpenSpec archive step. Add HARD-GATE no-merge enforcer |
| `/verify` | `.claude/commands/verify.md` | git checkout master + CI check + bd close | Lightweight. Simplify — no new changes needed |

### Current AGENTS.md Workflow Table

Current: 9 stages, 6 change classifications (Critical/Standard/Simple/Hotfix/Docs/Refactor).
New: 7 stages, same 6 classifications — but classification skips updated to reflect new stage numbers.

### Current Skills Directory

`skills/parallel-web-search/` — stays, used in /plan Phase 2
`skills/parallel-deep-research/` — stays, used optionally in /plan Phase 2

No Superpowers plugin will be installed. Superpowers mechanics are ported natively into command files.

---

## Design Decisions Made (Session Record)

### Decision 1: Absorb /research into /plan Phase 2
**Reasoning**: What `/research` produces (approach selection, TDD scenarios, OWASP analysis) IS planning output, not raw research. Separating them creates an artificial two-step that adds stage count without adding value.
**What changes**: `/plan` gains Phase 2 (parallel web search + OWASP). `/research` command is either removed or kept as an alias that jumps straight to Phase 2 context.
**Evidence**: Current `/research` output goes into a doc that `/plan` immediately reads — they were already sequential with no human gate between them.

### Decision 2: Add brainstorming as /plan Phase 1
**Reasoning**: Superpowers brainstorming SKILL.md (fetched) shows it captures WHAT to build: purpose, constraints, success criteria, edge cases, approach selection. Forge had no WHAT phase — it jumped straight to HOW (web research). The WHAT phase front-loads all decisions that would otherwise surface as undocumented mid-dev surprises.
**What changes**: /plan starts with one-question-at-a-time Q&A. Design doc saved to `docs/plans/YYYY-MM-DD-<slug>-design.md` before any research begins.
**HARD-GATE**: No Phase 2 until design doc exists AND user has approved it.

### Decision 3: Add task list creation as /plan Phase 3 final step
**Reasoning**: Superpowers `writing-plans` SKILL.md (fetched) shows it creates 2-5 min tasks with exact file paths, code, test steps, and expected output. This belongs at the END of /plan, not the START of /dev. When /dev starts, it gets a pre-made task list, not a design doc to interpret.
**What changes**: /plan Phase 3 ends with task list written to `docs/plans/YYYY-MM-DD-<slug>-tasks.md`. User reviews and approves task list before /dev.
**HARD-GATE**: /dev cannot start until task list exists AND user confirms it.

### Decision 4: Add git worktrees to /plan Phase 3
**Reasoning**: Superpowers `using-git-worktrees` SKILL.md shows it is REQUIRED by subagent-driven-development. Worktree creation belongs at /plan Phase 3 (after branch creation) because isolation should be set up before implementation starts, and verifying a clean baseline catches pre-existing failures before /dev.
**What changes**: /plan Phase 3 adds: `git worktree add .worktrees/<slug> -b feat/<slug>`, project setup, baseline test run. Baseline test failures surface here, not mid-/dev.

### Decision 5: Replace TodoWrite loop in /dev with subagent-driven-development
**Reasoning**: Superpowers `subagent-driven-development` SKILL.md (fetched) shows: implementer subagent (fresh context, TDD) → spec compliance reviewer → code quality reviewer, per task. This catches spec drift and quality issues per-task rather than at feature end. TDD is enforced inside each implementer subagent.
**What changes**: /dev reads from task list (pre-made in /plan Phase 3), dispatches subagents per task with the task's FULL text (not a file path), runs two-stage review per task.
**What stays**: RED-GREEN-REFACTOR is still the TDD mechanic, just enforced inside implementer subagents.

### Decision 6: Remove OpenSpec — replace with --strategic flag on /plan
**Reasoning**: With a thorough Phase 1 (brainstorming → design doc) and Phase 2 (research), OpenSpec's value (design intent capture, approach selection, technical decisions) is already covered. The only unique value OpenSpec adds for strategic cases is a formal proposal PR. That's 2 git commands, not a separate tool.
**What changes**: Remove `openspec` dependency entirely. Add `--strategic` flag to /plan: creates design doc PR before proceeding to Phase 2 and Phase 3. User merges proposal PR to approve. Then `/plan --continue` runs Phase 2 + 3.
**In /premerge**: Remove the `openspec archive <slug>` step.
**In /ship**: Remove OpenSpec PR link from PR body template.

### Decision 7: Add HARD-GATE at every stage exit
**Reasoning**: Soft instructions fail. Superpowers introduced `<HARD-GATE>` blocks in v4.3.0 after discovering soft "read AGENTS.md" instructions were being ignored (confirmed in Forge by the Option A failure test this session). Hard gates explicitly name forbidden actions and conditions that must be met. They prevent rationalization.
**What changes**: Every command gets explicit `<HARD-GATE>` blocks at internal transitions and at exit. See full gate specification below.

### Decision 8: Introduce decisions log and impact scoring in /dev
**Reasoning**: When an implementer subagent encounters a gap in the spec, it currently has no structured process. Silent drift (making a choice without documentation) is the failure mode. The scoring checklist makes classification objective — not agent judgment.
**What changes**: New artifact: `docs/plans/YYYY-MM-DD-<slug>-decisions.md` created at /dev start. 7-dimension checklist with score thresholds. Score 0-3 → proceed. Score 4-7 → spec reviewer. Score 8+ or override → all remaining independent tasks complete, developer input surfaced at /dev end.
**Design goal**: Plan quality is the primary fix. Decision gate is the safety net.

### Decision 9: /status is utility, not numbered stage
**Reasoning**: User correctly identified that /status is a check command, not a workflow stage. Removing it from the numbered sequence simplifies the workflow description from "9 stages" to "7 stages."
**What changes**: AGENTS.md workflow table renumbers stages 1-7. /status remains available as `/status` utility.

### Decision 10: /verify stays as separate lightweight stage
**Reasoning**: /premerge and /verify cannot be merged because the user's merge action is a hard human gate between them. /verify is already lightweight (CI check on main, close Beads, report). Keeping it separate preserves the clean "done" signal.
**What changes**: None to /verify. Add HARD-GATE at /premerge exit that explicitly says STOP and presents PR URL.

---

## New 7-Stage Workflow

```
Stage | Command    | Purpose
------+------------+--------------------------------------------------
  1   | /plan      | 3-phase: design intent → research → branch+worktree+task list
  2   | /dev       | Subagent-driven: implementer + spec-review + quality-review per task
  3   | /check     | type/lint/security/tests + verification HARD-GATE at exit
  4   | /ship      | Push + PR creation with design doc reference
  5   | /review    | GitHub Actions + Greptile + SonarCloud — all threads resolved
  6   | /premerge  | Doc updates + HARD-GATE STOP for user merge
  7   | /verify    | Post-merge CI on main + close Beads

Utility: /status  (not numbered — context check before starting)
```

Change classifications updated:
- Critical: full 7 stages
- Standard: plan → dev → check → ship → review → premerge
- Simple: dev → check → ship
- Hotfix: dev → check → ship (immediate)
- Docs: verify → ship
- Refactor: plan → dev → check → ship → premerge

---

## /plan — Full Spec (Refactored)

### Phase 1: Design Intent (Brainstorming)
**Source**: Superpowers brainstorming SKILL.md mechanics

Steps:
1. Explore project context — read files, docs, recent commits relevant to the feature
2. Ask clarifying questions ONE at a time (multiple choice preferred)
   - Purpose: what problem does this solve?
   - Constraints: what must it NOT do?
   - Success criteria: how will we know it's done?
   - Edge cases: what happens when X fails / Y is missing / Z is ambiguous?
   - Technical preferences: library A or B? approach X or Y?
   - Ambiguity policy: if spec gap found mid-dev, make reasonable choice + document, or pause for input?
3. Propose 2-3 approaches with trade-offs and recommendation
4. Present design in sections — get approval after each section
5. Write design doc to `docs/plans/YYYY-MM-DD-<slug>-design.md`
6. Commit design doc

```
<HARD-GATE: Phase 1 exit>
Do NOT begin Phase 2 (web research) until:
1. User has approved the design in this session
2. Design doc exists at docs/plans/YYYY-MM-DD-<slug>-design.md
3. Design doc includes: success criteria, edge cases, out-of-scope, ambiguity policy
4. Design doc is committed to git
</HARD-GATE>
```

**--strategic flag behavior**: After writing design doc, push to branch and open PR:
```bash
git push -u origin feat/<slug>-proposal
gh pr create --title "Design: <slug>" --body "See docs/plans/YYYY-MM-DD-<slug>-design.md"
```
Then STOP. No Phase 2 until user merges proposal PR.

### Phase 2: Technical Research
**Source**: Current /research command mechanics

Steps (run in parallel):
- Parallel web search: best practices, known issues, library docs
- OWASP Top 10 analysis for this feature's risk surface
- Codebase exploration: similar patterns, affected files, existing tests
- TDD test scenarios: minimum 3 identified

Research notes appended to design doc under `## Technical Research` section (not a separate file).

```
<HARD-GATE: Phase 2 exit>
Do NOT begin Phase 3 (setup) until:
1. OWASP analysis is documented in design doc
2. At least 3 TDD test scenarios are identified
3. Approach selection is confirmed (which library/pattern to use)
</HARD-GATE>
```

### Phase 3: Setup + Task List
**Source**: Superpowers using-git-worktrees + writing-plans SKILL.md mechanics

Steps:
1. **Scope determination**: tactical (no design PR needed) vs strategic (already done in --strategic)
2. **Beads issue**: `bd create "<feature-name>" --type=feature`; `bd update <id> --status=in_progress`
3. **Branch + worktree**:
   ```bash
   git checkout -b feat/<slug>
   git worktree add .worktrees/<slug> -b feat/<slug>
   cd .worktrees/<slug>
   ```
4. **Verify .worktrees/ is gitignored** — if not, add to .gitignore and commit
5. **Project setup in worktree**: auto-detect and run (npm install / bun install / pip install etc.)
6. **Baseline test run**: run full test suite in worktree. If tests fail: report and ask whether to proceed or investigate
7. **Task list creation** (Superpowers writing-plans mechanics):
   - Read design doc
   - Break implementation into 2-5 min tasks with: exact file paths, complete code, verification steps
   - Order by dependency: foundational/shared tasks FIRST, uncertain/ambiguous tasks LAST
   - Flag any tasks that touch areas not fully specified in design doc
   - Present flagged tasks to user for quick clarification BEFORE finalizing
   - Save to `docs/plans/YYYY-MM-DD-<slug>-tasks.md`
8. **User reviews task list** — can reorder, split, or remove tasks
9. **STOP**: present summary, wait for `/dev`

```
<HARD-GATE: /plan exit>
Do NOT proceed to /dev until:
1. git branch --show-current confirms feat/<slug>
2. Worktree exists at .worktrees/<slug> with tests passing
3. Beads issue is created and status=in_progress
4. Task list exists at docs/plans/YYYY-MM-DD-<slug>-tasks.md
5. User has confirmed task list looks correct
</HARD-GATE>
```

---

## /dev — Full Spec (Refactored)

**Source**: Superpowers subagent-driven-development SKILL.md mechanics + decisions framework

### Setup
1. Read task list from `docs/plans/YYYY-MM-DD-<slug>-tasks.md` — extract ALL tasks with full text
2. Read design doc including ambiguity policy
3. Create `docs/plans/YYYY-MM-DD-<slug>-decisions.md` (empty log, ready for entries)

```
<HARD-GATE: /dev start>
Do NOT write any code until:
1. git branch --show-current confirms NOT main or master
2. Worktree path confirmed (not main repo directory)
3. Task list file confirmed to exist
4. Decisions log file created
</HARD-GATE>
```

### Per-Task Loop

For each task in order:

**Step 1: Dispatch implementer subagent**
- Provide: full task text, design doc excerpt relevant to this task, codebase context
- Do NOT send file path to plan — send the text directly
- Implementer subagent: asks clarifying questions (before starting) → TDD (RED-GREEN-REFACTOR) → self-review → commit

```
<HARD-GATE: TDD enforcement (inside implementer subagent)>
Do NOT write any production code until:
1. A FAILING test exists for that code
2. The test has been run and output shows it failing
3. The failure reason matches the expected missing behavior
If code was written before its test: delete it. Start with the test.
</HARD-GATE>
```

**Step 2: Decision gate (when implementer hits spec gap)**

Fill checklist BEFORE implementing:
```
Gap: [describe what spec doesn't cover]

Score each (0=No / 1=Possibly / 2=Yes):
[ ] Files affected beyond current task?
[ ] Changes a function signature or export?
[ ] Changes a shared module used by other tasks?
[ ] Changes or touches persistent data/schema?
[ ] Changes user-visible behavior?
[ ] Affects auth, permissions, or data exposure?
[ ] Hard to reverse without cascading changes?
TOTAL: ___

Mandatory overrides (any = always escalate):
[ ] Security dimension = 2
[ ] Schema migration or data model change
[ ] Removes/changes existing public API endpoint
[ ] Affects already-implemented task
```

Score routing:
- 0-3: Proceed. Document in decisions log + commit message.
- 4-7: Route to spec reviewer. Continue independent tasks while reviewer works.
- 8+ / override: Document in decisions log. Complete all other independent tasks. Surface to developer at /dev end.

**Step 3: Spec compliance review** (after implementer done)
- Dispatch spec reviewer subagent with: task text, design doc section, git diff
- Reviewer checks: all requirements met? nothing extra added? edge cases handled?
- If issues: implementer fixes → re-review → until ✅

```
<HARD-GATE: spec before quality>
Do NOT dispatch code quality reviewer until spec compliance reviewer returns ✅
Running quality review before spec compliance ✅ is wrong order.
</HARD-GATE>
```

**Step 4: Code quality review** (after spec ✅)
- Dispatch quality reviewer subagent with: git SHAs, code changes
- Reviewer checks: naming, structure, duplication, test coverage, no magic numbers
- If issues: implementer fixes → re-review → until ✅

**Step 5: Task completion**

```
<HARD-GATE: task completion>
Do NOT mark task complete or move to next task until:
1. Spec compliance reviewer returned ✅ this session
2. Code quality reviewer returned ✅ this session
3. Tests run fresh — output shows passing
4. Implementer has committed
</HARD-GATE>
```

### /dev Completion

After all tasks:
- Dispatch final code reviewer for full implementation
- Surface any BLOCKED decisions to developer with full documentation
- If BLOCKED decisions exist: wait for developer input → implement → re-review

```
<HARD-GATE: /dev exit>
Do NOT declare /dev complete until:
1. All tasks are marked complete (or BLOCKED with decisions surfaced to developer)
2. Final code reviewer has approved
3. All decisions in decisions log have a Status of RESOLVED or PENDING-DEVELOPER-INPUT
4. No unresolved spec or quality issues remain
</HARD-GATE>
```

---

## /check — Refactored (HARD-GATE Exit Added)

All existing steps stay (type check, lint, code review, security, tests).

```
<HARD-GATE: /check exit>
Do NOT output any variation of "check complete", "ready to ship", or proceed to /ship
until ALL FOUR show fresh output in this session:

1. Type check: [command run] → [actual output] → exit 0 confirmed
2. Lint: [command run] → [actual output] → 0 errors, 0 warnings confirmed
3. Tests: [command run] → [actual output] → N/N passing confirmed
4. Security scan: [command run] → [actual output] → no critical issues

"Should pass", "was passing earlier", and "I'm confident" are not evidence.
Run the commands. Show the output. THEN declare done.
</HARD-GATE>
```

---

## /ship — Refactored (Entry Gate + PR Body Update)

```
<HARD-GATE: /ship entry>
Do NOT create PR until:
1. /check was run in this session with all four outputs shown
2. All checks confirmed passing (not assumed)
3. Beads issue is in_progress
4. Branch is NOT main or master
</HARD-GATE>
```

PR body template update — replace `/research` references with `/plan` design doc:
```
## Design Doc
See: docs/plans/YYYY-MM-DD-<slug>-design.md

## Decisions Log
See: docs/plans/YYYY-MM-DD-<slug>-decisions.md (if any undocumented decisions arose)
```

---

## /review — Refactored (HARD-GATE Exit Added)

All existing steps stay (GitHub Actions, Greptile, SonarCloud).

```
<HARD-GATE: /review exit>
Do NOT declare /review complete until:
1. bash .claude/scripts/greptile-resolve.sh stats <pr-number> shows "All Greptile threads resolved"
2. ALL human reviewer comments are either resolved or have a reply with explanation
3. gh pr checks <pr-number> shows all checks passing
</HARD-GATE>
```

---

## /premerge — Refactored (OpenSpec step removed + HARD-GATE STOP)

Remove: `openspec archive <slug>` step (OpenSpec no longer used)

Update doc references: check for `docs/plans/` design doc and decisions log instead of `docs/research/` and `openspec/`

```
<HARD-GATE: /premerge exit>
Do NOT run gh pr merge.
Do NOT suggest merging.
/premerge ends here. Output the PR URL and status. Wait for user.

"After you merge, run /verify to confirm everything landed correctly."
</HARD-GATE>
```

---

## /verify — No Changes

Current /verify is correct and lightweight. Add HARD-GATE:

```
<HARD-GATE: /verify exit>
Do NOT declare /verify complete until:
1. gh run list --branch master --limit 3 confirms CI passing on main (not just branch)
2. Beads issue is closed: bd close <id>
"It should be fine" is not evidence. Run the command. Show the output.
</HARD-GATE>
```

---

## /status — No Changes

Remains a utility command. Remove from numbered workflow stages in AGENTS.md table.

---

## Files to Change

### New command files (rewrites)
1. `.claude/commands/plan.md` — full rewrite: 3 phases, worktrees, task list, HARD-GATES
2. `.claude/commands/dev.md` — full rewrite: subagent-driven-development, decisions framework, HARD-GATES
3. `.claude/commands/check.md` — add HARD-GATE exit block
4. `.claude/commands/ship.md` — add HARD-GATE entry block, update PR body template
5. `.claude/commands/review.md` — add HARD-GATE exit block
6. `.claude/commands/premerge.md` — remove OpenSpec archive step, add HARD-GATE exit
7. `.claude/commands/verify.md` — add HARD-GATE exit block

### Config / docs updates
8. `AGENTS.md` — renumber stages 1-7, remove /status from table, update stage descriptions, update change classification stage numbers, remove OpenSpec references
9. `CLAUDE.md` — update workflow table (sync via script after AGENTS.md change)
10. `GEMINI.md` — update workflow table (sync via script)
11. `.claude/rules/workflow.md` — update workflow command table and philosophy section
12. `.claude/commands/research.md` — convert to thin alias: "This is now Phase 2 of /plan. Run /plan to start the full workflow."

### New files to create
13. `docs/plans/.gitkeep` — ensure docs/plans/ directory exists (currently doesn't exist, only docs/research/ exists)
14. `.worktrees/` entry in `.gitignore` — required for worktree isolation

### Files NOT to change
- `/review` Greptile scripts (`.claude/scripts/greptile-resolve.sh`) — unchanged
- Skills directory — no new skills needed; parallel-web-search and parallel-deep-research stay as-is
- Existing `/verify` command — only HARD-GATE addition needed

---

## TDD Verification Scenarios

Config files don't have unit tests. Verification is manual and behavioral:

1. **Phase 1 gate**: Run `/plan test-feature`. Answer design Q&A. Attempt web search before approving design. Agent must refuse — HARD-GATE fires.

2. **Phase 2 gate**: After design approval, attempt to jump to Phase 3 without OWASP section in design doc. Agent must refuse.

3. **Phase 3 gate**: Attempt `/dev` without task list file existing. Agent must refuse.

4. **TDD gate in /dev**: In implementer subagent, attempt to write production code before test. Agent must delete code and start with test.

5. **Spec before quality gate**: Force spec reviewer to return ✅, then verify quality reviewer fires. Attempt to skip spec reviewer — agent must refuse.

6. **/check HARD-GATE**: After implementing a change, run `/check` and have agent claim "tests should pass" without running them. Agent must run commands and show output.

7. **Decision gate scoring**: Create a scenario where implementer hits an undocumented decision affecting a shared module (score expected: 6+). Verify agent fills checklist, routes to spec reviewer, does NOT implement.

8. **/premerge HARD-GATE**: Run `/premerge` and verify agent produces PR URL and stops. Does NOT run `gh pr merge`.

9. **Decisions log**: Complete a /dev run. Verify `docs/plans/YYYY-MM-DD-<slug>-decisions.md` exists and all entries have Status field.

10. **Plan quality feedback**: After /dev, count decision gates fired. 0 = excellent plan. 3+ = Phase 1 Q&A insufficient.

---

## Security Analysis

| Risk | Stage | Mitigation |
|------|-------|-----------|
| Agent writes on main branch | /dev | HARD-GATE: branch check before any code |
| Silent spec drift | /dev | Spec compliance reviewer per task + decisions log |
| False completion claim | /check, /verify | HARD-GATE: run command, show output, THEN claim |
| Merge without review | /premerge | HARD-GATE: explicit STOP, PR URL output only |
| Worktree contents committed | /plan Phase 3 | git check-ignore verification before worktree creation |
| Undocumented high-impact decisions | /dev | Impact scoring checklist with 7 objective dimensions |
| Phase 1 ambiguity policy not captured | /plan Phase 1 | Q&A explicitly asks for ambiguity policy |

---

## Scope Assessment

**Type**: Strategic (architecture change — full workflow refactor affects all command files)
**Complexity**: High (9 files to rewrite + 4 config files + new directory)
**Branch**: `feat/forge-workflow-v2` (new branch)
**Beads**: Create new issue

**Parallelizable tracks**:
- Track A: /plan command rewrite (Phase 1 + 2 + 3, task list, HARD-GATES)
- Track B: /dev command rewrite (subagent-driven-development, decisions framework)
- Track C: AGENTS.md + CLAUDE.md + GEMINI.md + workflow.md updates
- Track D: /check + /ship + /review + /premerge + /verify HARD-GATE additions (lighter)

Track A and B have no shared dependencies and can be written in parallel. Track C depends on final stage numbering (wait for A+B to finalize). Track D is independent of all.

**Estimated sessions**: 2-3 for Track A+B (complex rewrites), 1 for Track C+D.

---

## Sources

| # | Source | Used For |
|---|--------|----------|
| 1 | `obra/superpowers` brainstorming/SKILL.md (GitHub API) | Phase 1 mechanics: Q&A structure, design doc format, HARD-GATE pattern |
| 2 | `obra/superpowers` writing-plans/SKILL.md (GitHub API) | Phase 3 task list: granularity, file paths, code in plan, TDD steps per task |
| 3 | `obra/superpowers` subagent-driven-development/SKILL.md (GitHub API) | /dev rewrite: implementer + 2-stage review per task, spec before quality order |
| 4 | `obra/superpowers` using-git-worktrees/SKILL.md (GitHub API) | /plan Phase 3: worktree creation, ignore verification, baseline test run |
| 5 | `obra/superpowers` verification-before-completion/SKILL.md (GitHub API) | /check HARD-GATE: Iron Law, command evidence required |
| 6 | Forge `.claude/commands/research.md` | Baseline for Phase 2 mechanics |
| 7 | Forge `.claude/commands/plan.md` | Baseline for Phase 3 setup mechanics |
| 8 | Forge `.claude/commands/dev.md` | Baseline for TDD enforcement, parallel tracks |
| 9 | Forge `.claude/commands/check.md` | Baseline for validation steps |
| 10 | Forge `.claude/commands/ship.md` | Baseline for PR creation |
| 11 | Forge `.claude/commands/review.md` | Baseline for Greptile + SonarCloud process |
| 12 | Forge `.claude/commands/premerge.md` | Baseline for doc updates + hand-off |
| 13 | Forge `.claude/commands/verify.md` | Baseline for post-merge CI check |
| 14 | Forge `AGENTS.md` | Current workflow table and change classifications |
| 15 | `docs/research/superpowers.md` (this session) | Superpowers overview, 14 skills, community reception |
| 16 | `docs/research/superpowers-integration.md` (this session) | Integration options analysis, auto-trigger collision documentation |
| 17 | Session design decisions (conversation record) | All 10 design decisions documented above |

---

## Next Step

```bash
/plan forge-workflow-v2
```
