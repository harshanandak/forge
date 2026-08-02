# Merge-authority exact-head lease hotfix

## Objective

Ship an independently reviewed stable-base prerequisite that prevents `forge merge --auto` from authorizing or merging an unreviewed/changing PR head before release PR #471 resumes.

## Scope

- Require caller-supplied full `--expect-head` and Forge `--issue` values when auto-merge is enabled.
- Prove the active Kernel claim before provider reads and immediately before mutation.
- Read and compare the current PR head twice.
- Read the classic branch-protection required set; reject rollup fallback as merge authority.
- Require literal `SUCCESS` for every observed protected context; missing, pending, failing, skipped, neutral, aliases, and unknown states do not authorize.
- Require known non-draft, conflict-free, zero-unresolved-thread state independent of configurable rules.
- Pass `--match-head-commit <sha>` to GitHub for an atomic server-side lease.
- Preserve default-off and terminal/idempotent behavior.

## Validation

Use focused merge, adapter, Shepherd/pull, CLI dispatch, status/help, lint, and diff checks. Obtain independent exact-SHA review before push.

## Out of scope

- Durable continuation-controller implementation.
- Cryptographically authenticated actor identity.
- Persisted Kernel verdict authority.
- Local app-ID matching when `gh pr view` omits the producing app. GitHub's protected merge remains the final app-ID enforcement; malformed app IDs and inconsistent protection payloads fail closed locally.
- Rulesets-only repositories without a readable classic protected-check endpoint. They fail closed rather than using rollup inference.
