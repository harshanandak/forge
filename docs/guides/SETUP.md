# Setup Guide

This guide covers supported Forge adoption paths. Use [Quickstart](../../QUICKSTART.md) for the shortest path and [Support](SUPPORT.md) when setup fails.

## Prerequisites

- Git
- Node.js and Bun
- GitHub CLI if using PR or sync workflows
- Optional: Beads (`bd`) as an opt-out issue backend (issue commands use the built-in kernel backend by default)

## Install

```bash
bun add -D forge-workflow@beta
```

> The current release is a prerelease under the `beta` dist-tag — install with
> `@beta`. A bare `forge-workflow` resolves to the older stable `latest`.

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

## Issue Backend

Forge issue commands (`forge ready`, `forge show`, `forge claim`, `forge create`, `forge close`) use the built-in **kernel** backend. No install or initialization is required — a fresh clone can track issues immediately.

## Migrating From Beads

Beads is no longer a selectable backend: `--issue-backend beads`, `FORGE_ISSUE_BACKEND=beads`, and `issueBackend: beads` are rejected, and `bd` is never required. An existing `.beads` directory is import-only state.

Import it once, then use the kernel issue commands:

```bash
forge migrate --from beads
```

## Deprecated GitHub Sync Cleanup

`forge setup` removes old generated GitHub/Beads sync files from an existing
install automatically — there is no flag for it. Only files whose content
matches a known generated template are removed, so files you have edited
yourself are left alone. Future GitHub issue sync belongs to Forge Kernel/server
authority, not Beads runtime files or metadata commits.

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
