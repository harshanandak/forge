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
forge board --json
forge options lint
forge options diff
forge options why <key>
forge options stages
```

`forge options` inspects the runtime graph and `.forge/` adoption config created by `forge init`.

`forge status` (full flags below) also supports workflow-state and issue-state inputs used by tests and stage recovery.

## Core Workflow Loop

These are the CLI commands behind the default agent workflow template (`/plan -> /dev -> /validate -> /ship`, then the `/review` skill) plus the session-orientation and memory commands agents run alongside it. Verified against `lib/commands/<name>.js` and `forge <cmd> --help`.

```bash
forge plan "<feature description>"
forge dev [--issue-id <id>] [--phase red|green|refactor]
forge validate
forge ship <feature-slug> [<title>] [--dry-run]
forge status [--full] [--json]
forge prime [--budget N] [--json]
forge orient [--budget N] [--json]
forge recap <issue> [--budget N] [--json]
forge recall [query] [--limit N] [--all] [--json]
forge remember <note> [--tag <label>]... [--json]
```

- `forge plan` creates the implementation plan, kernel issue, and feature branch/worktree from a researched feature description; it prints the created issue id, branch name, and the suggested next command.
- `forge dev` runs the TDD development stage with RED/GREEN/REFACTOR phase guidance; `--issue-id` scopes it to a specific kernel issue and `--phase` overrides auto-detection.
- `forge validate` runs the validation orchestration pipeline (conflict markers, type check, lint, security, tests) with no arguments — see also `bun run check` under Validation And Packaging.
- `forge ship` creates the pull request from validated feature work (wraps `gh pr create`); `--dry-run` previews without creating a PR.
- `forge status` is the one-glance orientation command: where you are, what to run next, and your active work; `--full` also shows blocked/stale/recently-completed issues.
- `forge prime` emits the bounded session-entry orientation envelope agents read at the start of a session.
- `forge orient` emits bounded project orientation from deterministic source files (broader than `prime`, still token-budgeted via `--budget`).
- `forge recap <issue>` is the issue-scoped counterpart to `forge orient`/`forge prime` — it summarizes a single issue from the same deterministic file assembly instead of the whole project. Requires an issue id; running it with no id (or `--help`) prints usage only.
- `forge recall` retrieves project-memory notes from the kernel-backed memory store; omit `query` to list recent notes.
- `forge remember` persists a project-memory note to the kernel-backed memory store; repeat `--tag` to attach multiple labels.

## Issue Wrappers

These commands delegate to the Kernel by default. Beads is used only when explicitly selected — precedence (highest first): the `--issue-backend beads` flag, then `FORGE_ISSUE_BACKEND=beads`, then the `.forge/config.yaml` key `issueBackend: beads`, otherwise the Kernel default. The stable Kernel-era JSON contract is defined in [Forge Kernel issue command contract](forge-kernel-issue-command-contract.md).

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
forge worktree create <slug> --base <ref>
forge worktree remove <slug>
forge clean --dry-run
```

Slugs must not contain `..`, `/`, or `\`.

A new worktree's branch is forked from the repository's **default branch**
(`origin/<default>` when the remote ref exists, else the local default) — **not**
the checkout's current branch/HEAD — so a worktree created from a WIP branch never
silently inherits unrelated commits. Pass `--base <ref>` to fork from a specific
ref instead; an invalid `--base` errors and creates nothing. `create` prints the
base it used (e.g. `Created worktree <path> on <branch> (based on origin/main).`)
so the fork point is never silent.

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
forge doctor
forge test
forge push
forge upgrade
forge migrate
forge recommend
forge add
```

`forge migrate` is dry-run oriented in the current public docs. Do not present it as a migration executor.

## Doc Gate

`forge doc-gate` inspects a repository's documentation structure and enforces that code changes ship with a documentation update. It is a thin CLI wrapper over the validated doc-gate detector and gate.

```bash
forge doc-gate detect [--json]
forge doc-gate check --base <ref> --head <ref> [--skip] [--json]
```

- `detect` runs the repo-structure detector against the current working directory and prints a human-readable summary — detected source surface, toolchain, CI provider, CHANGELOG, and AGENTS.md, plus an overall verdict — or a structured object with `--json`. Any verdict, including `ESCALATE→agent` or `MANUAL-CONFIG`, exits 0; it exits non-zero only on a real error (not a git repository, or no commits yet).
- `check` compares the `--base` and `--head` refs and **fails when a code change lands without an accompanying documentation update**. A `pass` or `abstain` decision exits 0; a hard `fail` exits 1. Use `--skip` to record an explicit skip without supplying refs.

Both subcommands require a git working tree with at least one commit (`HEAD`). The related `forge doc-gate init` (scaffold a doc-gate declaration file) and `forge doc-gate okf` (OKF bundle generation) subcommands are also registered; run `forge doc-gate` with no arguments for full usage.

## Kernel Filesystem Safety

The Forge Kernel stores its SQLite database under `.git/forge/kernel.sqlite`. SQLite WAL mode corrupts when a cloud-sync client (OneDrive, Dropbox, Google Drive, iCloud) or a network filesystem (UNC / SMB / NFS / mapped drive) rewrites the database mid-write. A default-on gate in `broker.initialize()` therefore **refuses** to initialize the kernel on those filesystems — the throw happens *before* any database file is created, so nothing is written to the unsafe location.

```bash
forge doctor          # human summary, exits non-zero on a refuse-class path
forge doctor --json   # machine-readable report (schemaVersion 1)
```

`forge doctor` resolves the exact kernel database path the gate guards and reports its filesystem class **without creating any file**:

| Class | Risk tier | Behavior |
|-------|-----------|----------|
| `local-ok` | safe | proceed silently |
| `wsl-cross`, `unknown` | warn | proceed with a warning (fail-open) |
| `onedrive`, `dropbox`, `gdrive`, `icloud`, `network-unc`, `mapped-network-drive` | refuse | block kernel init |

**Escape hatch:** set `FORGE_KERNEL_ALLOW_UNSAFE_FS=1` to downgrade every `refuse` to a warning and proceed at your own risk (intended for reliable network homes, CI sandboxes, and incident recovery). It does not affect `safe`/`warn` classes. On Windows, mapped-drive detection **fails safe**: any probe failure is treated as `unknown` (warn), never silently allowed.

## Agent Workflow Stages

The default agent workflow template is:

```text
/plan -> /dev -> /validate -> /ship -> /review -> /verify
```

These are stage skills and installed agent workflows. They are intentionally documented separately from current `forge` CLI commands. The workflow is core to Forge, but it is packaged through agent harness files and skills rather than through one CLI command per stage. Pre-merge is not one of these numbered stages or a `/premerge` command; it is a documentation-and-handoff gate embedded in the `/ship` and `/review` stages that finishes docs and confirms CI before merge.

Do not document these as current CLI commands unless the matching `lib/commands/<name>.js` file exists:

```text
forge review
forge verify
```
