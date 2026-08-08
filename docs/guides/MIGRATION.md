# Migration Guide

Use this guide when moving older Forge docs, habits, or installed scaffolding toward the v0.1.0-beta.5 public framing.

## What Changed

Forge is now documented as a local runtime control plane for AI-assisted engineering. The TDD-first workflow is still the default template, but it is no longer the only public explanation of Forge.

## From Stage-Only Docs

Old docs often describe Forge as a fixed seven-, eight-, or nine-stage workflow. Replace that with:

```text
Default template: /plan -> /dev -> /validate -> /ship -> /review -> /verify
```

These are the 6 workflow stages. Pre-merge is not a stage or a `/premerge` command — it is a documentation-and-handoff gate embedded in `/ship` and `/review`. A composable `research` skill runs as a phase of `/plan` or standalone. Then add the boundary:

```text
These are agent workflow stages. Not every stage is a standalone forge CLI command.
```

## From `forge setup` Only

Use both entry points correctly:

- `forge init` creates the `.forge/` adoption skeleton.
- `forge setup` installs agent instructions, skills, harness files, local Beads compatibility, and optional setup material.
- `forge setup` also removes old generated Beads/GitHub sync scaffolding when present, with no flag needed.

## From Singular Agent Flags

Replace stale examples that use the old singular agent flag form with:

```bash
forge setup --agents codex
forge setup --agents claude,cursor
```

## Version Labels

- `0.1.0-beta.5` is the current prerelease package version.
- `0.1.0-beta.4` is the previous prerelease package version.
- Internal labels such as `0.0.19` or `v3` describe roadmap slices or historical codenames. Do not present them as current package versions.

## Safe Upgrade Path

1. Update docs and examples first.
2. Run `bun run check`.
3. Run `npm pack --dry-run`.
4. Open a PR.
5. After merge, refresh DeepWiki and verify generated pages against repository docs.

## Rollback

If migration creates confusion, revert the release PR or open a corrective docs PR. Do not publish a package version unless README, CHANGELOG, quickstart, support docs, and package metadata agree.
