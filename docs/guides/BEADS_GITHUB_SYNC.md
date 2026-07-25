# Beads/GitHub Sync Deprecation

Beads/GitHub workflow sync is removed. Forge no longer ships `github-to-beads.yml` or `beads-to-github.yml` workflow templates, and there is no longer any way to scaffold Beads/GitHub sync.

## Current Behavior

- `.beads/` is legacy import-only state and is not committed. Import it with `forge migrate --from beads`.
- `forge setup` removes old generated Beads/GitHub sync files from existing installs automatically. The cleanup is no longer opt-in behind a flag.
- Only files whose content matches a known generated template are removed, so files you have edited yourself are preserved.

## Removed Generated Files

The `forge setup` compatibility cleanup removes the old generated files:

```text
.github/workflows/github-to-beads.yml
.github/workflows/beads-to-github.yml
.github/beads-mapping.json
.github/beads-sync-config.json
.github/scripts/beads-sync/*.mjs
scripts/github-beads-sync.config.json
scripts/github-beads-sync/*.mjs
```

Unrelated GitHub workflows are preserved.

## Replacement Direction

Future GitHub issue sync must use Forge Kernel/server authority. Local-only work is durable in local Kernel SQLite. Team or cross-machine issue state is serialized through server authority, then GitHub issues can be updated as a projection from that authority.

Do not commit live `.beads/` files, create metadata-only PRs, or bypass protected branches to update issue tracker state.
