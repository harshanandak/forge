## Problem
<!-- What was broken, what need existed, or what user pain this addresses -->

## Root Cause
<!-- Why it happened, why it was missing, or what gap existed -->

## Fix
<!-- What this PR does to solve it — approach, not implementation details -->

## Value
<!-- Who benefits, what improves, what risk is removed -->

## Beads
<!-- Link Beads issues this PR addresses — required for auto-close in /verify -->
Closes beads-xxx

<details>
<summary>Implementation Details</summary>

### Test Coverage
- Tests: <!-- count --> passing
- Scenarios covered: <!-- list key scenarios -->

### Security Review
- OWASP Top 10: <!-- summary — applicable risks and mitigations -->
- Automated scan: <!-- result -->

### Design Doc
<!-- See: docs/plans/YYYY-MM-DD-<slug>-design.md -->

### Key Decisions
<!-- From design doc — 3-5 key decisions with reasoning -->

### Documentation Updated
<!-- List docs updated in this PR, or "None — no doc-facing changes" -->

### Validation
- [ ] Type check passing
- [ ] Lint passing (0 errors, 0 warnings)
- [ ] All tests passing
- [ ] Security review completed

</details>

---

### Self-Review Checklist

<!-- CRITICAL — Review your own PR before requesting review. This catches 80% of bugs. -->

- [ ] I reviewed the full diff on GitHub
- [ ] No debug code (console.log, commented code, temporary changes)
- [ ] ESLint passes with zero warnings (`bunx eslint .`)
- [ ] All tests pass locally (`bun test`)
- [ ] No hardcoded secrets or API keys
- [ ] No breaking changes (or documented in migration guide)
- [ ] TDD compliance: All source files have corresponding tests
