# Command Reference

This reference documents commands verified against the current package and CLI surfaces. Stage names beginning with `/` are agent workflow stages, not automatically standalone `forge` CLI commands.

For stage skills, command projections, and the skills-first roadmap, see [Skills and command projections](SKILLS.md) and [Workflow templates](../guides/WORKFLOW_TEMPLATES.md).

## Package Entrypoints

The package exposes:

```text
forge
forge-workflow
forge-preflight
```

Use `bunx forge ...` for first-run examples. Bare `forge ...` works when the package bin is available on PATH. Command-specific `--help` output is still uneven in the current CLI, so treat this reference as the canonical command list for v0.0.11 docs.

## Setup And Adoption

```bash
forge init [--profile minimal|standard|full] [--classification critical|standard|refactor] [--harness claude,cursor,codex] [--yes] [--force] [--dry-run]
forge setup --agents codex --yes
forge setup --agents claude,cursor
forge setup --agents claude cursor
forge setup --all --quick
forge setup --path ./repo --dry-run
forge setup --agents claude,cursor
```

Use `--agents`, not `--agent`.

## Local State

```bash
forge status --json
forge board --json
forge options lint
forge options diff
forge options why <key>
forge options stages
```

`forge status` also supports workflow-state and issue-state inputs used by tests and stage recovery.

`forge options` inspects the runtime graph and `.forge/` adoption config created by `forge init`.

## Issue Wrappers

These commands delegate to Beads when Beads is configured, except for Kernel-only surfaces explicitly called out below. The stable Kernel-era JSON contract is defined in [Forge Kernel issue command contract](forge-kernel-issue-command-contract.md).

```bash
forge ready
forge list
forge show <id>
forge issue ready --json
forge issue list --json
forge issue show <id> --json
forge issue search <query> --json
forge issue stats --json
forge create --title "Title"
forge update <id>
forge claim <id>
forge release <id>
forge close <id>
forge issue dep add <issue-id> <blocks-issue-id>
forge issue dep remove <issue-id> <blocks-issue-id>
forge issue ...
forge issues ...
forge sync
```

`forge release <id>` is a Kernel command contract and does not have a verified Beads passthrough in this slice.

`forge sync` runs Beads/Dolt pull and push behavior when configured. `forge setup --sync` is deprecated and removes old generated GitHub-Beads sync files; future GitHub issue sync belongs to Forge Kernel/server authority.

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

## Other Registered CLI Surfaces

These commands exist as current CLI surfaces, but many are specialized and should be checked with source or tests before using them in public examples:

```text
forge audit
forge explain
forge docs
forge test
forge push
forge upgrade
forge migrate
forge recommend
forge add
```

`forge migrate` is dry-run oriented in the current public docs. Do not present it as a migration executor.

## Agent Workflow Stages

The default agent workflow template is:

```text
/plan -> /dev -> /validate -> /ship -> /review -> /premerge -> /verify
```

These are stage skills and installed agent workflows. They are intentionally documented separately from current `forge` CLI commands. The workflow is core to Forge, but it is packaged through agent harness files and skills rather than through one CLI command per stage.

Do not document these as current CLI commands unless the matching `lib/commands/<name>.js` file exists:

```text
forge review
forge premerge
forge verify
```
