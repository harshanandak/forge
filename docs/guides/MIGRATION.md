# Migration Guide

Use this guide when moving older Forge docs, habits, or installed scaffolding toward the v0.0.11 public framing.

## What Changed

Forge is now documented as a local runtime control plane for AI-assisted engineering. The TDD-first workflow is still the default template, but it is no longer the only public explanation of Forge.

## From Stage-Only Docs

Old docs often describe Forge as a fixed seven-, eight-, or nine-stage workflow. Replace that with:

```text
Default template: /plan -> /dev -> /validate -> /ship -> /review -> /premerge -> /verify
```

Then add the boundary:

```text
These are agent workflow stages. Not every stage is a standalone forge CLI command.
```

## From `forge setup` Only

Use both entry points correctly:

- `forge init` creates the `.forge/` adoption skeleton.
- `forge setup` installs agent instructions, skills, harness files, Beads/GitHub sync scaffolding, and optional setup material.

## From Singular Agent Flags

Replace stale examples that use the old singular agent flag form with:

```bash
forge setup --agents codex
forge setup --agents claude,cursor
```

## Version Labels

- `0.0.10` is the package version in this checkout before the release bump.
- `v0.0.11` is the planned public docs/readiness release.
- Internal labels such as `0.0.19` or `v3` describe roadmap slices or historical codenames. Do not present them as current package versions.

## Safe Upgrade Path

1. Update docs and examples first.
2. Run `bun run check`.
3. Run `npm pack --dry-run`.
4. Open a PR.
5. After merge, refresh DeepWiki and verify generated pages against repository docs.

## Rollback

If migration creates confusion, revert the docs PR. Do not publish a package version until README, CHANGELOG, quickstart, support docs, and package metadata agree.
