# Setup Guide

This guide covers supported Forge adoption paths. Use [Quickstart](../../QUICKSTART.md) for the shortest path and [Support](SUPPORT.md) when setup fails.

## Prerequisites

- Git
- Node.js and Bun
- GitHub CLI if using PR or sync workflows
- Optional: Beads (`bd`) for durable issue state

## Install

```bash
bun add -D forge-workflow
```

The package exposes `forge`, `forge-workflow`, and `forge-preflight`.

`install.sh` is a thin bootstrapper. It installs or invokes `forge-workflow` and delegates setup to the package; it is not a separate implementation of setup behavior.

## Fresh Repository Runtime Skeleton

Use `forge init` when you want only the local `.forge/` adoption skeleton:

```bash
bunx forge init --profile minimal --classification standard --harness codex --yes
```

Supported options:

```text
--profile minimal|standard|full
--classification critical|standard|refactor
--harness claude,cursor,codex
--yes
--force
--dry-run
```

`forge init` creates `.forge/config.yaml`, `.forge/patch.md`, and `.forge/protected-paths.yaml`. It does not install agent instructions.

## Agent Setup

Use `forge setup` when you want agent-facing files:

```bash
bunx forge setup --agents codex --yes
```

Safe examples:

```bash
bunx forge setup --agents claude,cursor
bunx forge setup --agents claude cursor
bunx forge setup --all --quick
bunx forge setup --path ./my-project --agents codex --dry-run
bunx forge setup --merge smart --agents claude,cursor
```

Use `--agents`, not `--agent`.

## Agent Notes

Forge currently supports Claude Code, Codex, and Cursor. Hermes support is planned.

- Claude Code: installs `.claude/commands`, rules, and skills when selected.
- Cursor: installs Cursor rules and links back to `AGENTS.md`.
- Codex: uses `AGENTS.md` and may use Codex skills when installed.

Exact generated files depend on selected agents and existing repository files. Use `--dry-run` before applying setup to a mature repo.

## Beads

Beads is optional but recommended for durable issue state. Prefer the current Beads installer documented by Beads itself and this repo's toolchain docs. On Windows, avoid stale global install examples if they hit EPERM or shim issues; use the PowerShell installer path described in [Toolchain](../reference/TOOLCHAIN.md).

Basic health checks:

```bash
bd doctor
bd dolt status
forge sync
```

If a feature worktree reports `database "forge" not found on Dolt server`, diagnose in the root checkout before changing issue state.

## Deprecated GitHub Sync Cleanup

To remove old generated GitHub/Beads sync files from an existing install:

```bash
bunx forge setup --sync
```

`forge setup --sync` is deprecated. It now removes old generated Beads/GitHub sync files instead of creating new sync workflows. Future GitHub issue sync belongs to Forge Kernel/server authority, not Beads runtime files or metadata commits.

## Validate Setup

```bash
bunx forge status --json
bunx forge board --json
bun run check
```

## Troubleshooting

Use [Support and troubleshooting](SUPPORT.md) for:

- Beads/Dolt database errors
- Windows locked files
- protected-state blocks
- branch-protection push failures
- validation failures
- DeepWiki refresh drift
