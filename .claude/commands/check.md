---
description: Complete validation (type/lint/tests/security)
---

Run comprehensive validation including type checking, linting, code review, security review, and tests.

# Check

This command validates all code before creating a pull request.

## Usage

```bash
/check
```

Or use the unified validation script:

```bash
bun run check    # Runs all checks automatically
```

## What This Command Does

**Quick Start**: The unified `bun run check` command (implemented in `scripts/check.sh`) automatically runs all validation steps in sequence. See individual steps below for details.

### Step 1: Type Check
```bash
# Run your project's type check command
bun run typecheck    # or: npm run typecheck, tsc, etc.
```
- Verify all TypeScript types are valid
- No `any` types allowed
- Strict mode enforcement

### Step 2: Lint
```bash
# Run your project's lint command
bun run lint    # or: npm run lint, eslint ., etc.
```
- Linting rules
- Code style consistency
- Best practices compliance

### Step 3: Code Review (if available)
```bash
/code-review:code-review
```
- Static code analysis
- Code quality check
- Potential issues flagged

### Step 4: Security Review

**OWASP Top 10 Checklist**:
- A01: Broken Access Control
- A02: Cryptographic Failures
- A03: Injection
- A04: Insecure Design
- A05: Security Misconfiguration
- A06: Vulnerable Components
- A07: Authentication Failures
- A08: Data Integrity Failures
- A09: Logging & Monitoring Failures
- A10: Server-Side Request Forgery

**Automated Security Scan**:
```bash
# Run your project's security scan
bunx npm audit    # or: npm audit, snyk test, etc.
```

**Manual Review**:
- Review security test scenarios (from research doc)
- Verify security mitigations implemented
- Check for sensitive data exposure

### Step 5: Tests
```bash
# Run your project's test command
bun test    # or: npm run test, jest, vitest, etc.
```
- All tests passing
- Includes security test scenarios
- TDD tests from /dev phase

> **💭 Plan-Act-Reflect Checkpoint**
> Before declaring validation complete:
> - Are all security test scenarios from your research doc actually implemented and passing?
> - Did you verify OWASP Top 10 mitigations, not just check a box?
> - Are there edge cases or integration scenarios you haven't tested?
>
> **If unsure**: Re-read the "Security Analysis" and "TDD Test Scenarios" sections in research doc

### Step 6: Handle Failures

If any check fails:
```bash
# Create Beads issue for problems
bd create "Fix <issue-description>"

# Mark current issue as blocked
bd update <current-id> --status blocked --comment "Blocked by <new-issue-id>"

# Output what needs fixing
```

If all pass:

```
<HARD-GATE: /check exit>
Do NOT output any variation of "check complete", "ready to ship", or proceed to /ship
until ALL FOUR show fresh output in this session:

1. Type check: [command run] → [actual output] → exit 0 confirmed
2. Lint: [command run] → [actual output] → 0 errors, 0 warnings confirmed
3. Tests: [command run] → [actual output] → N/N passing confirmed
4. Security scan: [command run] → [actual output] → no critical issues confirmed

"Should pass", "was passing earlier", and "I'm confident" are not evidence.
Run the commands. Show the output. THEN declare done.
</HARD-GATE>
```

## Example Output (Success)

```
✓ Type check: Passed
✓ Lint: Passed
✓ Code review: No issues
✓ Security Review:
  - OWASP Top 10: All mitigations verified
  - Automated scan: No vulnerabilities
  - Manual review: Security tests passing
✓ Tests: 15/15 passing (TDD complete)

Ready for /ship
```

## Example Output (Failure)

```
✗ Tests: 2/15 failing
  - validation.test.ts: Assertion failed
  - auth.test.ts: Timeout exceeded

✓ Beads issue created: bd-k8m3 "Fix validation test"
✓ Current issue marked: Blocked by bd-k8m3

Fix issues then re-run /check
```

## Integration with Workflow

```
Utility: /status     → Understand current context before starting
Stage 1: /plan       → Design intent → research → branch + worktree + task list
Stage 2: /dev        → Implement each task with subagent-driven TDD
Stage 3: /check      → Type check, lint, tests, security — all fresh output (you are here)
Stage 4: /ship       → Push + create PR
Stage 5: /review     → Address GitHub Actions, Greptile, SonarCloud
Stage 6: /premerge   → Update docs, hand off PR to user
Stage 7: /verify     → Post-merge CI check on main
```

## Tips

- **All checks must pass**: Don't proceed to /ship with failures
- **Security is mandatory**: OWASP Top 10 review required for all features
- **Create issues for failures**: Track problems in Beads
- **TDD helps**: Tests should already pass from /dev phase
- **Fix before shipping**: Resolve all issues before creating PR
