# Greptile Code Review - Branch Protection Setup

**✅ Greptile is already working on your repository!**

Greptile provides AI-powered code review as a **GitHub App** that automatically analyzes every PR.

---

## Current Status

🎉 **Greptile is Fully Operational!**

Your repository has both Greptile features working:
- ✅ **Greptile Review** (GitHub App) - Provides detailed code review comments
- ✅ **Greptile Quality Gate** (Workflow) - Enforces minimum score of 4.0/5 before merge
- ✅ Both integrated into branch protection for master branch

---

## Branch Protection Status

### ✅ Fully Configured!

Branch protection for `master` now requires:

1. **Greptile Review** (GitHub App check) - Must pass
2. **Greptile Quality Gate (≥4/5)** (Custom workflow) - Must pass with score ≥ 4.0
3. **Other Required Checks**: ESLint, CodeQL, dependency-review
4. **PR Reviews**: At least 1 approving review required
5. **Conversation Resolution**: All review threads must be resolved

**Result**: PRs cannot be merged unless:
- Greptile Review completes successfully
- Greptile confidence score is at least 4.0/5
- All other quality checks pass
- Code has been reviewed and approved

---

## How Greptile Works

### GitHub App Integration

- **Automatic**: Runs on every PR (no manual trigger needed)
- **No Workflow Needed**: Works as a GitHub App, not a GitHub Action
- **No API Key Required**: Authorized through GitHub App installation

### Review Process

```
PR created/updated
    ↓
Greptile automatically analyzes code
    ↓
Posts detailed feedback as comments
    ↓
Updates "Greptile Review" check status
    ↓
Pass: ✅ Can merge
Fail: ❌ Blocked (if required in branch protection)
```

### What Greptile Checks

- 🐛 **Bugs & Edge Cases**: Potential runtime errors, null pointers, race conditions
- 🔒 **Security**: Vulnerabilities, injection risks, auth issues
- 📊 **Code Quality**: Complexity, duplication, naming conventions
- ⚡ **Performance**: Inefficient algorithms, memory leaks
- 📝 **Best Practices**: Error handling, type safety, modern patterns
- 🧪 **Testing**: Missing test coverage, test quality

---

## Understanding Greptile Feedback

### Confidence Score

Greptile provides a confidence score (0-5) in the PR description that reflects overall code quality:

📊 **Confidence Score Format**: "Confidence Score: X/5" or "Confidence Score: X out of 5"
🎯 **Quality Gate Threshold**: Minimum 4.0/5 required to merge
✅ **Detailed inline comments** on specific lines of code
✅ **Issue severity** indicators (critical, major, minor)
✅ **Actionable suggestions** with example fixes

### Example from Your PR #13

Greptile identified and you fixed:
- ✅ Windows path validation bug
- ✅ Duplicate function definitions
- ✅ Incorrect fetch timeout implementation
- ✅ Security vulnerabilities (command injection)
- ✅ JSON parse crash issues
- ✅ Unused variables

**Result**: 16/16 issues addressed! 🎉

---

## Addressing Greptile Feedback

### Workflow

1. **Read Comments**
   - Greptile posts inline comments on changed files
   - Each explains the issue and suggests fixes

2. **Fix Issues**
   ```bash
   # Make changes based on feedback
   git add .
   git commit -m "fix: address Greptile feedback"
   git push
   ```

3. **Auto Re-analysis**
   - Greptile automatically reviews again after push
   - Verifies fixes
   - Updates check status

4. **Resolve Conversations**
   - Click "Resolve conversation" on each fixed comment
   - Helps track progress

---

## Branch Protection Behavior

### When "Greptile Review" is Required:

```
✅ All issues addressed          → Check: SUCCESS → ✅ Can merge
❌ Outstanding issues            → Check: PENDING → ❌ Blocked
🔄 Analysis in progress          → Check: PENDING → ❌ Blocked
```

### Emergency Override

If you **must** merge despite Greptile feedback:

1. **Get approval** from tech lead/architect
2. **Document in PR description**:
   ```markdown
   **Emergency Bypass**: Production hotfix for [critical-issue]
   **Greptile Status**: Bypassed
   **Justification**: [detailed reason]
   **Follow-up**: Issue #123 created to address feedback
   ```
3. **Temporarily disable branch protection** (admin only)
4. **Merge**
5. **Re-enable protection immediately**
6. **Create follow-up issue** to address Greptile feedback

---

## Configuration

### No Setup Required! ✅

Since Greptile is a GitHub App:

- ❌ No API keys needed in secrets
- ❌ No workflow files needed
- ❌ No manual configuration

It just works automatically!

### Managing the GitHub App

**View installed apps**:
```
https://github.com/settings/installations
```

**Repository-specific settings** (admin only):
```
https://github.com/harshanandak/forge/settings/installations
```

You can:
- Enable/disable Greptile for specific repos
- Adjust review frequency
- Configure notification settings

---

## Customization (Optional)

### Repository Configuration

Create `.greptile/config.yml` in repo root:

```yaml
# Greptile configuration
review:
  # File patterns to ignore
  exclude:
    - "*.md"
    - "test/**"
    - "docs/**"
    - "*.test.js"
    - "dist/**"

  # Focus areas (prioritize these checks)
  focus:
    - security
    - bugs
    - performance

  # Review depth
  depth: thorough  # quick, normal, thorough
```

### Per-PR Instructions

Add comments in PR description to guide Greptile:

```markdown
@greptile focus on security and performance
@greptile ignore docs/ and test files
@greptile be extra strict on src/auth/
```

---

## Troubleshooting

### "Greptile Review check not appearing in branch protection"

**Cause**: Check hasn't completed at least once on any PR.

**Fix**:
1. It's currently running on PR #13
2. Wait for it to complete
3. Then refresh branch protection settings page
4. "Greptile Review" should now appear in the list

### "Greptile didn't review my PR"

**Possible causes**:
- GitHub App not installed or disabled
- PR is a draft (some apps skip drafts)
- Repository not in allowed list

**Fix**:
1. Visit: https://github.com/harshanandak/forge/settings/installations
2. Verify Greptile is installed and enabled
3. Check repository access permissions
4. Convert draft to ready for review if applicable

### "How do I request a re-review?"

**Methods**:
1. **Push new commit** - Triggers automatic re-analysis
2. **Comment on PR**: `@greptile please review` or `@greptile recheck`
3. **Close and reopen PR** - Forces fresh analysis

### "Can I see why Greptile flagged something?"

**Yes!**
1. Go to "Files changed" tab in PR
2. Find Greptile's comment thread
3. Each comment explains:
   - What the issue is
   - Why it's problematic
   - How to fix it
   - Often includes code examples

---

## Best Practices

### 1. Address Feedback Incrementally

Don't batch all fixes into one commit:
- Fix issues as you see them
- Commit after each logical fix
- Easier to review and debug

### 2. Use as Learning Tool

Greptile explains *why* something is an issue:
- Read the explanations, don't just apply fixes blindly
- Share interesting findings with your team
- Update coding standards based on patterns

### 3. Combine with Human Review

| Review Type | What It Catches |
|-------------|-----------------|
| 🤖 Greptile | Technical bugs, security, complexity, patterns |
| 👥 Human    | Business logic, UX, architecture, context |

**Both are essential!** They catch different types of issues.

### 4. Don't Fight the AI Unnecessarily

If Greptile flags something:
- There's usually a valid reason
- Read the explanation carefully
- If you disagree, comment why (helps improve Greptile)
- Propose alternative if you have a better approach

### 5. Track Common Patterns

Notice recurring issues across PRs?
- Document in coding standards
- Add to .greptile/config.yml to auto-enforce
- Share with team in README or CONTRIBUTING.md
- Consider pre-commit hooks for common issues

---

## Verification Checklist

Use this to confirm Greptile is set up correctly:

```
✅ Greptile GitHub App is installed
✅ Greptile has access to your repository
✅ "Greptile Review" check runs on PRs
✅ Greptile posts code review comments
✅ "Greptile Review" appears in branch protection options
✅ "Greptile Review" is selected as required check
✅ Branch protection rule is saved
✅ Test: Create PR → Greptile reviews → Merge blocked if issues
```

---

## FAQ

**Q: Does Greptile use a scoring system (like 4.0/5.0)?**
A: Yes! Greptile Review provides a confidence score (0-5) in the PR description. Our custom Quality Gate workflow enforces a minimum score of 4.0/5 before allowing merges.

**Q: Will it review every single commit?**
A: It reviews at the PR level. Runs when PR is opened and when new commits are pushed.

**Q: Does it slow down development?**
A: No! Reviews typically complete in 1-2 minutes. Runs in parallel with other checks.

**Q: Can I disable it for specific PRs?**
A: Yes, via PR description: `@greptile skip` (but only if not required in branch protection)

**Q: Is it free?**
A: Greptile has free and paid tiers. Check https://greptile.com/pricing for current plans.

**Q: Does it replace code review?**
A: No! It augments human review by catching technical issues, allowing humans to focus on architecture, business logic, and UX.

**Q: What languages does it support?**
A: Most modern languages including JavaScript, TypeScript, Python, Go, Java, Rust, etc.

**Q: Can I customize what it checks for?**
A: Yes, via `.greptile/config.yml` configuration file.

---

## Next Steps

1. ✅ **DONE** - Greptile Review is active and running
2. ✅ **DONE** - Greptile Quality Gate (≥4/5) is enforced in branch protection
3. ✅ **DONE** - All required checks configured for master branch
4. 🎯 **Create new PRs** and watch the quality gate in action
5. 📚 **Document** your team's policy for handling Greptile feedback
6. 🎉 **Celebrate** improved code quality!

---

## Additional Resources

- **Greptile Documentation**: https://docs.greptile.com
- **GitHub App Settings**: https://github.com/settings/installations
- **Branch Protection Guide**: [../.github/BRANCH_PROTECTION_GUIDE.md](../.github/BRANCH_PROTECTION_GUIDE.md)
- **Your PRs**: Check the [pull requests page](https://github.com/harshanandak/forge/pulls) for examples

---

## Summary

**What Greptile Is:**
- ✅ GitHub App providing detailed code reviews
- ✅ Custom Quality Gate workflow enforcing minimum score 4.0/5
- ✅ AI-powered code analysis on every PR
- ✅ Detailed, actionable feedback with confidence scores

**What's Now Active:**
- ✅ Greptile Review (GitHub App) is installed and running
- ✅ Greptile Quality Gate (≥4/5) is enforced in branch protection
- ✅ PRs to master require score ≥ 4.0/5 to merge
- ✅ All review comments must be resolved before merge

**Result:**
- 🚀 Higher code quality with enforced standards
- 🐛 Fewer bugs in production
- 📊 Objective quality metrics (4.0/5 minimum)
- 🛡️ Automated security and best practice checks
- 📚 Team learning from AI feedback

Enjoy your new AI code reviewer with quality enforcement! 🤖✨
