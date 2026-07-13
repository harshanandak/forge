# Quickstart

This guide gets Forge installed and visible to an AI coding agent without assuming the old seven-stage workflow is the whole product.

## Prerequisites

- Git
- Node.js and Bun
- A GitHub repository if you want PR, sync, and branch-protection workflows
- GitHub CLI for PR-oriented flows: `gh auth login`
- Optional: Beads (`bd`) as an opt-out issue backend (issue commands use the built-in kernel backend by default)

## 1. Install The Package

```bash
# Bun
bun add -D forge-workflow

# npm
npm install --save-dev forge-workflow
```

You can also run one-off commands with `bunx forge ...` (or `npx forge ...`).

Terms used below:

- Runtime config means local `.forge/` files that describe adoption choices.
- Harness means an agent-specific install target. Forge currently supports Claude Code, Codex, Cursor, and Hermes.
- Beads means the opt-out `bd` issue backend. By default `forge ready`, `forge show`, and related wrappers use the built-in kernel backend; select Beads as described in section 5.

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
bunx forge setup --agents claude,cursor
```

Use `--agents`, not `--agent`.

`forge setup` is one-step onboarding: if `.forge/config.yaml` does not exist yet,
it runs `forge init` for you at the end (standard profile) so you finish with a
working workflow config. Re-run `forge init --profile <minimal|standard|full>
--force` to change it. On Windows without Git Bash, setup no longer aborts — it
prints install guidance (https://git-scm.com/download/win) and continues in a
reduced-capability mode where the shell-script-backed helper steps are unavailable
until you install Git Bash and re-run `forge setup`.

## 4. Inspect Local State

```bash
bunx forge status --json
bunx forge board --json
```

These are local runtime state views. They read the kernel issue store by default (and Beads-backed metadata when Beads is selected), but they are not a hosted project-management service.

## 5. Work With Issues And Worktrees

Issue commands use the built-in kernel backend by default — no Beads install or initialization is required:

```bash
bunx forge ready
bunx forge show <issue-id>
bunx forge claim <issue-id>
```

Beads is available as an opt-out backend. Select it (precedence: highest first) with the CLI flag `--issue-backend beads`, the environment variable `FORGE_ISSUE_BACKEND=beads`, or the `.forge/config.yaml` key `issueBackend: beads`. For Beads setup, see [Setup guide](docs/guides/SETUP.md).

For isolated feature work:

```bash
bunx forge worktree create docs-overhaul --branch codex/docs-overhaul
bunx forge worktree remove docs-overhaul
```

If Beads (when selected) reports a Dolt database or server error, use [Support and troubleshooting](docs/guides/SUPPORT.md) before changing issue state.

## 6. Run Validation

Validate your own project's changes before shipping:

```bash
bunx forge validate
```

`forge validate` runs your configured checks (tests, lint) and drops into a guided
debug flow on failure. (Contributors to Forge itself run `bun run check` — typecheck,
lint, security audit, and tests via `scripts/validate.js`.)

## 7. Understand Stage Commands

The agent workflow stages are documented in `AGENTS.md` and the installed agent skill files:

```text
/plan -> /dev -> /validate -> /ship -> /review -> /verify
```

These are the 6 agent workflow stages. Pre-merge is not a stage or a `/premerge` command — it is a documentation-and-handoff gate embedded in the `/ship` and `/review` stages. A composable `research` skill runs as a phase of `/plan` or standalone. Do not assume every stage is a standalone `forge <stage>` CLI command. For example, `/review` and `/verify` are agent-stage workflows, not current `forge review` or `forge verify` commands.

### Agent slash-skills vs. typeable `forge` verbs

`/plan`, `/dev`, `/validate`, `/ship`, `/review`, and `/verify` are **agent
slash-skills** — you invoke them by asking your AI agent to run that stage (they
resolve to the installed skill files under the agent's skills directory). They are
**not** all mirrored by a `forge <verb>` CLI command you type in a terminal.

What you type in a terminal are **`forge` CLI verbs**, for example:

```text
forge init | setup | status | board | ready | show | claim | close
forge worktree | validate | test | push | sync | clean | prime | gate
```

Overlap is deliberate but partial: `/validate` the stage and `forge validate` the
CLI verb both exist, whereas `/plan`, `/dev`, `/review`, and `/verify` have **no**
`forge plan|dev|review|verify` terminal command — they are agent stages only. Run
`forge --help` for the authoritative list of typeable verbs.

The workflow template is core to Forge. It is also designed to become more configurable as runtime graph, stage-skill, adapter, and extension surfaces ship. See [Workflow templates](docs/guides/WORKFLOW_TEMPLATES.md) and [Skills and command projections](docs/reference/SKILLS.md).

## 8. First Useful Loop

After setup, a small end-to-end loop looks like this:

1. Pick existing work with `bunx forge ready`, or create work in your normal tracker.
2. Ask the selected agent to run the appropriate stage, such as `/plan` for planned work or `/dev` for a small fix.
3. Run `bun run check`.
4. Use `/ship` or your normal PR flow to open a reviewable branch.
5. Keep the PR evidence in the repository so future agents and DeepWiki read the same source material.

## Next Reading

- [Docs index](docs/INDEX.md)
- [Setup guide](docs/guides/SETUP.md)
- [Migration guide](docs/guides/MIGRATION.md)
- [Support and troubleshooting](docs/guides/SUPPORT.md)
- [Command reference](docs/reference/COMMANDS.md)
- [Workflow templates](docs/guides/WORKFLOW_TEMPLATES.md)
- [Skills and command projections](docs/reference/SKILLS.md)
