# Security dependency remediation tasks

## Task 1 — Resolve fixed-compatible dependency versions

**Files**: `package.json`, `packages/skills/package.json`, `bun.lock`

1. Capture the base audit as RED evidence: 8 high, 5 moderate, 1 low across 7 package keys.
2. Update only compatible dependency metadata:
   - root and `packages/skills` `js-yaml` 5.x to `^5.2.2`;
   - `packages/skills` `markdown-it` 14.x to `^14.1.2`;
   - root overrides for `linkify-it` 5.x fixed release, `brace-expansion` 5.0.9, and `fast-uri` 3.1.4+.
3. Regenerate the root lockfile without changing package behavior or unrelated dependencies.
4. Run focused package tests and fresh `bun audit --json`.

**Acceptance**: zero high/critical advisories; all affected package keys resolve beyond their vulnerable ranges; focused package behavior remains green.

## Task 2 — Independent spec review

Review the final diff against `plan.md`, the issue, and package-distribution requirements. Confirm the markdown-it/linkify-it and js-yaml reachability decisions, compatibility boundaries, and no unrelated file edits. If findings exist, fix them and repeat review.

## Task 3 — Independent security-quality review

Review the final diff adversarially for audit bypasses, unsafe overrides, lockfile integrity, major-version/API changes, reachable YAML parsing behavior, and residual risk. Confirm fresh audit output and focused validation. If findings exist, fix them and repeat review.

## Task 4 — Final validation and commit

Re-prove the Forge lease, run fresh focused dependency/package/audit checks plus required build/type/lint checks (not the full repository suite), inspect the staged file list, and commit only lane-owned changes. Do not push, open a PR, merge, or close the issue.
