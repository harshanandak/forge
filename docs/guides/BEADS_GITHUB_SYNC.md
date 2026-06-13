# Beads/GitHub Sync Deprecation

Beads/GitHub workflow sync is deprecated. Forge no longer ships active `github-to-beads.yml` or `beads-to-github.yml` workflow templates, and `forge setup --sync` must not create new Beads/GitHub sync scaffolding.

## Current Behavior

- `.beads/` is local runtime/export state and is not committed.
- `forge setup` removes old generated Beads/GitHub sync files from existing installs when they are present.
- `forge setup --sync` is retained only as a compatibility cleanup path.
- `forge sync` may still run local Beads/Dolt sync operations while Beads compatibility remains, but it is not GitHub issue lifecycle sync.

## Removed Generated Files

Setup cleanup removes the old generated files:

```text
.github/workflows/github-to-beads.yml
.github/workflows/beads-to-github.yml
.github/beads-mapping.json
scripts/github-beads-sync.config.json
scripts/github-beads-sync/*.mjs
```

Unrelated GitHub workflows are preserved.

## Replacement Direction

Future GitHub issue sync must use Forge Kernel/server authority. Local-only work is durable in local Kernel SQLite. Team or cross-machine issue state is serialized through server authority, then GitHub issues can be updated as a projection from that authority.

Do not commit live `.beads/` files, create metadata-only PRs, or bypass protected branches to update issue tracker state.
