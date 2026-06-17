# Forge Kernel Issue Command Contract

**Status**: Contract slice for Kernel-backed issue commands.
**Code contract**: `lib/kernel/issue-command-contract.js`.
**Storage model**: [Forge Kernel storage model](FORGE_KERNEL_STORAGE_MODEL.md).

## Purpose

This document defines the stable command contract for the Forge Kernel issue surface before the full Beads execution path is replaced. The command schemas, error envelope, next-command hints, and exit behavior are the contract. Skills and harness files must wrap these CLI commands rather than inventing alternate behavior.

This PR does not make every command Kernel-backed at runtime. Verified Beads-compatible passthroughs may remain during migration. Commands without a verified Beads equivalent, such as `forge release <id>`, are contract-defined for the Kernel backend and must not pretend to be supported through Beads.

## Commands

Read commands must support `--json` and return `next_commands`:

```text
forge issue ready --json
forge issue list --json
forge issue show <id> --json
forge issue search <query> --json
forge issue stats --json
```

Mutation commands must return the affected issue id, the resulting revision, and `next_commands`:

```text
forge issue create
forge issue update
forge issue close
forge issue comment
forge issue dep add
forge issue dep remove
forge claim <id>
forge release <id>
```

The operation names behind those commands are stable:

| Command | Operation | Mode |
| --- | --- | --- |
| `forge issue ready --json` | `ready` | read |
| `forge issue list --json` | `list` | read |
| `forge issue show <id> --json` | `show` | read |
| `forge issue search <query> --json` | `search` | read |
| `forge issue stats --json` | `stats` | read |
| `forge issue create` | `create` | mutation |
| `forge issue update` | `update` | mutation |
| `forge issue close` | `close` | mutation |
| `forge issue comment` | `comment` | mutation |
| `forge issue dep add` | `dep.add` | mutation |
| `forge issue dep remove` | `dep.remove` | mutation |
| `forge claim <id>` | `claim` | mutation |
| `forge release <id>` | `release` | mutation |

## Success Envelopes

All successful JSON responses use schema version `forge.issue.v1`.

Single-issue reads return:

```json
{
  "ok": true,
  "schema_version": "forge.issue.v1",
  "command": "forge issue show forge-123 --json",
  "data": {
    "id": "forge-123",
    "title": "Define command contract",
    "type": "task",
    "status": "open",
    "revision": 7
  },
  "next_commands": [
    "forge claim forge-123",
    "forge issue comment forge-123 \"<note>\""
  ]
}
```

List-style reads return `data.issues[]`, optional counts, and `next_commands`. `forge issue stats --json` returns `data.counts` plus ready, blocked, and claim counts when available.

Mutations return:

```json
{
  "ok": true,
  "schema_version": "forge.issue.v1",
  "command": "forge claim forge-123",
  "data": {
    "id": "forge-123",
    "revision": 8,
    "projection": {
      "status": "pending",
      "targets": ["beads"]
    }
  },
  "next_commands": [
    "forge issue show forge-123 --json",
    "forge release forge-123"
  ]
}
```

## Error Envelope

All command failures that render JSON use `forge.issue.error.v1`:

```json
{
  "ok": false,
  "schema_version": "forge.issue.error.v1",
  "command": "forge issue show forge-missing --json",
  "error": {
    "code": "ISSUE_NOT_FOUND",
    "message": "Issue not found: forge-missing",
    "exit_code": 3,
    "retryable": false
  },
  "next_commands": [
    "forge issue search \"forge-missing\" --json"
  ]
}
```

`error.code` is stable for scripts. `error.message` is for humans. `error.details` may be present for structured diagnostics, but consumers must not require it.

## Exit Codes

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Internal or unclassified command failure. |
| `2` | Usage error, invalid flags, or missing required arguments. |
| `3` | Requested issue, dependency, claim, or comment was not found. |
| `4` | Revision conflict, claim conflict, or dependency-cycle conflict. |
| `5` | Required backend, broker, projection target, or local filesystem authority is unavailable. |
| `6` | Validation failure for command input or payload shape. |

## Revision And Idempotency

Kernel writes are guarded by `expected_revision` and idempotency at the broker boundary. The CLI owns both:

- The CLI derives idempotency metadata from the command, normalized payload, actor/session/worktree context, and retry attempt.
- The CLI fetches or refreshes the current issue revision before submitting a guarded mutation.
- Skills must not hand-generate idempotency keys.
- Skills must not require agents to supply `expected_revision` for normal commands.
- A later escape hatch may expose an explicit revision flag for advanced repair flows, but that flag is not part of the agent happy path.

Successful mutation responses expose the resulting `revision`; they do not require the caller to understand the broker event internals.

## Beads Migration Boundary

During migration, these verified Beads-compatible passthroughs may remain:

- `ready`, `list`, `show`, `search`, and `stats`,
- `create`, `update`, `close`, and `comment`,
- `dep.add` and `dep.remove`,
- legacy `claim` through `bd update --claim` until Kernel claim leases become the default.

`release` is Kernel-only in this contract because no verified Beads release operation is documented by the current Beads help surface. Implementing real Kernel execution for `release` belongs to the follow-up broker command PR.
