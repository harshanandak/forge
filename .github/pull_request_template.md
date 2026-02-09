# Pull Request

## Summary

<!-- Brief description of what this PR does (1-3 sentences) -->

## Changes

<!-- Detailed list of changes -->
-
-

## Type of Change

<!-- Check all that apply -->
- [ ] New feature (`feat:`)
- [ ] Bug fix (`fix:`)
- [ ] Documentation (`docs:`)
- [ ] Refactoring (`refactor:`)
- [ ] Testing (`test:`)
- [ ] Maintenance (`chore:`)

## Forge Workflow

<!-- Which stage does this PR correspond to? -->
- [ ] Research (`/research`)
- [ ] Implementation (`/dev`)
- [ ] Validation (`/check`)
- [ ] Documentation (`/verify`)

## Testing

<!-- How was this tested? -->
- [ ] Manual testing completed
- [ ] E2E tests added/updated
- [ ] Unit tests added/updated
- [ ] No tests needed (docs/config only)

**Test plan:**
<!-- Describe how to test this change -->

## Self-Review Checklist

<!-- CRITICAL - Review your own PR before requesting review -->
<!-- This catches 80% of bugs before merge -->

- [ ] I reviewed the full diff on GitHub
- [ ] No debug code (console.log, commented code, temporary changes)
- [ ] ESLint passes with zero warnings (`bunx eslint .`)
- [ ] All tests pass locally (`bun test`)
- [ ] No hardcoded secrets or API keys
- [ ] Error handling implemented where needed
- [ ] No breaking changes (or documented in migration guide)
- [ ] TDD compliance: All source files have corresponding tests
- [ ] Code follows project patterns and conventions

## Beads Issue Tracking

<!-- Link Beads issues this PR addresses -->
Closes beads-xxx
Related to beads-yyy

<!-- Use `bd list --status=open` to see open issues -->
<!-- Use `bd show <id>` to see issue details -->

## Screenshots (if applicable)

<!-- Add screenshots for UI changes -->

## Related Issues/PRs

<!-- Link to related GitHub issues or PRs -->
- Closes #
- Related to #

---

## ✅ Merge Criteria (All Must Be Met)

**Before clicking "Squash and merge", verify:**

- [ ] All CI checks passing (ESLint, tests, CodeQL, dependency review)
- [ ] Self-review completed (checklist above ✅)
- [ ] **All review comment threads resolved** (required by branch protection)
- [ ] All reviewer feedback addressed
- [ ] Branch is up-to-date with main
- [ ] No merge conflicts
- [ ] PR is marked "Ready for review" (not Draft/WIP)
- [ ] Required approvals obtained (if configured)
- [ ] Beads issues updated (`bd close <id>` after merge)

**⚠️ Do NOT merge if:**

- ❌ Tests are failing
- ❌ ESLint errors/warnings present
- ❌ Review comments unresolved
- ❌ It's Friday evening (unless critical hotfix)
- ❌ You haven't verified on dev environment

---

## Post-Merge Checklist

After merging, remember to:

- [ ] Close related Beads issues: `bd close <id>`
- [ ] Update Beads issue with PR link: `bd update <id> --notes "Merged in PR #123"`
- [ ] Sync Beads to remote: `bd sync`
- [ ] Delete local branch: `git branch -d feat/branch-name`
- [ ] Pull latest main: `git checkout main && git pull`

---
