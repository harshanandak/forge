# Manual Review Guide

Manual review remains required even when AI review tools are configured.

## Workflow Boundary

`/review` is an agent workflow stage. It is not currently documented as a standalone `forge review` CLI command. Use GitHub, `gh`, adapter tools, and the installed agent review skill for PR review work.

Default stage context:

```text
/plan -> /dev -> /validate -> /ship -> /review -> /verify
```

These are the 6 workflow stages. Pre-merge is not a stage or a `/premerge` command — it is a documentation-and-handoff gate embedded in `/ship` and `/review`.

## Review Inputs

Check all available inputs:

- GitHub Actions and required checks
- human review comments
- Greptile or other review-bot comments, when configured
- SonarCloud or code-scanning findings, when configured
- local validation evidence from `bun run check`
- design and task artifacts under `docs/work/YYYY-MM-DD-<slug>/`

## Checklist

- The PR description matches the diff.
- The change stays inside scope.
- User-facing commands are verified against current code.
- Security-sensitive claims are backed by code, tests, or configured CI.
- Tests or validation evidence match the risk of the change.
- Documentation changes do not present future roadmap work as ready now.
- Review threads are replied to and resolved where the platform supports it.

## Greptile

If Greptile is configured for the repository, use the repo's Greptile resolution script when available:

```bash
bash .claude/scripts/greptile-resolve.sh list <pr-number> --unresolved
```

Then reply to each thread with the fix, rejection reason, or follow-up issue.

## Final State

Before calling review complete:

```bash
gh pr checks <pr-number>
gh pr view <pr-number> --json reviews,comments,statusCheckRollup
```

All completed required checks should be passing, and unresolved comments should either be fixed or explicitly answered.

