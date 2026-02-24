# Forge Workflow Rules

9-stage TDD-first development workflow for any project.

## Workflow Commands

| Phase | Command | Purpose |
|-------|---------|---------|
| 1 | `/status` | Check current stage, active work, recent completions |
| 2 | `/research` | Deep research with parallel-web-search, save to docs/research/ |
| 3 | `/plan` | Create formal plan, branch, OpenSpec proposal (if strategic) |
| 4 | `/dev` | Implement with TDD, parallel if needed |
| 5 | `/check` | Type check, lint, code review, security, tests |
| 6 | `/ship` | Push and create PR with full documentation |
| 7 | `/review` | Handle ALL PR issues (GitHub Actions, reviewers, CI/CD) |
| 8 | `/premerge` | Complete docs on feature branch, hand off PR to user |
| 9 | `/verify` | Post-merge health check (CI, deployments) |

## Core Principles

### TDD-First Development
- Tests written UPFRONT in RED-GREEN-REFACTOR cycles
- No implementation without failing test first
- Commit after each GREEN cycle

### Research-First Approach
- All features start with comprehensive research
- Use parallel-web-search (or parallel-deep-research) for web research (MANDATORY)
- Document findings in `docs/research/<feature-slug>.md`

### Security Built-In
- OWASP Top 10 analysis for every feature
- Security test scenarios identified upfront
- Automated scans + manual review

### Documentation Progressive
- Updated at relevant stages
- Cross-checked at end with `/verify`
- Never accumulate documentation debt

## Issue Tracking

Use Beads for persistent tracking across sessions:
```bash
bd create "Feature name"           # Create issue
bd update <id> --status in_progress  # Claim work
bd update <id> --comment "Progress"  # Add notes
bd close <id>                      # Complete
bd sync                            # Sync with git
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

### Parallel AI (MANDATORY for web research)
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
/status → /research → /plan → /dev → /check → /ship → /review → /premerge → /verify
   ↓          ↓          ↓        ↓        ↓         ↓          ↓          ↓         ↓
  Check     Research   OpenSpec   TDD    Validate   PR      Address     Merge    Verify
 context    + docs    + Beads   cycles   + scan   create   feedback    + docs    docs
```
