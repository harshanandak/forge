# Quickstart

This guide gets Forge installed and visible to an AI coding agent without assuming the old seven-stage workflow is the whole product.

## Prerequisites

- Git
- Node.js and Bun
- A GitHub repository if you want PR, sync, and branch-protection workflows
- GitHub CLI for PR-oriented flows: `gh auth login`
- Optional: Beads (`bd`) for durable local issue state

## 1. Install The Package

```bash
bun add -D forge-workflow
```

You can also run one-off commands with `bunx forge ...`.

## 2. Initialize Runtime Config

Use `forge init` for the day-one `.forge/` skeleton:

```bash
bunx forge init --profile minimal --classification standard --harness codex --yes
```

Generated files:

- `.forge/config.yaml` - adoption profile, default classification, Layer 1 rail confirmation, and harness targets.
- `.forge/patch.md` - local patch-intent placeholder.
- `.forge/protected-paths.yaml` - protected-path manifest scaffold.

Useful checks:

```bash
bunx forge options lint
bunx forge options diff
```

## 3. Install Agent Instructions

Use `forge setup` when you want Forge to install agent-facing files:

```bash
bunx forge setup --agents codex --yes
```

Other safe examples:

```bash
bunx forge setup --agents claude,cursor
bunx forge setup --agents claude cursor
bunx forge setup --all --quick
bunx forge setup --path ./my-project --agents codex --dry-run
bunx forge setup --sync --agents claude,cursor
```

Use `--agents`, not `--agent`.

## 4. Inspect Local State

```bash
bunx forge status --json
bunx forge board --json
```

These are local runtime state views. They can read Beads-backed issue metadata when Beads is configured, but they are not a hosted project-management service.

## 5. Work With Issues And Worktrees

When Beads is available:

```bash
bunx forge ready
bunx forge show <issue-id>
bunx forge claim <issue-id>
```

For isolated feature work:

```bash
bunx forge worktree create docs-overhaul --branch codex/docs-overhaul
bunx forge worktree remove docs-overhaul
```

If Beads reports a Dolt database or server error, use [Support and troubleshooting](docs/guides/SUPPORT.md) before changing issue state.

## 6. Run Validation

For this repository:

```bash
bun run check
npm pack --dry-run
```

`bun run check` runs typecheck, lint, security audit, and tests through `scripts/validate.js`.

## 7. Understand Stage Commands

The agent workflow stages are documented in `AGENTS.md` and the installed agent skill files:

```text
/plan -> /dev -> /validate -> /ship -> /review -> /premerge -> /verify
```

These are agent workflow stages. Do not assume every stage is a standalone `forge <stage>` CLI command. For example, `/review` and `/verify` are agent-stage workflows, not current `forge review` or `forge verify` commands.

## Next Reading

- [Docs index](docs/INDEX.md)
- [Setup guide](docs/guides/SETUP.md)
- [Migration guide](docs/guides/MIGRATION.md)
- [Support and troubleshooting](docs/guides/SUPPORT.md)
- [Command reference](docs/reference/COMMANDS.md)
