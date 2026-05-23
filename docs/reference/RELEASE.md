# Release Reference

This page documents release readiness. It does not publish the package.

## v0.0.11 Boundary

v0.0.11 is the planned public documentation and positioning release. The package version in the checkout may still be the previous published version until the release bump and publish process run.

Keep these separate:

- Documentation readiness PR
- Version bump
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

The v0.0.11 draft lives in [CHANGELOG.md](../../CHANGELOG.md).

## Rollback

For a documentation-readiness PR:

1. Revert the PR if the public docs create confusion.
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
   - [Command reference](COMMANDS.md)
4. File a follow-up issue if generated docs still reflect old seven-stage-only framing.

