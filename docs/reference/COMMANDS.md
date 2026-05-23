# Command Reference

This reference documents commands verified against the current package and CLI surfaces. Stage names beginning with `/` are agent workflow stages, not automatically standalone `forge` CLI commands.

## Package Entrypoints

The package exposes:

```text
forge
forge-workflow
forge-preflight
```

## Setup And Adoption

```bash
forge init [--profile minimal|standard|full] [--classification critical|standard|refactor] [--harness claude,cursor,codex,opencode,copilot] [--yes] [--force] [--dry-run]
forge setup --agents codex --yes
forge setup --agents claude,cursor
forge setup --agents claude cursor
forge setup --all --quick
forge setup --path ./repo --dry-run
forge setup --sync --agents claude,cursor
```

Use `--agents`, not `--agent`.

## Local State

```bash
forge status --json
forge board --json
```

`forge status` also supports workflow-state and issue-state inputs used by tests and stage recovery.

## Issue Wrappers

These commands delegate to Beads when Beads is configured:

```bash
forge ready
forge list
forge show <id>
forge create --title "Title"
forge update <id>
forge claim <id>
forge close <id>
forge issue ...
forge issues ...
forge sync
```

`forge sync` runs Beads/Dolt pull and push behavior. It is not the same as `forge setup --sync`, which scaffolds GitHub sync files.

## Worktrees

```bash
forge worktree create <slug> --branch <branch-name>
forge worktree remove <slug>
forge clean --dry-run
```

Slugs must not contain `..`, `/`, or `\`.

## Adapters

```bash
forge new adapter <name> --kind=review --template=greptile
forge adapter list
forge adapter test <name> --fixture=<path>
forge adapter enable <name>
forge adapter disable <name>
```

Only review adapters and the Greptile-shaped starter template are currently safe to present as supported.

## Validation And Packaging

```bash
bun run typecheck
bun run lint
bun run check
bun test --timeout 15000
npm pack --dry-run
```

`bun run check` is the project validation pipeline.

## Agent Workflow Stages

The default agent workflow template is:

```text
/plan -> /dev -> /validate -> /ship -> /review -> /premerge -> /verify
```

These are stage skills and installed agent workflows. They are intentionally documented separately from current `forge` CLI commands.

Do not document these as current CLI commands unless the matching `lib/commands/<name>.js` file exists:

```text
forge review
forge premerge
forge verify
forge release
```

