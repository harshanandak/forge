# Forge Workflow Rules

7-stage TDD-first development workflow for any project.

## Workflow Commands

| Stage | Command | Purpose |
|-------|---------|---------|
| utility | `/status` | Check current stage, active work, recent completions |
| 1 | `/plan` | Design intent (brainstorm) → research → branch + worktree + task list |
| 2 | `/dev` | Subagent-driven TDD per task: implementer → spec review → quality review |
| 3 | `/check` | Type check, lint, code review, security, tests — all fresh output |
| 4 | `/ship` | Push and create PR with design doc reference |
| 5 | `/review` | Handle ALL PR issues (GitHub Actions, Greptile, SonarCloud) |
| 6 | `/premerge` | Complete docs on feature branch, hand off PR to user |
| 7 | `/verify` | Post-merge health check (CI on main, close Beads) |

## Core Principles

### Design-First Planning
- All features start with Phase 1: one-question-at-a-time Q&A to capture design intent
- Design doc saved to `docs/plans/YYYY-MM-DD-<slug>-design.md`
- Research (Phase 2) and task list (Phase 3) follow design approval
- Phase 1 quality directly determines /dev autonomy — resolve ambiguity upfront

### TDD-First Development
- Task list pre-made in /plan Phase 3; /dev reads and executes it
- Each task: implementer subagent → spec compliance reviewer → code quality reviewer
- RED-GREEN-REFACTOR enforced inside implementer via HARD-GATE
- Decision gate (7-dimension scoring) fires when spec gap found mid-task

### HARD-GATES at Stage Exits
- Structural enforcement — not soft instructions
- Every stage exit has explicit conditions that must be met
- "Should be fine" and "was passing earlier" are never evidence
- Run the command, show the output, THEN declare done

### Security Built-In
- OWASP Top 10 analysis documented in design doc (Phase 2)
- Security test scenarios identified before /dev
- Automated scans + manual review at /check

## Issue Tracking

Use Beads for persistent tracking across sessions:
```bash
bd create --title="Feature name" --type=feature   # Create issue
bd update <id> --status=in_progress               # Claim work
bd update <id> --comment "Progress"               # Add notes
bd close <id>                                     # Complete
bd sync                                           # Sync with git
```

## Git Workflow

```bash
# Branch naming
feat/<feature-slug>
fix/<bug-slug>
docs/<doc-slug>

# Commit pattern
git commit -m "test: add validation tests"     # RED
git commit -m "feat: implement validation"     # GREEN
git commit -m "refactor: extract helpers"      # REFACTOR

# Worktrees (required for /dev)
git worktree add .worktrees/<slug> feat/<slug>
# .worktrees/ is gitignored
```

## Configuration

Customize these commands for your stack:

```bash
# In your project's CLAUDE.md or .claude/rules/
TYPE_CHECK_COMMAND="bun run typecheck"   # or: npm run typecheck, tsc, etc.
LINT_COMMAND="bun run lint"               # or: npm run lint, eslint, etc.
TEST_COMMAND="bun test"                   # or: npm run test, jest, etc.
SECURITY_SCAN="bunx npm audit"            # or: npm audit, snyk test, etc.
```

## Skills Integration

### Parallel AI (MANDATORY for Phase 2 web research)
Use focused skills from `skills/` directory:
```bash
Skill("parallel-web-search")     # Quick web lookups, news, sources
Skill("parallel-deep-research")  # Deep analysis, market reports
```

### sonarcloud (Code quality)
```bash
/sonarcloud  # Query PR-specific issues
```

## Flow Visualization

```
/plan → /dev → /check → /ship → /review → /premerge → /verify
  ↓        ↓        ↓        ↓        ↓          ↓         ↓
Design   Task-by  Validate   PR      Address    Merge    Verify
+Research  task    +GATE    create   feedback    +docs    CI on
+Tasks    TDD                                   GATE     master
```
