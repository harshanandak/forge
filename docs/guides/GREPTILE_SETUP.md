# Greptile Code Review Setup

Greptile is an optional review integration. Do not assume it is installed, required by branch protection, or present on every Forge consumer repository. Verify the current repository's checks before documenting Greptile as a required gate.

## Verify Current Status

```bash
gh pr checks <pr-number>
gh api repos/<owner>/<repo>/branches/<branch>/protection
```

If Greptile appears on PRs and you want it to block merges, add the exact check name reported by GitHub to branch protection. Required check names are repository-specific.

## How Greptile Fits Forge

- Greptile can provide PR review comments through the GitHub App.
- A repository may add a custom quality-gate workflow.
- Forge review work should reply to and resolve actionable review threads.
- The review adapter scaffold currently supports Greptile-shaped review adapters.

## Setup Boundary

Forge does not guarantee that Greptile is installed or enforced. Treat Greptile as repository configuration:

1. Install/configure the Greptile GitHub App.
2. Confirm it runs on a PR.
3. Add required checks only after the check name is visible.
4. Document the configured branch-protection rule in the repository.

## Review Handling

When the repo includes the helper script:

```bash
bash .claude/scripts/review-resolve.sh list <pr-number> --unresolved
bash .claude/scripts/review-resolve.sh stats <pr-number>
```

Reply to each valid, invalid, conflicting, or out-of-scope thread before resolving it.

## Known Limits

- Greptile availability depends on GitHub App installation and repository access.
- Branch protection may not include Greptile even when Greptile comments on PRs.
- Required check names can change if workflows or integrations are renamed.

