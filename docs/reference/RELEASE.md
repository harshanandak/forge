# Release Reference

This page documents release readiness. Package publishing still requires the explicit publish step after merge.

## v0.1.0-beta.8 Boundary

v0.1.0-beta.8 is the current prerelease boundary. The release branch declares `0.1.0-beta.8`; publish only after the release PR is merged, tagged, and validated on that exact SHA.

Keep these release steps explicit:

- Release PR with documentation and package metadata
- GitHub Release
- npm publish
- DeepWiki refresh

## Pre-Release Validation

Run from a clean release branch or worktree:

```bash
git status --short --branch
bun run check
npm pack --dry-run
```

The trusted npm workflow is generated through `forge release generate-npm-workflow --expect-head "$(git rev-parse HEAD)"`; the full expected SHA must match the current checkout, and direct workflow edits remain blocked. The generated authorization is bound to that SHA, actor, worktree, path, and exact content, so moving HEAD before staging also fails closed. On a release event, the workflow resolves the tag once, runs the complete supported repository suite on that immutable commit, and allows publication only when the attributable suite receipt, verification checkout, and publish checkout all name the same SHA.

Generate the canonical test workflow through `forge release generate-test-workflow --expect-head "$(git rev-parse HEAD)"`. The command renders the staged `lib/workflow-templates/test.yml` with the staged manifest's exact Bun version, rejects unrelated target bytes, and binds the protected write to the expected HEAD and exact generated content. For a Bun version change, use `forge release update-bun-pins --expect-head "$(git rev-parse HEAD)"`; it delegates `test.yml` to the same full renderer while preserving the pin-only updates for the other workflows. Add `--to <X.Y.Z>` to pin an explicit stable version: the command refuses prerelease and canary versions, checks `--expect-head`, stages the `package.json` `packageManager` pin, and then runs the same authorized batch.

Bun stays pinned to the latest stable release automatically. Every week (and on a `workflow_dispatch` of Tests with `bump_bun` checked), the Tests workflow's **Bun Pin Auto-Update** job reads the latest stable release from the GitHub releases API and compares it with the pin. A bump commit always changes files under `.github/workflows`, and GitHub never lets the job's `GITHUB_TOKEN` push workflow-file changes, so what happens next depends on one optional repository secret, `BUN_BUMP_TOKEN`. The run summary gets one line naming the path that ran.

- **With `BUN_BUMP_TOKEN` (fully automatic).** When no open PR from `bun/bump-<version>` exists, the job creates that branch, runs `forge release update-bun-pins --to <version>`, commits through the normal Git hooks (the protected-state hook accepts the writer's commit), pushes with `forge push --quick`, and opens a `chore(deps): pin Bun <version>` PR that links the release notes. The token is used only to check out and push the bump branch and to open the PR; because `GITHUB_TOKEN` did not open the PR, its CI triggers on its own. Everything else runs on `GITHUB_TOKEN` with `contents: read`.
- **Without the secret (the default).** The job pushes nothing. A separate **Bun Pin Tracking Issue** job, the only one granted `issues: write`, opens one issue titled `Bun <version> available: run forge release update-bun-pins`, or updates the open one in place (matched by that stable title), with the release URL and the exact commands: `forge release update-bun-pins --to <version> --expect-head "$(git rev-parse HEAD)"`, then commit, `forge push`, and open the PR. The commands first delete a stale `bun/bump-<version>` branch a closed PR left behind. The run succeeds. On a later run where the pin is current, or where `BUN_BUMP_TOKEN` now opens the PR, the same job closes the open tracking issue.

To enable fully automatic bumps, create a fine-grained personal access token (or a GitHub App installation token) scoped to this repository with **Contents: Read and write**, **Workflows: Read and write**, and **Pull requests: Read and write**, and save it as the repository Actions secret `BUN_BUMP_TOKEN` (Settings > Secrets and variables > Actions). The workflow passes it only through step `env` and the `actions/checkout` `token` input, and never prints it. Delete the secret to fall back to the tracking issue.

Retire (delete) a workflow file through `forge release retire-workflow .github/workflows/<file> [more files...] --reason "<why>" --expect-head "$(git rev-parse HEAD)"`. Each path must be one file directly under `.github/workflows/` that exists at HEAD with unchanged working-tree bytes. The command refuses when classic branch protection or the repository rulesets for the default branch are unreadable (it reads both through the clone's bound GitHub account; an empty ruleset list counts as no requirements, but classic protection must return an authoritative required-status-checks set; a 403 or 404 from that endpoint is refused rather than read as "no checks", because it can also mean insufficient access, so a repository that enforces checks only through rulesets cannot retire workflows yet), when a ruleset `workflows` rule requires the file, when a required context from either source matches the file's workflow or job names (matrix and expression names included) or appears in its text, and when another workflow still depends on it through `workflow_run` or a reusable `uses: ./.github/workflows/<file>` call, unless that workflow is retired in the same call. The authorization is delete-only and bound to the path, the exact HEAD bytes, the actor, the worktree, and HEAD; the reason is recorded on the Kernel authorization and completion events and in the protected-state audit log. If a retirement fails after removing files, the command first revokes every authorization it issued, completed or not, and then restores only the files whose authorization was revoked; a file whose revocation failed stays removed and is named in the error. Stage the deletion with `git add -A -- <path>` and commit; the pre-commit hook consumes the authorization once and rejects any edit of the file or deletion of a different file.

Generate the package size workflow through `forge release generate-size-workflow --expect-head "$(git rev-parse HEAD)"`. The command renders `.github/workflows/size-check.yml` from the staged manifest's exact Bun version alone, rejects unrelated target bytes, and binds the protected write to the expected HEAD and exact generated content. The workflow has no path filters: it runs on every PR and every push to the default branch, so a newly published path cannot escape the check. After adding or changing a block in `scripts/package-budgets.json`, run `node scripts/package-size-check.js --write-baseline`; the workflow does not change. The measurement itself is the shipped building block `lib/package-budget.js` (pack-list parsing, block mapping, the ratchet decision, and the report, with no process or CI coupling), so another repository can apply its own block manifest and baseline to its own package. For a Bun version change, `forge release update-bun-pins` delegates `size-check.yml` to the same full renderer, as it does for `test.yml` and `npm-publish.yml`.

For docs-heavy changes, also run a Markdown link check if available. If no docs checker exists and adding one would broaden the PR, create a follow-up issue instead.

## Packaging Check

`npm pack --dry-run` should show the package contents without publishing. Confirm new canonical docs that should ship are included and generated junk is not.

## Release Notes

Release notes should include:

- user value
- migration notes
- feature flags or experimental areas
- known limitations
- rollback path
- adapter compatibility
- DeepWiki refresh checklist

The v0.1.0-beta.8 release notes live in [CHANGELOG.md](../../CHANGELOG.md).

## Rollback

For a release PR:

1. Revert the PR if the combined package metadata and public docs create release confusion.
2. Do not publish until README, CHANGELOG, quickstart, package metadata, and support docs agree.
3. If DeepWiki generated output is wrong, fix repository docs first, then refresh DeepWiki.

## Post-Merge DeepWiki Checklist

After merge to `master`:

1. Refresh DeepWiki for `harshanandak/forge`.
2. Confirm the generated index date and commit changed to the merged commit.
3. Compare generated Overview, Getting Started, and Core Concepts against:
   - [README](../../README.md)
   - [Quickstart](../../QUICKSTART.md)
   - [Docs index](../INDEX.md)
   - [Workflow templates](../guides/WORKFLOW_TEMPLATES.md)
   - [Skills and command projections](SKILLS.md)
   - [Command reference](COMMANDS.md)
4. File a follow-up issue if generated docs still reflect old seven-stage-only framing.
5. Record evidence in a PR comment or follow-up issue: DeepWiki index date, indexed commit, pages checked, pass/fail result, and any repository-doc corrections needed.
