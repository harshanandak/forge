# Project Workflow Instructions

## 7-Stage TDD-First Workflow

This project enforces a **strict TDD-first development workflow** with 7 stages:

| Stage | Command     | Purpose                                                   | Required For |
|-------|-------------|-----------------------------------------------------------|--------------|
| 1     | `/plan`     | Design intent → research → branch + worktree + task list | Critical, Standard, Refactor |
| 2     | `/dev`      | Subagent-driven TDD per task (spec + quality review)     | All types    |
| 3     | `/check`    | Validation (type/lint/security/tests)                    | All types    |
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
**Workflow:** plan → dev → check → ship → review → premerge → verify

### Standard (6-stage workflow)
**Triggers:** Normal features, enhancements, new components
**Example:** "Add user profile page", "Create notification system"
**Workflow:** plan → dev → check → ship → review → premerge

### Simple (3-stage workflow, skip plan)
**Triggers:** Bug fixes, UI tweaks, small changes, minor refactors
**Example:** "Fix button color", "Update validation message", "Adjust padding"
**Workflow:** dev → check → ship

### Hotfix (Emergency 3-stage workflow)
**Triggers:** Production emergencies, critical bugs affecting users
**Example:** "Production payment processing down", "Security vulnerability fix"
**Workflow:** dev → check → ship (immediate merge allowed)

### Docs (Documentation-only workflow)
**Triggers:** Documentation updates, README changes, comment improvements
**Example:** "Update README", "Add API documentation"
**Workflow:** verify → ship

### Refactor (5-stage workflow for safe cleanup)
**Triggers:** Code cleanup, performance optimization, technical debt reduction
**Example:** "Refactor auth service", "Extract utility functions"
**Workflow:** plan → dev → check → ship → premerge

## Enforcement Philosophy

**Conversational, not blocking** - Offer solutions when prerequisites are missing:

❌ **Don't:** "ERROR: Research required for critical features"
✅ **Do:** "Before implementation, I should research OAuth best practices. I can:
   1. Auto-research now with parallel-web-search (~5 min)
   2. Use your research if you have it
   3. Skip (not recommended for security features)

   What would you prefer?"

**Create accountability for skips:**

"Skipping tests creates technical debt. I'll:
 ✓ Allow this commit
 ✓ Create follow-up Beads issue for tests
 ✓ Document in commit message as [tech-debt]

 Proceed?"

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
- [.claude/commands/check.md](.claude/commands/check.md) - How to run validation (with HARD-GATE exit)
- [.claude/commands/ship.md](.claude/commands/ship.md) - How to create PRs
- [.claude/commands/review.md](.claude/commands/review.md) - How to address PR feedback (with HARD-GATE exit)
- [.claude/commands/premerge.md](.claude/commands/premerge.md) - How to complete docs and hand off PR for merge
- [.claude/commands/verify.md](.claude/commands/verify.md) - How to verify post-merge health

**Planning documents** (created by `/plan`, consumed by `/dev`):
- `docs/plans/YYYY-MM-DD-<slug>-design.md` - Design intent + technical research
- `docs/plans/YYYY-MM-DD-<slug>-tasks.md` - Task list with TDD steps
- `docs/plans/YYYY-MM-DD-<slug>-decisions.md` - Decisions log from /dev

**Comprehensive workflow guide:**
- [docs/WORKFLOW.md](docs/WORKFLOW.md) - Complete workflow documentation (150 lines)
- [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) - Tool setup and configuration
- [docs/VALIDATION.md](docs/VALIDATION.md) - Enforcement and validation details

**Load these files when you need detailed instructions for a specific stage.**
