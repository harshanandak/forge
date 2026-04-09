# Project Workflow Instructions

## 7-Stage TDD-First Workflow

This project enforces a **strict TDD-first development workflow** with 7 stages:

| Stage | Command     | Purpose                                                   | Required For |
|-------|-------------|-----------------------------------------------------------|--------------|
| 1     | `/plan`     | Design intent → research → branch + worktree + task list | Critical, Standard, Refactor |
| 2     | `/dev`      | Subagent-driven TDD per task (spec + quality review)     | All types    |
| 3     | `/validate`    | Validate + 4-phase debug mode on failure                    | All types    |
| 4     | `/ship`     | Create PR with documentation                             | All types    |
| 5     | `/review`   | Address ALL PR feedback                                  | Critical, Standard |
| 6     | `/premerge` | Complete docs on feature branch, hand off PR             | All types    |
| 7     | `/verify`   | Post-merge health check (CI, deployments)                | All types    |

**Utility**: `/status` — Context check before starting work (not a numbered stage)

## Automatic Change Classification

When the user requests work, **you MUST automatically classify** the change type:

### Critical (Full 7-stage workflow)
**Triggers:** Security, authentication, payments, breaking changes, new architecture, data migrations
**Example:** "Add OAuth login", "Migrate database schema", "Implement payment gateway"
**Workflow:** plan → dev → validate → ship → review → premerge → verify

### Standard (6-stage workflow)
**Triggers:** Normal features, enhancements, new components
**Example:** "Add user profile page", "Create notification system"
**Workflow:** plan → dev → validate → ship → review → premerge

### Simple (3-stage workflow, skip plan)
**Triggers:** Bug fixes, UI tweaks, small changes, minor refactors
**Example:** "Fix button color", "Update validation message", "Adjust padding"
**Workflow:** dev → validate → ship

### Hotfix (Emergency 3-stage workflow)
**Triggers:** Production emergencies, critical bugs affecting users
**Example:** "Production payment processing down", "Security vulnerability fix"
**Workflow:** dev → validate → ship (immediate merge allowed)

### Docs (Documentation-only workflow)
**Triggers:** Documentation updates, README changes, comment improvements
**Example:** "Update README", "Add API documentation"
**Workflow:** verify → ship

### Refactor (5-stage workflow for safe cleanup)
**Triggers:** Code cleanup, performance optimization, technical debt reduction
**Example:** "Refactor auth service", "Extract utility functions"
**Workflow:** plan → dev → validate → ship → premerge

## Enforcement Philosophy

**Conversational, not blocking** - Offer solutions when prerequisites are missing:

❌ **Don't:** "ERROR: Research required for critical features"
✅ **Do:** "Before implementation, I should research OAuth best practices. I can:
   1. Auto-research now with parallel-deep-research (~5 min)
   2. Use your research if you have it
   3. Skip (not recommended for security features)

   What would you prefer?"

**Create accountability for skips:**

"Skipping tests creates technical debt. I'll:
 ✓ Allow this commit
 ✓ Create follow-up Beads issue for tests
 ✓ Document in commit message as [tech-debt]

 Proceed?"

**Dynamic commands — no hardcoded examples:**

Command files (`.claude/commands/*.md` and agent equivalents) must never hardcode example output when a script generates that output dynamically. Reference the script and describe what it does — don't duplicate its output with fake data that becomes stale.

## TDD Development (Stage 2: /dev)

**Subagent-driven per-task implementation loop:**

1. **Read task list** → Pre-made task list from `/plan` Phase 3 at `docs/plans/YYYY-MM-DD-<slug>-tasks.md`
2. **Dispatch implementer subagent per task** → Fresh context, complete task text, relevant design doc sections
3. **TDD inside implementer** → RED-GREEN-REFACTOR enforced by HARD-GATE:
   - RED: Write failing test first (must run test and show failing output)
   - GREEN: Implement minimal code to pass (must show passing output)
   - REFACTOR: Clean up while keeping tests green
4. **Spec compliance review** → Spec reviewer checks every task before quality review
5. **Code quality review** → Quality reviewer checks after spec compliance ✅
6. **Decision gate** → 7-dimension impact scoring when spec gap found; score routes to PROCEED/SPEC-REVIEWER/BLOCKED

**Example execution:**
```
/dev starts:
  ✓ Read task list: docs/plans/2026-02-26-stripe-billing-tasks.md (8 tasks)
  ✓ Created decisions log: docs/plans/2026-02-26-stripe-billing-decisions.md

Task 1: Types and interfaces
  ✓ Implementer: test written → failing → implementation → passing → committed
  ✓ Spec review: ✅
  ✓ Quality review: ✅
  Decision gates: 0

Task 2: Validation logic
  ✓ Implementer: test written → failing → implementation → passing
  ⚠️  Decision gate fired (score: 2/14 — PROCEED)
     Gap: Error message format not specified in design doc
     Choice: Use { code, message } object (conservative, documented)
  ✓ Spec review: ✅
  ✓ Quality review: ✅
```

## State Management (Single Source of Truth)

> GitHub issue lifecycle may sync to Beads via CI -- see [docs/BEADS_GITHUB_SYNC.md](docs/BEADS_GITHUB_SYNC.md).

**All workflow state stored in Beads metadata** (survives compaction):

```json
{
  "id": "bd-x7y2",
  "type": "critical",
  "currentStage": "dev",
  "completedStages": ["plan"],
  "skippedStages": [],
  "workflowDecisions": {
    "classification": "critical",
    "reason": "Payment processing, PCI compliance required",
    "userOverride": false
  },
  "parallelTracks": [
    {
      "name": "API endpoints",
      "agent": "backend-architect",
      "status": "in_progress",
      "tddPhase": "GREEN"
    }
  ]
}
```

## Git Hooks (Automatic Enforcement)

**Pre-commit hook enforces TDD:**
- Blocks commits if source code modified without test files
- Offers guided recovery (add tests now, skip with tech debt tracking, emergency override)
- No AI decision required - automatic validation

**Pre-push hook validates tests:**
- All tests must pass before push
- Can skip for hotfixes with documentation

## Documentation Index (Context Pointers)

**Detailed command instructions** are located in:
- [.claude/commands/status.md](.claude/commands/status.md) - How to check current context (utility)
- [.claude/commands/plan.md](.claude/commands/plan.md) - How to plan features (3 phases: design intent + research + branch/worktree/tasks)
- [.claude/commands/dev.md](.claude/commands/dev.md) - How to implement with subagent-driven TDD and decision gate
- [.claude/commands/validate.md](.claude/commands/validate.md) - How to run validation (with HARD-GATE exit)
- [.claude/commands/ship.md](.claude/commands/ship.md) - How to create PRs
- [.claude/commands/review.md](.claude/commands/review.md) - How to address PR feedback (with HARD-GATE exit)
- [.claude/commands/premerge.md](.claude/commands/premerge.md) - How to complete docs and hand off PR for merge
- [.claude/commands/verify.md](.claude/commands/verify.md) - How to verify post-merge health

**Planning documents** (created by `/plan`, consumed by `/dev`):
- `docs/plans/YYYY-MM-DD-<slug>-design.md` - Design intent + technical research
- `docs/plans/YYYY-MM-DD-<slug>-tasks.md` - Task list with TDD steps
- `docs/plans/YYYY-MM-DD-<slug>-decisions.md` - Decisions log from /dev

**Comprehensive workflow guide:**
- This file (AGENTS.md) is the single source of truth for the complete workflow
- [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) - Tool setup and configuration
- [docs/VALIDATION.md](docs/VALIDATION.md) - Enforcement and validation details

**Load these files when you need detailed instructions for a specific stage.**

## Descriptive Context Convention

Every stage transition should carry structured context so the next stage (or a new session) can resume without re-reading the full design doc. This convention is **advisory** — warnings are informational, not blocking.

### Required Fields at Each Stage Exit

| Stage Exit | Summary | Decisions | Artifacts | Next |
|------------|---------|-----------|-----------|------|
| /plan      | Design approach chosen | Key trade-offs resolved | Design doc, task list paths | First dev task focus |
| /dev       | Tasks completed, gate count | Spec gaps encountered | Changed files, test files | Validation priorities |
| /validate  | All checks pass/fail summary | Failures diagnosed | Scripts/commands run | Ship readiness |
| /ship      | PR created, checks pending | Template sections filled | PR URL, branch name | Review focus areas |
| /review    | All feedback addressed | Comment resolutions | Fixed files, commit SHAs | Doc update needs |
| /premerge  | Docs updated, CI green | N/A | Updated doc files | Merge instructions |

### Validation Command

Run at each stage exit to check for missing context:

```bash
bash scripts/beads-context.sh validate <beads-issue-id>
```

This checks: (1) issue has a description, (2) at least one stage transition exists, (3) most recent transition has a summary, (4) design metadata is set if past the plan stage. Exits 0 when context checks run (even if warnings are found); exits 1 only if the issue cannot be retrieved.

### Field Definitions

- **Summary**: 1-2 sentence recap of what was accomplished in this stage. Example: `--summary "All 5 tasks done, 1 decision gate fired"`
- **Decisions**: Key choices made during this stage that affect downstream work. Example: `--decisions "Used streaming parser over DOM for memory efficiency"`
- **Artifacts**: File paths or URLs produced by this stage. Example: `--artifacts "lib/parser.js test/parser.test.js docs/plans/2026-03-26-parser-design.md"`
- **Next**: Guidance for the next stage on what to focus on. Example: `--next "Run lint first — streaming approach may trigger no-await rule"`

### Usage in Stage Transitions

```bash
# Basic (backward compatible)
bash scripts/beads-context.sh stage-transition <id> dev validate

# With context fields (recommended)
bash scripts/beads-context.sh stage-transition <id> dev validate \
  --summary "All 5 tasks done, 0 gates fired" \
  --decisions "Used approach A per design doc" \
  --artifacts "lib/foo.js test/foo.test.js" \
  --next "Run type check and lint"
```

### Enforcement Level

This convention is **advisory only**. The `validate` subcommand prints warnings but always exits 0. It does not block any stage transition. The goal is to build good habits, not to create friction.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
forge ready           # Find available work
forge show <id>       # View issue details
forge claim <id>      # Claim work
forge close <id>      # Complete work
```

### Rules

- Use `forge` as the routine command surface for bd-backed issue tracking and sync workflows — do NOT use TodoWrite, TaskCreate, or markdown TODO lists. Exception: `/plan` Phase 3 generates task lists at `docs/plans/YYYY-MM-DD-<slug>-tasks.md` — these are approved artifacts consumed by `/dev`, but Beads (`bd`) remains the source of truth for issue state and IDs. Use `bd` directly only for operations Forge does not wrap yet, such as `bd init`, `bd comments`, `bd dep`, and `bd dolt *`. GitHub issues may be used for external/public tracking; CI may sync GitHub issue lifecycle to Beads (see `docs/BEADS_GITHUB_SYNC.md`).
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
    git pull --rebase
    forge sync     # wraps the supported Beads sync flow when Beads is configured
    git push
    git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
