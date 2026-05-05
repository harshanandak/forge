# Troubleshooting

## Beads/Dolt Worktree Port Contention

### Symptom

Multiple Forge worktrees can fail or hang around Beads operations when stale Dolt server runtime files are present in the shared `.beads` directory:

- `.beads/dolt-server.lock`
- `.beads/dolt-server.pid`
- `.beads/dolt-server.port`

The practical signal is that one worktree's `bd` or `forge` command tries to reuse or manage a Dolt SQL server lifecycle that another worktree started.

### Cause

Server mode depends on a background `dolt sql-server` process and a TCP listener. In multi-worktree or sandboxed-agent workflows, that process lifecycle becomes shared runtime state and can collide even though the Git worktrees are separate.

### Fix

For local Forge worktree automation, use embedded Dolt mode in `.beads/metadata.json`:

```json
{
  "database": "dolt",
  "backend": "dolt",
  "dolt_mode": "embedded",
  "dolt_database": "forge"
}
```

Embedded mode keeps Beads operations local to the Dolt data without requiring a long-lived `dolt sql-server` listener.

Keep server mode for workflows that intentionally need a shared Dolt SQL server, cross-machine coordination, or external MySQL-compatible clients.

### Validation

After switching modes, verify the active context and issue visibility:

```bash
bd context
bd list --json --limit 0
forge show forge-besw.18
```

Expected context includes:

```text
Backend:
  type:         dolt
  mode:         embedded
  database:     forge
```

For worktree contention, run read-only Beads commands from two worktrees close together and confirm both complete without a port collision or stale pid/lock error.

### Rollback

Before changing mode, confirm the JSONL backup state:

```bash
bd backup status
```

If embedded mode opens the wrong issue set or fails to open the database, restore the metadata mode to `server`, then use the backup guidance from `bd backup status` / `bd backup restore`. In this repo, a verified rollback source existed before the switch:

```text
Counts: 260 issues, 331 events, 2 comments, 263 deps, 46 labels, 11 config
```

