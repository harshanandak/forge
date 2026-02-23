# Project Workflow Instructions

## 9-Stage TDD-First Workflow

This project enforces a **strict TDD-first development workflow** with 9 stages:

| Stage | Command     | Purpose                                      | Required For |
|-------|-------------|----------------------------------------------|--------------|
| 1     | `/status`   | Check current context, active work           | All types    |
| 2     | `/research` | Research with web search, document findings  | Critical     |
| 3     | `/plan`     | Create implementation plan, branch, OpenSpec | Critical, Standard, Refactor |
| 4     | `/dev`      | TDD development (RED-GREEN-REFACTOR)         | All types    |
| 5     | `/check`    | Validation (type/lint/security/tests)        | All types    |
| 6     | `/ship`     | Create PR with documentation                 | All types    |
| 7     | `/review`   | Address ALL PR feedback                      | Critical, Standard |
| 8     | `/merge`    | Update docs, merge PR, cleanup               | All types    |
| 9     | `/verify`   | Final documentation verification             | All types    |

## Automatic Change Classification

When the user requests work, **you MUST automatically classify** the change type:

### Critical (Full 9-stage workflow)
**Triggers:** Security, authentication, payments, breaking changes, new architecture, data migrations
**Example:** "Add OAuth login", "Migrate database schema", "Implement payment gateway"
**Workflow:** status → research → plan → dev → check → ship → review → merge → verify

### Standard (6-stage workflow, research optional)
**Triggers:** Normal features, enhancements, new components
**Example:** "Add user profile page", "Create notification system"
**Workflow:** status → plan → dev → check → ship → merge

### Simple (4-stage workflow, skip research/plan)
**Triggers:** Bug fixes, UI tweaks, small changes, minor refactors
**Example:** "Fix button color", "Update validation message", "Adjust padding"
**Workflow:** dev → check → ship → merge

### Hotfix (Emergency 3-stage workflow)
**Triggers:** Production emergencies, critical bugs affecting users
**Example:** "Production payment processing down", "Security vulnerability fix"
**Workflow:** dev → check → ship (immediate merge allowed)

### Docs (Documentation-only workflow)
**Triggers:** Documentation updates, README changes, comment improvements
**Example:** "Update README", "Add API documentation"
**Workflow:** verify → ship → merge

### Refactor (5-stage workflow for safe cleanup)
**Triggers:** Code cleanup, performance optimization, technical debt reduction
**Example:** "Refactor auth service", "Extract utility functions"
**Workflow:** plan → dev → check → ship → merge

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

## TDD Development (Stage 4: /dev)

**Automatic orchestration with parallel Task agents:**

1. **Analyze plan** → Identify parallel vs sequential tasks from Beads/OpenSpec
2. **Launch Task agents** → Spawn specialized agents for independent work
3. **Enforce RED-GREEN-REFACTOR** → Each agent follows strict TDD cycle:
   - RED: Write failing test first
   - GREEN: Implement minimal code to pass
   - REFACTOR: Clean up while keeping tests green
4. **Show progress** → Real-time updates on parallel tracks
5. **Integrate** → Final E2E tests validate everything works together

**Example execution:**
```
User: "Build Stripe payment integration"

You analyze plan:
  ✓ Identified 3 independent tracks:
    - API endpoints (server-side)
    - Webhook handlers (server-side)
    - Checkout UI (client-side)

You launch parallel agents:
  ✓ Task(backend-architect, "API endpoints with TDD")
  ✓ Task(backend-architect, "Webhook handlers with TDD")
  ✓ Task(typescript-pro, "Checkout UI with TDD")

You show live progress:
  Track 1 (backend-architect): API endpoints
    ✓ RED: Payment validation tests written
    ⏳ GREEN: Implementing Stripe API calls

  Track 2 (backend-architect): Webhook handlers
    ✓ RED: Webhook signature tests written
    ✓ GREEN: Signature verification implemented
    ⏳ REFACTOR: Extracting helper functions

  Track 3 (typescript-pro): UI components
    ✓ RED: Component tests written
    ⏳ GREEN: Building CheckoutForm component
```

## State Management (Single Source of Truth)

**All workflow state stored in Beads metadata** (survives compaction):

```json
{
  "id": "bd-x7y2",
  "type": "critical",
  "currentStage": "dev",
  "completedStages": ["status", "research", "plan"],
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
- [.claude/commands/status.md](.claude/commands/status.md) - How to check current context
- [.claude/commands/research.md](.claude/commands/research.md) - How to conduct research with parallel-web-search
- [.claude/commands/plan.md](.claude/commands/plan.md) - How to create implementation plans
- [.claude/commands/dev.md](.claude/commands/dev.md) - How to execute TDD development
- [.claude/commands/check.md](.claude/commands/check.md) - How to run validation
- [.claude/commands/ship.md](.claude/commands/ship.md) - How to create PRs
- [.claude/commands/review.md](.claude/commands/review.md) - How to address PR feedback
- [.claude/commands/merge.md](.claude/commands/merge.md) - How to merge and cleanup
- [.claude/commands/verify.md](.claude/commands/verify.md) - How to verify documentation

**Comprehensive workflow guide:**
- [docs/WORKFLOW.md](docs/WORKFLOW.md) - Complete workflow documentation (150 lines)
- [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) - Tool setup and configuration
- [docs/VALIDATION.md](docs/VALIDATION.md) - Enforcement and validation details

**Load these files when you need detailed instructions for a specific stage.**
