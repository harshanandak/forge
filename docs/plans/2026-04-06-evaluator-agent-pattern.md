# Evaluator Agent Pattern for Forge

**Date**: 2026-04-06
**Status**: Research & Proposal
**Author**: Claude Code

## Executive Summary

Forge has a fragmented evaluation system. **Current state**: `/dev` self-grades with a 7-dimension decision gate (risk-based, not quality-based); `/validate` runs mechanical checks (type/lint/test/security); `/review` processes external tool feedback (Greptile, SonarCloud, GitHub Actions). **Gap**: No dedicated evaluator agent with concrete code quality criteria. A separate evaluator would catch issues earlier and provide iterative feedback to improve code generation.

---

## 1. Current Validation/Review Architecture

### `/validate` Command (Workflow Stage 3)
**What it checks** (non-evaluative, mechanical):
- **Type check**: TypeScript strict mode, no `any` types
- **Lint**: Code style violations
- **Code review**: (optional) — not an evaluator
- **Security review**: OWASP Top 10, static analysis
- **Tests**: Unit/integration tests, security test scenarios

**How it fails**: Early exit on first failure. 4-phase debug mode (reproduce → root-cause trace → fix → verify).

**Missing**: No grading criteria for code quality dimensions. No evaluator trace logging.

### `/review` Command (Workflow Stage 4)
**What it does** (processes external reviews):
1. Fetch PR status from GitHub
2. Address GitHub Actions failures
3. Process Greptile inline comments
4. Analyze SonarCloud metrics
5. Check other CI/CD tools
6. Categorize and prioritize ALL issues
7. Address issues systematically
8. Commit fixes and verify checks pass

**Missing**: No evaluator decision — just reactive fixing. `/review` doesn't evaluate whether code meets Forge's quality bar; it processes external tool complaints.

### `/dev` Command (Workflow Stage 2)
**Self-evaluation**: Yes, but only for scope/risk, not quality:
- **Decision gate**: 7-dimension rubric (spec-gap risk, not quality)
  1. Files affected beyond task?
  2. Function signature changes?
  3. Shared module changes?
  4. Data model/schema changes?
  5. User-visible behavior change?
  6. Auth/permissions/data exposure?
  7. Hard to reverse?
  
- **Scoring**: 0–14 points → 0–3 (PROCEED), 4–7 (SPEC-REVIEWER), 8+ (BLOCKED)
- **Purpose**: Routing decisions to prevent scope creep, not code quality

**Missing**: No rigorous self-review of generated code.

---

## 2. Existing Grading Rubrics Found

### `lib/dep-guard/rubric.js` (Dependency Risk Scoring)
**Purpose**: Score dependency health using weighted detectors
- `importCallChain` (weight 3)
- `contractDependencies` (weight 3)
- `behavioralDependencies` (weight 2)

**Outputs**: `PASS` | `WEAK` | `INCONCLUSIVE`

**Key insight**: Forge already has a rubric pattern for automated scoring.

### Command Grader Agent (`.claude/agents/command-grader.md`)
**Purpose**: Grade `/plan` compliance with assertion types
- `standard`: Transcript contains expected content
- `hard-gate`: Agent stops when precondition fails
- `contract`: Output artifact has correct format

**Key insight**: Forge has a grading agent pattern for evaluating agent behavior. This is reusable for code quality.

---

## 3. Gap Analysis: Why Forge Needs an Evaluator Agent

**Problem 1**: No concrete code quality criteria. `/validate` and `/review` fix bugs but never define "good code."

**Problem 2**: Generator without feedback loop. `/dev` generates, then `/validate` + `/review` react to failures.

**Problem 3**: Anthropic's lesson: Models self-evaluate poorly. The fix: **separate agents**, **concrete criteria**, **trace logging**, **iterative refinement**. Forge's `/dev` can talk itself into passing "Step D: Code quality review" without rigorous evaluation.

**Problem 4**: Cross-agent consistency. If Forge adds Codex, Kilo, OpenCode, Cursor, Copilot, how do you ensure consistent quality? An external evaluator is the answer.

---

## 4. Proposed Evaluator Agent Architecture

### Phase 1: Define Code Quality Criteria (5 Dimensions)

**Dimension 1: Correctness (40% weight)**
- Does code implement the spec without bugs?
- Are edge cases handled?
- Do tests cover spec requirements?

**Dimension 2: Maintainability (25% weight)**
- Is code readable and well-commented?
- Are variable/function names clear?
- Is code DRY (no duplication)?

**Dimension 3: Security (20% weight)**
- Are OWASP Top 10 mitigations applied?
- Is user input validated?
- Is sensitive data protected?

**Dimension 4: Test Coverage (10% weight)**
- Unit tests for core logic? (>80%)
- Integration tests for cross-module flows?
- Edge case tests?

**Dimension 5: Performance (5% weight, optional)**
- No obvious N+1 queries?
- No sync I/O in async context?
- Reasonable algorithm complexity?

---

### Phase 2: Evaluator Agent Prompt

**New agent**: `/evaluate`

**Input**:
- Code changes (diff)
- Test output
- Design doc (spec)
- Commit messages

**Scoring logic**:
```
For each dimension, score 0–2:
  0 = major issues
  1 = minor issues / acceptable
  2 = no issues found

Weighted sum / 2.0 = overall score (0–2)
Grade A: 1.8–2.0 | B: 1.6–1.8 | C: 1.4–1.6 | Fail: <1.4
```

**Key**: Require evidence for each score (quote code, point to test). Default to FAIL if evidence unclear.

---

### Phase 3: Evaluator Output & Routing

**Output format** (JSON):
```json
{
  "evaluation": {
    "timestamp": "2026-04-06T14:30:00Z",
    "commit": "abc1234",
    "dimensions": {
      "correctness": {
        "score": 2,
        "weight": 0.40,
        "findings": ["Spec requirement X implemented", "Edge case Y not tested"]
      },
      "maintainability": {
        "score": 1,
        "weight": 0.25,
        "findings": ["Function F too long (45 lines)", "Names generally clear"]
      },
      "security": {
        "score": 2,
        "weight": 0.20,
        "findings": ["OWASP mitigations applied"]
      },
      "testCoverage": {
        "score": 2,
        "weight": 0.10,
        "findings": ["82% coverage"]
      },
      "performance": {
        "score": 1,
        "weight": 0.05,
        "findings": ["Pagination could optimize"]
      }
    },
    "overallScore": 1.85,
    "grade": "A",
    "recommendation": "APPROVE with minor fixes",
    "blockers": [],
    "improvements": ["Extract function F", "Add edge case test"]
  }
}
```

**Routing**:
- Grade **A** (1.8–2.0): APPROVE → `/review`
- Grade **B** (1.6–1.8): APPROVE + improvements documented
- Grade **C** (1.4–1.6): CONDITIONAL — developer response required
- Grade **Fail** (<1.4): REJECT → back to `/dev` with feedback

---

## 5. Integration: Where Does Evaluator Run?

### Recommended: **Hybrid Approach**
1. **After `/dev` completes all tasks**: Run `/evaluate` (light eval, catches obvious issues)
2. **After `/validate` passes**: Run `/evaluate` again (full eval, assumes tests pass)

This mirrors Anthropic's Opus 4.6 approach: quick gate early, full eval at end.

---

## 6. Evaluator Trace Logging & Iterative Improvement

### Trace Capture
Store evaluation output in:
```
docs/evaluations/YYYY-MM-DD-<commit>-eval.json
```

### Iterative Refinement
Process:
1. Run evaluator → capture trace
2. Read traces for patterns (e.g., failing on correctness 60% of time)
3. Update prompt (sharpen criteria, add examples)
4. Re-evaluate previous 10 commits with new prompt
5. Cross-check with manual code review

**Frequency**: Monthly or after every 50 evaluations.

---

## 7. Self-Evaluation vs. External Evaluation

### Current: `/dev` Self-Reviews
- **Step C**: Spec compliance review
- **Step D**: Code quality review

**Problem**: Same agent reviews own code → self-approval bias (Anthropic's finding).

### Proposed: Separate Evaluator
- `/dev` generates code (generator agent)
- `/evaluate` grades code (evaluator agent with different system prompt)

**Evaluator safeguards**:
- Concrete scoring rubric (not vague "is this good?")
- Evidence required for each score (quote code, point to test)
- Strict mode: Default to FAIL if evidence unclear
- Explicit bias warning in system prompt

---

## 8. Cross-Agent Evaluator: Codex, Kilo, OpenCode, Cursor, Copilot

If Forge integrates multiple code-generation agents:

```
Codex → /evaluate (unified grader)
Kilo → /evaluate (unified grader)
OpenCode → /evaluate (unified grader)
↓
All agents held to same standard
```

**Implementation**:
- Evaluator doesn't know which agent generated code
- Same rubric, same scoring, same threshold
- Per-agent trend tracking: "Codex avg 1.7, OpenCode avg 1.5"
- Feedback routed back to originating agent for improvement

---

## 9. Adaptive Evaluation: Skip Light Tasks, Full Eval for Complex

Anthropic found: Evaluator became overhead for tasks within model's reliable capability.

**Simple tasks** (skip full eval, just `/validate`):
- Documentation updates
- Refactoring (low risk)
- Bug fixes in single file
- Dependency upgrades

**Complex tasks** (full eval):
- New features
- Auth/security changes
- Database schema changes
- Performance-sensitive code
- Cross-module refactoring

**Trigger**: Decision gate score feeds into evaluation:
- Score 0–3 (low risk): `/validate` + light eval only
- Score 4–7 (medium risk): `/validate` + full eval
- Score 8+ (blocked anyway): N/A

---

## 10. Concrete Next Steps

### Immediate (Week 1)
1. Create `/evaluate` command definition (`.claude/commands/evaluate.md`)
   - Specify the 5-dimension rubric
   - Define scoring logic and grading thresholds
   - Document input/output format

2. Write evaluator agent prompt (`.claude/agents/code-evaluator.md`)
   - System prompt with rubric
   - Concrete examples for each dimension
   - Bias-avoidance language

3. Design trace logging (`.claude/rules/evaluation-trace-format.md`)
   - JSON schema for evaluation output
   - Storage location
   - Trend analysis queries

### Short-term (Week 2–3)
4. Integrate evaluator into `/validate`
   - Add as optional `--eval` flag first
   - Run post-tests, pre-exit
   - Route to `/review` on REJECT

5. Test on 5 recent PRs
   - Compare evaluator grades to actual code quality
   - Calibrate rubric based on results
   - Document bias patterns

### Medium-term (Week 4+)
6. Evaluate `/dev` generator feedback
   - If evaluator catches issues earlier, improve `/dev` prompt
   - Log traces for monthly review

7. Multi-agent integration
   - Make evaluator agnostic to source
   - Set up per-agent trend dashboard

---

## Appendix: Scoring Example

**Task**: Add user authentication endpoint

**Code**: 
- ✓ Implements spec (JWT, refresh tokens)
- ✓ 92% test coverage, edge cases tested
- ⚠ Function `validatePassword` is 38 lines
- ✓ Input validation, OWASP mitigations applied
- ⚠ O(n) password lookup, not optimized

**Evaluator scoring**:
```json
{
  "correctness": { "score": 2, "findings": ["Spec implemented, edge cases tested"] },
  "maintainability": { "score": 1, "findings": ["validatePassword needs extraction"] },
  "security": { "score": 2, "findings": ["Input validation, OWASP mitigations applied"] },
  "testCoverage": { "score": 2, "findings": ["92% coverage, edge cases tested"] },
  "performance": { "score": 1, "findings": ["O(n) lookup acceptable for now"] },
  "overallScore": 1.83,
  "grade": "A",
  "recommendation": "APPROVE — refactor validatePassword as follow-up"
}
```

---

**Document created**: 2026-04-06  
**Ready for**: Design review, architectural decision
