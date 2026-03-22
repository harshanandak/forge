
> **Note:** Three things share the "validate" name in Forge:
> - `/validate` (this command): Workflow Stage 3 — rebases onto the base branch, then runs type/lint/test/security checks
> - `forge-preflight` (formerly forge-validate): CLI tool — checks prerequisites before a stage
> - `bun run check` (scripts/validate.sh): Local quality gate — runs type/lint/test/security checks only (does NOT rebase; assumes branch is already current with the base branch)

Run comprehensive validation including type checking, linting, code review, security review, and tests.

# Validate

This command validates all code before creating a pull request.

## Usage

```bash
/validate
```

Or use the validation script (checks only — no rebase):

```bash
bun run check    # Runs lint/test/security checks only. Does NOT rebase onto the base branch.
                 # Use /validate for the full workflow (rebase + checks).
```

```
<HARD-GATE: /validate entry — rebase onto latest base branch>
Before running ANY validation checks:

0. Resolve the base branch dynamically (do NOT hardcode master or main):
   BASE=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}')
   if [ -z "$BASE" ] || [ "$BASE" = "(unknown)" ]; then BASE="master"; fi

   This handles repos using main, master, or any other default branch.
   Falls back to "master" when HEAD is unresolved (detached remote, empty repo).

1. Fetch latest base branch:
   git fetch origin "$BASE" || { echo "✗ Fetch failed — cannot verify branch freshness"; exit 1; }

   The `|| { ...; exit 1; }` guard ensures fetch failures are never silently skipped.

2. Check if branch is behind:
   BEHIND=$(git rev-list --count HEAD..origin/"$BASE")

3. If BEHIND > 0:
   a. Run: git rebase origin/"$BASE" || REBASE_FAILED=1
   b. If rebase succeeds (REBASE_FAILED unset): print "✓ Rebased onto latest $BASE ($BEHIND commits integrated)"
   c. If rebase fails (REBASE_FAILED=1 — conflicts or any other error):
      - Run: git rebase --abort
      - Print conflicting files from the failed rebase output
      - Print: "✗ Rebase conflict — resolve manually, then re-run /validate"
      - STOP. Do NOT proceed to any validation checks.

4. If BEHIND = 0:
   Print "✓ Branch is up-to-date with $BASE" and continue.

Rationale: Without this step, validation checks run against stale code that doesn't
include recent base branch changes. Integration issues are only caught after the PR is
created, wasting CI cycles and review time. Rebasing here ensures /validate results
reflect the true state of what will be merged.
</HARD-GATE>
```

## What This Command Does

**Quick Start**: Run `bun run check` to execute the full validation pipeline (implemented in `scripts/validate.sh`). The npm script is named `check`; the workflow command is `/validate`. See individual steps below for details.

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
npm audit    # or: bun audit, snyk test, etc.
```

**Manual Review**:
- Review security test scenarios (from design doc — `## Technical Research` section)
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
> - Are all security test scenarios from your design doc actually implemented and passing?
> - Did you verify OWASP Top 10 mitigations, not just check a box?
> - Are there edge cases or integration scenarios you haven't tested?
>
> **If unsure**: Re-read the `## Technical Research` section in `docs/plans/YYYY-MM-DD-<slug>-design.md`

## On Validation Failure: 4-Phase Debug Mode

> **Iron Law: NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST**
>
> Every fix attempt without a diagnosed root cause wastes time and masks the real problem.

### Phase D1: Reproduce

Confirm the failure is deterministic. Capture the exact error.

- Run the failing command fresh — do not rely on cached output
- Record: exact command, exact error message, exact line number
- If intermittent: run 3 times, document frequency

### Phase D2: Root-Cause Trace

Trace to the source, not the symptom. **Fix at source, not at symptom.**

- Read the stack trace — where does it originate?
- Is it a test bug, an implementation bug, or a config bug?
- What changed recently that could have caused this?
- Read the actual failing line and surrounding context

### Phase D3: Fix

ONE minimal fix. ONE change at a time.

1. Write the failing test FIRST (if not already a test failure)
2. Make the smallest possible change to fix the root cause
3. Do not fix multiple things in one commit
4. Do not "also improve" unrelated code while fixing

### Phase D4: Verify

Re-run full validation from the beginning.

- Do not declare fixed until you have run the full validate suite
- Show fresh output — not "it should be fine now"
- All checks must pass, not just the one that was failing

<HARD-GATE: 3+ fix attempts>
STOP. Question architecture before Fix #4.

If you have attempted 3+ fixes without resolution:
1. Step back — is the approach fundamentally wrong?
2. Read the original spec/design doc
3. Ask: "Am I fixing symptoms or the real problem?"
4. Consider: revert all changes and start fresh with better understanding

"Quick fix for now" is not a valid fix strategy.
</HARD-GATE>

### Red Flags — STOP if you hear yourself saying:

- "Quick fix for now"
- "It's probably X"
- "I don't fully understand but this might work"
- "Should be fixed now"
- "It was passing earlier"
- "I'm confident this is right"

**None of these are evidence. Run the command. Show the output.**

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
<HARD-GATE: /validate exit>
Do NOT output any variation of "check complete", "ready to ship", or proceed to /ship
until ALL FOUR show fresh output in this session:

1. Type check: [command run] → [actual output] → exit 0 confirmed
2. Lint: [command run] → [actual output] → 0 errors, 0 warnings confirmed
3. Tests: [command run] → [actual output] → N/N passing confirmed
4. Security scan: [command run] → [actual output] → no critical issues confirmed

"Should pass", "was passing earlier", and "I'm confident" are not evidence.
Run the commands. Show the output. THEN declare done.

5. Stage transition: Run `bash scripts/beads-context.sh stage-transition <id> validate ship` → exit 0 confirmed
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

Fix issues then re-run /validate
```

## Integration with Workflow

```
Utility: /status     → Understand current context before starting
Stage 1: /plan       → Design intent → research → branch + worktree + task list
Stage 2: /dev        → Implement each task with subagent-driven TDD
Stage 3: /validate      → Type check, lint, tests, security — all fresh output (you are here)
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
