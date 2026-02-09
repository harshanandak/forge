# Branch Protection Configuration Guide

**Repository**: harshanandak/forge
**Last Updated**: 2026-02-09

---

## Overview

This guide helps you configure GitHub branch protection rules to enforce code quality and review standards.

## Required Configuration

### 1. Navigate to Branch Protection

**URL**: `https://github.com/harshanandak/forge/settings/branches`

### 2. Add Rule for `main` Branch

Click **"Add rule"** and configure:

---

### 📋 Branch Protection Settings Checklist

#### **Protect matching branches**

Branch name pattern: `main`

#### **Pull Request Requirements**

```
✅ Require a pull request before merging
   Number of approvals: 1 (recommended)

   ✅ Dismiss stale pull request approvals when new commits are pushed
   ✅ Require review from Code Owners (if .github/CODEOWNERS exists)
   ✅ Require approval of the most recent reviewable push
   ✅ Require conversation resolution before merging
      └─ All comment threads must be resolved before merge
```

#### **Status Check Requirements**

```
✅ Require status checks to pass before merging
   ✅ Require branches to be up to date before merging

   Required status checks (select these):
   - test (Node.js test suite)
   - eslint (Code quality scan)
   - CodeQL (Security analysis)
   - dependency-review (Supply chain security)
   - greptile-review (Greptile Quality Gate - min score 4.0)
```

#### **History Requirements**

```
✅ Require linear history
   └─ Enforces squash or rebase (no merge commits)
   └─ Works with repository "squash only" setting
```

#### **Force Push & Deletion**

```
✅ Do not allow bypassing the above settings
   └─ Applies to administrators too (strict enforcement)

❌ Allow force pushes (keep disabled for safety)
   └─ Prevents history rewriting

❌ Allow deletions (keep disabled for safety)
   └─ Prevents accidental branch deletion
```

---

## What Each Setting Does

### 1. Require Conversation Resolution

**Impact**: PR cannot be merged until all comment threads are resolved.

**Workflow**:
```
1. Reviewer leaves comment: "This function should handle null values"
2. Author responds and fixes code
3. Reviewer (or author) clicks "Resolve conversation"
4. Repeat for all threads
5. Merge button enabled ✅
```

**Benefits**:
- Ensures all feedback is addressed
- Prevents accidentally ignoring comments
- Creates clear audit trail

### 2. Require Status Checks

**Impact**: PR cannot be merged if CI/CD checks fail.

**Checks**:
- ✅ Tests passing
- ✅ ESLint passing
- ✅ CodeQL security scan
- ✅ Dependency vulnerabilities checked
- ✅ Greptile score ≥ 4.0 (Code quality gate)

**Benefits**:
- Broken code cannot reach main
- Security issues caught early
- Quality gates enforced
- AI-powered code review catches subtle issues

### 3. Require Linear History

**Impact**: Only squash or rebase merging allowed (no merge commits).

**Result**:
```bash
# Clean git log:
817d96f - feat: add user authentication (#42)
c4a5b2e - fix: resolve login timeout (#41)
a3d1f7g - docs: update API reference (#40)

# Not this messy log:
817d96f - Merge pull request #42 from feat/auth
c4a5b2e - WIP: debugging
a3d1f7g - fix typo
b2c3d4e - Merge branch 'main' into feat/auth
```

**Benefits**:
- Easy to understand history
- Easy to revert features
- Bisect works cleanly

### 4. Require Approvals

**Impact**: At least 1 reviewer must approve before merge.

**Options**:
- 1 approval: Small teams, fast iteration
- 2+ approvals: Critical code, large teams

**Benefits**:
- Code review is mandatory
- Knowledge sharing
- Bug prevention

---

## Verification

After configuring, verify with:

```bash
# Check branch protection status
gh api repos/harshanandak/forge/branches/main/protection --jq '{
  required_pull_request_reviews,
  required_status_checks,
  required_conversation_resolution,
  required_linear_history,
  enforce_admins
}'
```

Expected output:
```json
{
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": false
  },
  "required_status_checks": {
    "strict": true,
    "contexts": ["test", "eslint", "CodeQL", "greptile-review"]
  },
  "required_conversation_resolution": {
    "enabled": true
  },
  "required_linear_history": {
    "enabled": true
  },
  "enforce_admins": {
    "enabled": true
  }
}
```

---

## Common Scenarios

### Scenario 1: Unresolved Comments

**Problem**: You try to merge but button is disabled.

**Solution**:
```
1. Go to "Files changed" tab
2. Find threads with "Unresolved" label
3. Address feedback
4. Click "Resolve conversation" on each thread
5. Merge button enabled ✅
```

### Scenario 2: Failing Status Checks

**Problem**: CI checks are red.

**Solution**:
```bash
# Fix locally
git add .
git commit -m "fix: address CI failures"
git push

# Wait for checks to pass
# Then merge
```

### Scenario 3: Out of Date Branch

**Problem**: "Branch is out of date with base branch"

**Solution**:
```bash
# Update your branch
git checkout main
git pull
git checkout your-branch
git merge main  # or: git rebase main

# Resolve conflicts if any
git push
```

### Scenario 4: Greptile Score Below 4.0

**Problem**: "Greptile Quality Gate failed - Score: 3.2"

**Solution**:
```bash
# 1. Read the Greptile feedback in PR comments
# 2. Address the specific issues mentioned
# 3. Common fixes:
#    - Simplify complex functions
#    - Add error handling
#    - Remove code duplication
#    - Fix security issues
#    - Add missing tests

# 4. Commit improvements
git add .
git commit -m "refactor: address Greptile feedback - simplify logic, add error handling"
git push

# 5. Wait for Greptile to re-analyze
# 6. Score should improve to ≥ 4.0
```

---

## Emergency Override

**When to use**: Production outage, critical security patch

**How**:
1. Navigate to: `https://github.com/harshanandak/forge/settings/branches`
2. Click "Edit" on branch protection rule
3. Temporarily uncheck "Do not allow bypassing"
4. Merge critical fix
5. **IMMEDIATELY re-enable protection**

**Document in PR**: "Emergency merge due to [reason]"

---

## Greptile Quality Gate (Score ≥ 4.0)

### What is Greptile?

Greptile provides AI-powered code review with two components:

**1. Greptile Review (GitHub App)**
- Analyzes code complexity and maintainability
- Identifies best practice violations
- Detects potential bugs and edge cases
- Finds security vulnerabilities
- Reports code duplication and patterns
- **Posts confidence score** in PR description

**2. Greptile Quality Gate (Custom Workflow)**
- Extracts confidence score from Greptile Review
- Enforces minimum threshold of 4.0/5
- Blocks merge if score is below threshold

### How It Works

1. **Greptile Review runs**: Analyzes PR and posts confidence score in description
2. **Quality Gate workflow triggers**: Extracts score from PR body
3. **Score validation**: If score < 4.0, workflow fails and blocks merge
4. **Merge allowed**: Only when score ≥ 4.0 and all other checks pass

### Score Interpretation

| Score | Quality | Action Required |
|-------|---------|-----------------|
| 4.5-5.0 | Excellent | ✅ Merge approved |
| 4.0-4.4 | Good | ✅ Merge approved |
| 3.0-3.9 | Needs work | ❌ Address feedback |
| 2.0-2.9 | Poor | ❌ Major refactoring needed |
| 0-1.9 | Critical issues | ❌ Do not merge |

### Improving Your Score

**Common issues that lower scores:**
- Overly complex functions (high cyclomatic complexity)
- Missing error handling
- Hardcoded values and magic numbers
- Poor naming conventions
- Duplicated code
- Security vulnerabilities
- Missing tests for critical paths

**Quick wins to boost score:**
```bash
# 1. Break down large functions
# Before: 200-line function
# After: 5-10 smaller, focused functions

# 2. Add error handling
try {
  await riskyOperation();
} catch (error) {
  logger.error('Operation failed', { error });
  throw new AppError('User-friendly message');
}

# 3. Extract constants
// Before: if (user.age > 18)
// After: const LEGAL_AGE = 18; if (user.age > LEGAL_AGE)

# 4. Remove duplication
// Extract shared logic into reusable functions
```

### Bypassing (Emergency Only)

If you **must** merge with score < 4.0:

1. Get approval from tech lead/architect
2. Document reason in PR:
   ```
   **Emergency Bypass**: Production hotfix for [critical-issue]
   **Greptile Score**: 3.2
   **Justification**: [explanation]
   **Follow-up Issue**: #123 (created to address quality issues)
   ```
3. Temporarily disable branch protection (admin only)
4. Create follow-up issue to fix quality issues
5. **Re-enable protection immediately after merge**

### Configuration

**Required Secret**: `GREPTILE_API_KEY`

Add to repository secrets:
```
Settings → Secrets and variables → Actions → New repository secret
Name: GREPTILE_API_KEY
Value: [your-greptile-api-key]
```

Get API key at: https://app.greptile.com/settings/api

---

## Integration with Lefthook

Branch protection works with Lefthook hooks:

| Layer | Check | Enforced By |
|-------|-------|-------------|
| Local | TDD, ESLint, Tests | Lefthook pre-push |
| CI/CD | Tests, ESLint, Security, Greptile | GitHub Actions |
| Merge | Reviews, Comments, History, Score ≥ 4.0 | Branch Protection |

**Result**: Triple-layer quality enforcement with AI-powered review

---

## Best Practices

1. **Start Lenient, Get Stricter**:
   - Week 1: Require PR only
   - Week 2: Add conversation resolution
   - Week 3: Add required status checks
   - Week 4: Require approvals

2. **Team Size Matters**:
   - Solo/2 people: 1 approval, lenient
   - 3-5 people: 1 approval, strict
   - 6+ people: 2 approvals, very strict

3. **Review Comments**:
   - Use "Request changes" for blocking issues
   - Use "Comment" for suggestions
   - Use "Approve" when satisfied

4. **Status Checks**:
   - Only require checks that are reliable
   - Flaky tests = disabled requirement
   - Essential checks = required

---

## Troubleshooting

### "Cannot enable conversation resolution"

**Cause**: No branch protection rule exists yet.

**Fix**: First enable "Require pull request before merging", then enable conversation resolution.

### "Status checks not appearing"

**Cause**: GitHub Actions haven't run on this branch yet.

**Fix**: Push a commit to trigger workflows, then select checks.

### "Can't merge even though everything is resolved"

**Cause**: Cache/sync issue.

**Fix**: Refresh page, check all threads are resolved, verify status checks passed.

---

## Additional Resources

- [GitHub Branch Protection Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [Managing Code Review Settings](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews)
- [Status Check Requirements](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks)
