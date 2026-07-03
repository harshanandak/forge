# Project Workflow Instructions

## Default TDD-First Workflow Template

This project ships a **default TDD-first workflow template** with 7 named stage skills. In v3, these stages are one configurable composition over Forge runtime building blocks, not a product-wide mandatory ladder. Commands may be invoked as full stages or as smaller skill fragments when the active plan permits it.

| Stage | Command     | Purpose                                                   | Required For |
|-------|-------------|-----------------------------------------------------------|--------------|
| 1     | `/plan`     | Design intent → research → branch + worktree + task list | Critical, Standard, Refactor |
| 2     | `/dev`      | Subagent-driven TDD per task (spec + quality review)     | All types    |
| 3     | `/validate`    | Validate + 4-phase debug mode on failure                    | All types    |
| 4     | `/ship`     | Create PR with documentation                             | All types    |
| 5     | `/review`   | Address ALL PR feedback                                  | Critical, Standard |
| 6     | `/verify`   | Post-merge health check (CI, deployments)                | All types    |

**Pre-merge gate (not a numbered stage)**: Completing docs on the feature branch and handing off the PR for merge is a **task-type gate and checkpoint**, not a standalone workflow stage. The gate runs for Critical, Standard, and Refactor work and is embedded in the `/ship` and `/review` stages — finish the doc updates, confirm CI is green, then hand off the PR. Simple, Hotfix, and Docs work skip the gate.

**Utility**: `/status` — Context check before starting work (not a numbered stage)

**Utility**: `/shepherd <pr>` — Monitor-driven PR shepherd: one bounded pass that reads CI and check state, re-runs a flaky required check (Tier-A), or escalates, then hands off. It is a utility command, **not** a workflow stage, and does not sit between `/review` and the handoff. It **never merges** (the human merges in the GitHub UI) and **never resolves review threads** (that stays with `/review`). `--auto-rebase` is opt-in and default OFF. See [docs/reference/shepherd.md](docs/reference/shepherd.md).

## Automatic Change Classification

When the user requests work, **you MUST automatically classify** the change type:

### Critical (Full default workflow template)
**Triggers:** Security, authentication, payments, breaking changes, new architecture, data migrations
**Example:** "Add OAuth login", "Migrate database schema", "Implement payment gateway"
**Workflow:** plan → dev → validate → ship → review → verify (pre-merge gate before merge)

### Standard (default workflow without post-merge verify)
**Triggers:** Normal features, enhancements, new components
**Example:** "Add user profile page", "Create notification system"
**Workflow:** plan → dev → validate → ship → review (pre-merge gate before merge)

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
**Workflow:** plan → dev → validate → ship (pre-merge gate before merge)

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

## TDD Development (`/dev` Command)

**Subagent-driven per-task implementation loop:**

1. **Read task list** → Pre-made task list from `/plan` Phase 3 at `docs/work/YYYY-MM-DD-<slug>/tasks.md`
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
  ✓ Read task list: docs/work/2026-02-26-stripe-billing/tasks.md (8 tasks)
  ✓ Created decisions log: docs/work/2026-02-26-stripe-billing/decisions.md

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

> GitHub issue lifecycle may sync to Beads via CI -- see [docs/guides/BEADS_GITHUB_SYNC.md](docs/guides/BEADS_GITHUB_SYNC.md).

**Current implementation**: The Forge Kernel is the default issue-state authority; issue commands read and write the kernel store unless Beads is explicitly selected (`--issue-backend beads`, `FORGE_ISSUE_BACKEND=beads`, or `issueBackend: beads` in `.forge/config.yaml`), where it serves as an import/export/projection compatibility layer. **Direction (D44)**: continue consolidating issue/workflow/run authority in the Kernel with Beads remaining a compatibility projection. New authority work must follow [docs/work/2026-04-28-skeleton-pivot/forge-kernel-authority-control-plane.md](docs/work/2026-04-28-skeleton-pivot/forge-kernel-authority-control-plane.md) and [docs/reference/FORGE_KERNEL_STORAGE_MODEL.md](docs/reference/FORGE_KERNEL_STORAGE_MODEL.md).

```json
{
  "id": "forge-x7y2",
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

**Detailed stage skill instructions** are located in:
- [skills/status/SKILL.md](skills/status/SKILL.md) - How to check current context (utility)
- [skills/plan/SKILL.md](skills/plan/SKILL.md) - How to plan features (3 phases: design intent + research + branch/worktree/tasks)
- [skills/dev/SKILL.md](skills/dev/SKILL.md) - How to implement with subagent-driven TDD and decision gate
- [skills/validate/SKILL.md](skills/validate/SKILL.md) - How to run validation (with HARD-GATE exit)
- [skills/ship/SKILL.md](skills/ship/SKILL.md) - How to create PRs
- [skills/review/SKILL.md](skills/review/SKILL.md) - How to address PR feedback (with HARD-GATE exit)
- [skills/shepherd/SKILL.md](skills/shepherd/SKILL.md) - How to run a bounded PR monitor pass (utility; never merges, never resolves threads)
- [skills/verify/SKILL.md](skills/verify/SKILL.md) - How to verify post-merge health

**Planning documents** (created by `/plan`, consumed by `/dev`):
- `docs/work/YYYY-MM-DD-<slug>/design.md` - Design intent + technical research
- `docs/work/YYYY-MM-DD-<slug>/tasks.md` - Task list with TDD steps
- `docs/work/YYYY-MM-DD-<slug>/decisions.md` - Decisions log from /dev

**Comprehensive workflow guide:**
- This file (AGENTS.md) is the single source of truth for the complete workflow
- [docs/reference/TOOLCHAIN.md](docs/reference/TOOLCHAIN.md) - Tool setup and configuration
- [docs/reference/VALIDATION.md](docs/reference/VALIDATION.md) - Enforcement and validation details

**Forge v3 / Kernel Plan (active design):**
- [docs/work/2026-04-28-skeleton-pivot/forge-kernel-authority-control-plane.md](docs/work/2026-04-28-skeleton-pivot/forge-kernel-authority-control-plane.md) — canonical Forge Kernel authority reset plan for issue authority, local broker, team authority, adapters, storage, and gates
- [docs/work/2026-04-28-skeleton-pivot/locked-decisions.md](docs/work/2026-04-28-skeleton-pivot/locked-decisions.md) — D1–D44 decisions ledger with rationale + tradeoffs + anti-decisions; D44 supersedes Beads-only authority portions of earlier decisions
- [docs/work/2026-04-28-skeleton-pivot/v3-redesign-strategy.md](docs/work/2026-04-28-skeleton-pivot/v3-redesign-strategy.md) — historical v3 strategy and background; do not use its legacy default-substrate language over D44
- See [docs/INDEX.md](docs/INDEX.md) for the full reading order across the v3 design folder

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
| pre-merge gate | Docs updated, CI green | N/A | Updated doc files | Merge instructions |

### Validation Command

Run at each stage exit to check for missing context:

```bash
bash scripts/beads-context.sh validate <beads-issue-id>
```

This checks: (1) issue has a description, (2) at least one stage transition exists, (3) most recent transition has a summary, (4) design metadata is set if past the plan stage. Exits 0 when context checks run (even if warnings are found); exits 1 only if the issue cannot be retrieved.

### Field Definitions

- **Summary**: 1-2 sentence recap of what was accomplished in this stage. Example: `--summary "All 5 tasks done, 1 decision gate fired"`
- **Decisions**: Key choices made during this stage that affect downstream work. Example: `--decisions "Used streaming parser over DOM for memory efficiency"`
- **Artifacts**: File paths or URLs produced by this stage. Example: `--artifacts "lib/parser.js test/parser.test.js docs/work/2026-03-26-parser/design.md"`
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

## Forge Issue Tracker

This project uses the **Forge Kernel** for issue tracking. Run `forge prime` to see full workflow context and commands.

### Quick Reference

```bash
forge ready           # Find available work
forge show <id>       # View issue details
forge claim <id>      # Claim work
forge close <id>      # Complete work
```

### Rules

- Use `forge` as the routine command surface for issue tracking and sync workflows — do NOT use TodoWrite, TaskCreate, or markdown TODO lists. Exception: `/plan` Phase 3 generates task lists at `docs/work/YYYY-MM-DD-<slug>/tasks.md` — these are approved artifacts consumed by `/dev`. New issue-authority work routes through the Forge Kernel design. Use `forge issue` subcommands (e.g. `forge issue dep`, `forge issue comment`) for operations beyond the shortcuts above. GitHub issues may be used for external/public tracking; CI may sync GitHub issue lifecycle to the issue store.
- Run `forge prime` for detailed command reference and session close protocol
- Use `forge remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
    git pull --rebase
    forge sync     # wraps the supported issue-store sync flow when the issue store is configured
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
- After fixing review feedback, always push the changes and resolve the related GitHub review threads via the GraphQL API before considering the work complete
