# Release Reference

This page documents release readiness. Package publishing still requires the explicit publish step after merge.

## v0.0.11 Boundary

v0.0.11 is the public documentation and positioning package release. The release branch bumps package metadata to `0.0.11`; publish only after the release PR is merged, tagged, and validated.

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

The v0.0.11 release notes live in [CHANGELOG.md](../../CHANGELOG.md).

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
