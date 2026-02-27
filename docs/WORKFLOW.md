# Forge Development Workflow

Complete 7-stage TDD-first workflow for feature development. Works with any tech stack.

## Overview

This workflow integrates:
- **Test-Driven Development (TDD)**: Tests written UPFRONT
- **Design-First**: One-question-at-a-time Q&A captures intent before research
- **Issue Tracking**: Beads for persistent tracking across agents
- **Security**: OWASP Top 10 analysis for every feature (in /plan Phase 2)
- **Documentation**: Progressive updates, final verification

## Workflow Stages

```
┌─────────┐
│ /status │ → Check current stage & context (utility, not a numbered stage)
└─────────┘

┌────▼────┐
│  /plan  │ → Phase 1: Design Q&A → Phase 2: Research → Phase 3: Branch + task list
└────┬────┘
     │
┌────▼───┐
│  /dev  │ → Subagent TDD per task: implementer → spec review → quality review
└────┬───┘
     │
┌────▼────┐
│ /check  │ → Validation (type/lint/tests/security) — HARD-GATE exit
└────┬────┘
     │
┌────▼────┐
│  /ship  │ → Create PR with full documentation
└────┬────┘
     │
┌────▼─────┐
│ /review  │ → Address ALL PR issues (GitHub Actions, Greptile, SonarCloud)
└────┬─────┘
     │
┌────▼─────┐
│ /premerge│ → Complete docs on feature branch, hand off PR to user
└────┬─────┘
     │
┌────▼──────┐
│  /verify  │ → Post-merge health check (CI on main, close Beads)
└───────────┘
     │
     ✓ Complete
```

## Quick Reference

| Stage | Command | Key Actions |
|-------|---------|-------------|
| utility | `/status` | Check current context, active Beads issues |
| 1 | `/plan <slug>` | Design Q&A + research (OWASP) + branch + task list |
| 2 | `/dev` | Subagent TDD cycles (implementer → spec review → quality review) |
| 3 | `/check` | Type/lint/security/tests — HARD-GATE exit |
| 4 | `/ship` | Create PR with full docs |
| 5 | `/review <pr>` | Fix ALL PR issues (GitHub Actions, Greptile, SonarCloud) |
| 6 | `/premerge <pr>` | Complete docs on feature branch, hand off PR |
| 7 | `/verify` | Post-merge health check (CI on main, close Beads) |

For detailed information on each stage, see the individual command files in `.claude/commands/`.

## TDD Principles

### What is TDD?

**Test-Driven Development**: Write tests BEFORE writing implementation code.

**Benefits**:
- Catches bugs early
- Ensures code is testable
- Documents expected behavior
- Improves code design
- Provides confidence in refactoring

### TDD Cycle

```
┌─────────────┐
│ RED (Test)  │ → Write failing test
└──────┬──────┘
       │
┌──────▼───────┐
│ GREEN (Code) │ → Write minimal code to pass
└──────┬───────┘
       │
┌──────▼────────┐
│ REFACTOR      │ → Clean up and optimize
└───────────────┘
       │
       └─→ Repeat for next feature
```

### Example TDD Flow

**Feature**: Add email validation

**RED** (Write test first):
```typescript
// test/validation.test.ts
test('should validate email format', () => {
  expect(validateEmail('test@example.com')).toBe(true)
  expect(validateEmail('invalid')).toBe(false)
})
```
**Run test**: ❌ Fails (function doesn't exist)

**GREEN** (Make it pass):
```typescript
// src/validation.ts
export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}
```
**Run test**: ✅ Passes

**REFACTOR** (Optimize):
```typescript
// Extract regex to constant
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateEmail(email: string): boolean {
  return EMAIL_REGEX.test(email)
}
```
**Run test**: ✅ Still passes

---

## Design-First Planning (/plan Phase 2)

### Why Research in /plan?

**Evidence-based decisions before writing code**:
- Understand existing patterns before reinventing
- Learn from others' mistakes (known issues)
- Apply industry best practices
- Make informed security decisions (OWASP Top 10)
- Document reasoning for future reference in design doc

### Parallel AI Integration

**MANDATORY for /plan Phase 2 web research**: Use parallel-web-search (or parallel-deep-research) skill

**Research Queries**:
```
"[your-framework] [feature] best practices 2026"
"[feature] implementation patterns"
"OWASP Top 10 risks for [feature] 2026"
"[Feature] security vulnerabilities common attacks"
"Secure [feature] implementation checklist"
```

**Document in design doc** (`docs/plans/YYYY-MM-DD-<slug>-design.md`):
- Source URLs
- Key insights
- Applicability to project
- Decision impact
- Evidence for choices

---

## Security-First Development

### OWASP Top 10 Analysis

**MANDATORY for every feature**: Analyze against OWASP Top 10 2021

**The List**:
1. A01: Broken Access Control
2. A02: Cryptographic Failures
3. A03: Injection
4. A04: Insecure Design
5. A05: Security Misconfiguration
6. A06: Vulnerable Components
7. A07: Identification and Authentication Failures
8. A08: Software and Data Integrity Failures
9. A09: Security Logging and Monitoring Failures
10. A10: Server-Side Request Forgery (SSRF)

**For Each Risk**:
- Risk level: High/Medium/Low
- Applicability: Yes/No
- Mitigation strategy
- Test scenarios
- Evidence from research

**Security Tests** (TDD):
```typescript
// test/security/access-control.test.ts
test('should prevent unauthorized access to other team data', async () => {
  const user = await createTestUser({ teamId: 'team-1' })
  const response = await api.get('/data?team_id=team-2')
    .set('Authorization', `Bearer ${user.token}`)

  expect(response.status).toBe(403)
  expect(response.body.data).toBeUndefined()
})
```

---

## Cross-Agent Collaboration

### Beads for Persistence

**Why Beads**:
- Git-backed (survives agent switches)
- Cross-agent visibility
- Status tracking
- Dependency management

**Workflow**:
```bash
# Agent 1 (Claude Code)
bd create "Add notifications"
bd update bd-x7y2 --status in_progress --comment "API done, UI pending"
bd sync && git push

# Agent 2 (Cursor)
git pull && bd sync
bd show bd-x7y2  # See status: "API done, UI pending"
# Continue UI work
bd update bd-x7y2 --status done
bd sync && git push
```

---

## Recovery: Rollback

If something goes wrong, use rollback to safely revert changes:

```bash
bunx forge rollback
```

**Rollback methods**:

- **Last commit**: Quick undo of most recent change
- **Specific commit**: Target any commit by hash
- **Merged PR**: Revert an entire PR merge
- **Specific files**: Restore only certain files
- **Branch range**: Revert multiple commits
- **Dry run**: Preview changes without executing

All USER sections and custom commands are preserved during rollback.

See [.claude/commands/rollback.md](../.claude/commands/rollback.md) for complete documentation.

---

## Git Workflow Integration

This project uses **Lefthook** for automated quality gates at commit and push time.

### Pre-Commit Checks (Automatic)

**TDD Enforcement**:
- Verifies source files have corresponding test files
- Interactive prompts: Option to unstage, continue, or abort
- Supports multiple languages: JS, TS, JSX, TSX, Python, Go, Java, Ruby

**Bypass** (emergencies only):
```bash
git commit --no-verify
```

### Pre-Push Checks (Automatic)

**Three-layer protection**:

1. **Branch Protection**: Blocks direct push to main/master
   ```
   ✅ Feature branches: allowed
   ❌ main/master: blocked
   ```

2. **ESLint Check**: Strict mode (zero errors, zero warnings)
   ```bash
   bunx eslint .  # Must pass before push
   ```

3. **Test Suite**: All tests must pass
   ```bash
   bun test  # Auto-detects package manager
   ```

**Bypass** (emergencies only):
```bash
LEFTHOOK=0 git push
```

### Pull Request Workflow

**Feature branch naming**:
```bash
feat/feature-name    # New feature
fix/bug-name         # Bug fix
docs/doc-name        # Documentation
refactor/name        # Code refactoring
test/test-name       # Test additions
chore/name           # Maintenance
```

**PR checklist** (auto-filled from template):
- Summary & detailed changes
- Type of change (feat/fix/docs/refactor/test/chore)
- Forge workflow stage (research/dev/check/verify)
- Testing plan (manual/e2e/unit)
- **Self-review checklist** (catches 80% of bugs!)
- **Beads integration**: `Closes beads-xxx`
- Screenshots (if UI changes)
- Merge criteria verification

**Merge strategy** (squash-only):
- GitHub configured for squash merging only
- One clean commit per PR
- Linear git history
- Branches auto-delete after merge

### Git + Beads Workflow

**Complete cycle**:
```bash
# 1. Create Beads issue
bd create "Add feature X"  # Returns: beads-abc123

# 2. Create feature branch
git checkout -b feat/feature-x

# 3. Develop with TDD
# (Pre-commit hook checks tests exist)
git commit -m "test: add feature tests"
git commit -m "feat: implement feature"
git commit -m "refactor: optimize logic"

# 4. Push to remote
# (Pre-push checks: branch protection ✅, ESLint ✅, tests ✅)
git push -u origin feat/feature-x

# 5. Create PR with Beads reference
gh pr create --title "feat: add feature X" --body "Closes beads-abc123"

# 6. After merge
bd close beads-abc123  # Automatic if PR body has "Closes beads-xxx"
bd sync                # Sync to git remote
git checkout main
git pull               # Get merged changes
```

### Emergency Bypasses

**When to use**:
- Production outage
- Critical security patch
- Data loss prevention
- CI/CD system down

**How to bypass**:
```bash
# Skip pre-commit (TDD check)
git commit --no-verify

# Skip pre-push (branch protection + ESLint + tests)
LEFTHOOK=0 git push
```

**⚠️ IMPORTANT**: Always document bypass reason in PR description!

### Quality Gate Results

After implementing this workflow:

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Bugs in production | <2/month | Issue tracker |
| ESLint issues shipped | 0 | `bunx eslint .` |
| Test coverage regressions | 0 | `bun test` |
| Emergency bypasses | <1/month | Git log |
| Time to merge | <30 min | GitHub PR metrics |

---

## Tips & Best Practices

1. **Always TDD**: Write tests BEFORE implementation
2. **Research in /plan Phase 2**: Use parallel-web-search / parallel-deep-research before implementing
3. **Security first**: OWASP Top 10 analysis mandatory
4. **Document decisions**: Evidence and reasoning in research docs
5. **Update Beads regularly**: Keep status current for handoffs
6. **Commit frequently**: After each TDD cycle
7. **Address ALL PR feedback**: GitHub Actions, Greptile, SonarCloud
8. **Update docs progressively**: Don't wait until the end
9. **Verify at the end**: Final documentation check catches gaps
10. **Sync often**: `bd sync` at end of every session
