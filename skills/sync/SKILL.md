---
name: sync
description: >
  Forge kernel sync, export & migration. `forge sync` reconciles kernel issue state with the
  configured sync backend — a **local no-op until a server/remote is configured**; `forge
  export [--dir] [--dry-run]` writes the kernel backlog to deterministic git-tracked JSONL
  (D16 portability), and `forge export --import` reads that committed snapshot back into the
  kernel (hydrate); `forge migrate --from beads [--dry-run]` imports a Beads issue store into
  the kernel, while bare `forge migrate --dry-run` previews the v2→v3 migration (preview-only).
  Use when the user says "forge sync / sync the kernel
  issue state", "export the kernel backlog to JSONL", "re-import / hydrate the backlog",
  "migrate from beads", or "beads migration". Honesty: sync does nothing until a backend
  exists — never report "synced" when nothing happened; v2→v3 migrate is preview-only. NOT a
  database/schema migration (plan/dev), NOT syncing a git branch with main (ship), NOT memory
  notes (memory), NOT the skills-mirror sync run at install (setup).
allowed-tools: Bash, Read, Grep, Glob
terminal: true
---

Moving Forge kernel issue state around: reconcile with a backend, project it to git-tracked JSONL, or import from an older store. These are the kernel data-portability commands, distinct from schema/database migrations.

# Sync

```bash
forge sync         # reconcile kernel issue state with the configured sync backend
```

`forge sync` is a **local no-op until a sync backend (server/remote) is configured** — on a single machine it reports that the local kernel is the sole authority and changes nothing. It is the sync step in the session-completion flow; do not report "synced" when nothing actually happened.

# Export / re-import the backlog

```bash
forge export                     # write the kernel backlog to git-tracked JSONL (deterministic)
forge export --dir <path>        # choose the projection directory
forge export --dry-run           # show what would be written, change nothing
forge export --import            # read the committed JSONL snapshot back INTO the kernel (hydrate)
```

`forge export` is the **D16 portability projection**: a deterministic, git-committable snapshot of the backlog. `forge export --import` is the reverse — it hydrates the kernel from that on-disk snapshot (a re-import that applies nothing when everything is already present reports "already hydrated", it does not claim to import).

# Migrate from Beads (or preview v2→v3)

```bash
forge migrate --from beads [--dry-run]     # import a Beads issue store into the kernel
forge migrate --from beads --source <dir>  # point at exported beads *.jsonl (defaults to auto-detecting .beads/)
forge migrate --dry-run                    # preview the v2→v3 migration (the ONLY supported mode without --from)
```

`forge migrate --from beads` imports a Beads store into the Forge Kernel (`--dry-run` reads + maps only, writing nothing). Without `--from`, migrate is **v2→v3 preview only** — `--dry-run` is required and applying the migration is not yet available.

## Boundaries

- A **database/schema** migration (adding a column, altering a table) is application work — that's **plan**/**dev**, not `forge migrate`.
- Syncing a git **branch** with main before a PR is **ship**/**worktree**, not `forge sync`.
- Persisting a decision or note is **memory** (`forge remember`), not export.
- The skills-mirror sync that runs during install is **setup**, not `forge sync`.
