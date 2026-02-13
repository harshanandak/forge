# Manual Review Guide

**Purpose**: Structured guidance for manual code review integrated with AI review tools.

**Audience**: Developers conducting PR reviews, maintainers configuring review workflows.

---

## Overview

Manual review remains essential even with AI-powered tools like Greptile and CodeRabbit. This guide provides a systematic approach to combine human judgment with AI insights for comprehensive code quality.

**Review Philosophy**:
- **AI First, Human Final**: Use AI tools for breadth, manual review for depth
- **Structured Process**: Follow systematic checklist to avoid missing critical issues
- **Context Matters**: Apply judgment based on project stage, risk, and complexity
- **Documentation Required**: Every PR needs clear explanation of changes and reasoning

---

## Review Workflow Integration

This guide integrates with the Forge 9-Stage TDD Workflow:

```
/status → /research → /plan → /dev → /check → /ship → /review → /merge → /verify
                                                           ↑
                                                  You are here
```

### When to Use This Guide

- **Stage 7 (/review)**: Address ALL PR feedback from GitHub Actions, Greptile, SonarCloud, and manual reviewers
- **After AI Review**: When Greptile or CodeRabbit has completed initial analysis
- **Before Merge**: Final verification before approving PR
- **Post-Merge**: Documentation verification in /verify stage



## Part 1: AI Review Tools Best Practices

### Greptile - Semantic Understanding
- Use .claude/scripts/greptile-resolve.sh for systematic thread handling
- Always reply and resolve threads after fixes
- See .claude/rules/greptile-review-process.md for detailed workflow

### CodeRabbit - Multi-Model Review
- Address security issues immediately
- Consider performance suggestions with benchmarks
- Apply style suggestions for consistency

### SonarCloud - Static Analysis
- Coverage ≥80% on new code
- 0 security hotspots unreviewed
- Use /sonarcloud skill for PR-specific issues

---

## Part 2: Manual Review Checklist

### 1. Functional Correctness
- ☐ Code matches PR description
- ☐ Edge cases handled
- ☐ Error messages clear
- ☐ Invalid input handled gracefully

### 2. Security (OWASP Top 10)
- ☐ Authorization before sensitive ops
- ☐ Data encrypted at rest/transit
- ☐ SQL queries parameterized
- ☐ No code injection risks

### 3. Testing Quality
- ☐ Tests for new code
- ☐ Edge cases covered
- ☐ TDD compliance (test commits before feat commits)

### 4. Code Quality
- ☐ Self-documenting code
- ☐ Single responsibility functions
- ☐ No duplication (DRY)
- ☐ Clear organization

### 5. Performance
- ☐ Efficient algorithms
- ☐ Optimized queries
- ☐ No memory leaks

### 6. Documentation
- ☐ Public APIs documented
- ☐ PR explains why, not just what
- ☐ README updated if needed

---

## Summary

**Manual Review Essentials**:
- Use AI tools for pattern detection
- Apply human judgment for context
- Follow systematic checklist
- Verify security, testing, documentation

**Integration**: Stage 7 (/review) → Address ALL feedback systematically

**Key**: Trust AI for breadth, humans for depth. Best results combine both.
