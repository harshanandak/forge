# Embedded Dolt Worktree Contention Plan

Issue: `forge-besw.18`
Date: 2026-05-04
Work folder: `docs/work/2026-05-04-embedded-dolt-worktree-contention/`
Classification: Simple bug/config fix with data-integrity risk

## Problem

`forge-besw.18` asks to switch this repo's local Beads/Dolt setup from server mode to embedded mode so concurrent worktrees stop fighting over `.beads/dolt-server.lock` and `.beads/dolt-server.pid`.

Current repo evidence:

- `.beads/metadata.json:4` is still `"dolt_mode": "server"`.
- `.beads/dolt/config.yaml:25-27` configures a TCP listener at `127.0.0.1:65332`.
- `.beads/dolt-server.lock`, `.beads/dolt-server.pid`, and `.beads/dolt-server.port` exist in this repo.
- `.beads/embeddeddolt` currently contains only `.lock`, while `.beads/dolt/forge` contains a Dolt database directory.
- `TROUBLESHOOTING.md` does not currently exist at repo root or under `docs/`.

## Research

Local `bd init --help` reports server mode is currently default and says embedded mode is "returning soon" in this dev build. That makes a metadata-only flip risky unless the implementation proves the installed Beads code path can open the target data in embedded mode.

Beads documentation says server mode provides concurrent access and background database operations, while embedded mode is appropriate for CI/CD, containers, ephemeral environments, scripts, and automated workflows. It also calls out worktree-based multi-agent workflows as a race-risk scenario and recommends embedded mode for automated workflows.

Dolt documentation separates `dolt sql-server`, which starts a MySQL-compatible server, from `dolt sql`, which runs local SQL without starting a server. Dolt server configuration is explicitly about `dolt sql-server` process startup and listener configuration.

Sources:

- Beads architecture: https://gastownhall.github.io/beads/architecture
- Dolt running server docs: https://docs.dolthub.com/sql-reference/server
- Dolt server configuration docs: https://docs.dolthub.com/sql-reference/server/configuration
- Beads sandbox issue: https://github.com/gastownhall/beads/issues/3582

## Alternatives

### A. Metadata-only flip

Change `.beads/metadata.json` from `server` to `embedded` and document the symptom.

Pros:
- Smallest patch.
- Matches the literal issue description.

Cons:
- May point Beads at an empty or unsupported embedded store.
- Does not prove issue data survives the mode switch.
- Local help output suggests embedded support may be version-sensitive.

Verdict: reject as too weak unless a test proves the active database opens correctly after the flip.

### B. Embedded mode with explicit backup, migration, and verification

Export/verify the current issue set, switch to embedded mode only after confirming the active storage path, then run issue-list and concurrent-worktree checks.

Pros:
- Solves port and process lifecycle contention.
- Fits D30 and sandboxed-agent requirements.
- Protects current issue data.

Cons:
- More than a five-minute config edit.
- Requires careful validation because Beads local behavior is version-sensitive.

Verdict: selected.

### C. Per-worktree server ports

Keep server mode but assign a unique Dolt SQL server port per worktree.

Pros:
- Compatible with the current server-default Beads build.
- Lower migration risk.

Cons:
- Retains background process lifecycle failures.
- Does not help sandboxes where TCP or socket IPC is blocked.
- Needs durable port allocation logic, cleanup, and docs.

Verdict: fallback only if embedded mode is not actually usable in this Beads build.

### D. Unix socket server mode

Keep server mode but avoid TCP port collisions by using Unix sockets.

Pros:
- Avoids TCP port conflicts where sockets are available.

Cons:
- Not portable to this Windows-first repo flow.
- Beads issue #3582 indicates hardened sandboxes may block sockets too.
- Still leaves a server lifecycle to manage.

Verdict: not appropriate for this issue.

### E. Lock/pid cleanup only

Detect stale `.beads/dolt-server.lock` or `.beads/dolt-server.pid` and clean them before operations.

Pros:
- Useful troubleshooting hygiene.
- Low implementation risk.

Cons:
- Treats symptoms, not the architectural cause.
- Still collides under legitimate concurrent worktree use.

Verdict: include as documentation only, not the fix.

## Selected Approach

Implement B: embedded mode with explicit backup/migration validation.

The implementation should:

1. Capture a pre-change issue-count and representative issue snapshot from current server mode.
2. Confirm whether Beads can open the existing Dolt data in embedded mode, or whether a JSONL backup/restore path is required.
3. Change `.beads/metadata.json` only after the storage path is verified.
4. Add troubleshooting docs for orphan `.beads/dolt-server.lock` / `.beads/dolt-server.pid` symptoms.
5. Validate from this worktree and at least one additional worktree with concurrent `bd` reads.

If embedded mode fails in the installed Beads build, stop and report findings instead of landing a weaker server-port workaround under this issue.
