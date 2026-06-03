# Forge

[![npm version](https://img.shields.io/npm/v/forge-workflow.svg)](https://www.npmjs.com/package/forge-workflow)
[![license](https://img.shields.io/npm/l/forge-workflow.svg)](https://github.com/harshanandak/forge/blob/master/LICENSE)
[![Tests](https://github.com/harshanandak/forge/actions/workflows/test.yml/badge.svg)](https://github.com/harshanandak/forge/actions/workflows/test.yml)
[![ESLint](https://github.com/harshanandak/forge/actions/workflows/eslint.yml/badge.svg)](https://github.com/harshanandak/forge/actions/workflows/eslint.yml)
[![Coverage](https://img.shields.io/badge/coverage-80%25-brightgreen.svg)](https://github.com/harshanandak/forge)
[![Package Size](https://github.com/harshanandak/forge/actions/workflows/size-check.yml/badge.svg)](https://github.com/harshanandak/forge/actions/workflows/size-check.yml)
[![CodeQL](https://github.com/harshanandak/forge/actions/workflows/codeql.yml/badge.svg)](https://github.com/harshanandak/forge/actions/workflows/codeql.yml)
[![Security Policy](https://img.shields.io/badge/security-policy-blue.svg)](https://github.com/harshanandak/forge/blob/master/SECURITY.md)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/harshanandak/forge)

Forge is a local runtime control plane for AI-assisted engineering. It gives coding agents and humans a shared command surface for project state, workflow stages, issue tracking, validation evidence, adapters, worktrees, and recovery.

The default Forge workflow is TDD-first, but Forge is not just a fixed prompt pack. The stages are adoption scaffolding over local runtime primitives: state, gates, artifacts, adapters, Beads issue metadata, GitHub sync, validation, and handoff context.

In plain terms: Forge helps keep AI-assisted repository work recoverable, reviewable, and grounded in local evidence. The workflow template is a core feature, and the ability to inspect, customize, and eventually swap workflow stages is part of the product direction.

## Why It Matters

AI coding sessions fail most often at the project boundary: lost state, unclear ownership, stale TODOs, unverified claims, broken worktrees, and PRs that cannot be recovered after context changes. Forge is designed to make that boundary explicit.

Forge helps you:

- Protect project state while agents work.
- Give agents a runtime control plane instead of only prose instructions.
- Keep work recoverable across agents, PRs, Beads, GitHub, local worktrees, validation, and release flow.
- Separate ready-now behavior from experimental roadmap work.
- Leave evidence in the repository so generated tools such as DeepWiki can index the right source of truth.

## Who It Is For

- Solo builders using AI coding agents who want fewer lost handoffs.
- Teams coordinating multiple AI or developer sessions in the same repository.
- Technical users who need local state, auditability, validation, recovery paths, and command examples grounded in code.
- Maintainers responsible for keeping agent-authored work safe enough to review, resume, and release.

## Ready Now

- `forge init` for day-one `.forge/` adoption config in a fresh repository.
- `forge setup` for installing agent instructions, skills, Beads/GitHub sync scaffolding, and optional workflow files.
- Beads-backed issue wrappers such as `forge ready`, `forge show`, `forge claim`, `forge create`, `forge update`, and `forge close`.
- Local state views with `forge status --json` and `forge board --json`.
- Worktree helpers with `forge worktree create <slug>` and `forge worktree remove <slug>`.
- Review adapter scaffolding and fixture replay for review adapters.
- Validation via `bun run check`, which runs typecheck, lint, security audit, and tests through the repository validation script.
- Documentation and stage skills for `/plan`, `/dev`, `/validate`, `/ship`, `/review`, `/premerge`, and `/verify`.

## Experimental Or Configuration-Dependent

- Protected-state enforcement depends on the protected-state checker being wired into hooks or CI.
- Greptile, SonarCloud, branch protection, and GitHub sync depend on repository configuration and credentials.
- `forge migrate` is a dry-run proof of concept, not a migration executor.
- Future roadmap labels such as `0.0.19` describe internal planning targets, not the current public package version.
- DeepWiki is generated from this repository. It is useful for navigation, but the repository docs remain authoritative.

v0.0.11 is a documentation and positioning package release: canonical docs, corrected command boundaries, clearer setup paths, and DeepWiki-ready source material.

## Terms

- Runtime control plane: local commands, files, and checks that give agents a shared operating surface.
- Workflow template: the default stage path Forge installs for agents, such as `/plan -> /dev -> /validate -> /ship -> /review -> /premerge`.
- Harness: an agent-specific instruction surface such as Codex, Claude, Cursor, or OpenCode.
- Beads: the optional local issue-state backend used by Forge issue wrappers.
- Adapter: an integration boundary for review or issue tools.
- Protected state: files that should be changed through their owning command or API, not by casual edits.

## Quickstart

For a clean first run, use the full guide:

- [Quickstart](QUICKSTART.md)
- [Setup guide](docs/guides/SETUP.md)
- [Support and troubleshooting](docs/guides/SUPPORT.md)
- [Command reference](docs/reference/COMMANDS.md)
- [Workflow templates](docs/guides/WORKFLOW_TEMPLATES.md)
- [Skills and command projections](docs/reference/SKILLS.md)

Basic adoption:

```bash
bun add -D forge-workflow
bunx forge init --profile minimal --classification standard --harness codex --yes
bunx forge setup --agents codex --yes
bunx forge status --json
```

Use `forge init` when you want the `.forge/` runtime skeleton first. Use `forge setup` when you want Forge to install agent instructions, skills, Beads/GitHub sync scaffolding, or agent-specific files.

Use `bunx forge ...` in first-run examples. Bare `forge ...` works once the package bin is available on PATH, for example through your package manager or local script environment.

Setup flags used in existing repositories:

| Flag | Use |
| --- | --- |
| `--agents claude,cursor` | Select agents explicitly. |
| `--all` | Install all available agent harnesses. |
| `--quick` | Use defaults with minimal prompts. |
| `--yes` / `--non-interactive` | Run without prompts; `CI=true` also enables non-interactive behavior. |
| `--dry-run` | Preview planned writes. |
| `--sync` | Scaffold Beads/GitHub sync support. |
| `--symlink` | Create supported instruction links instead of copies where available. |
| `--merge smart\|preserve\|replace` | Choose how setup handles existing instruction files. |

## Common Commands

```bash
forge --help
forge setup --help
forge status --json
forge board --json
forge ready
forge show <issue-id>
forge claim <issue-id>
forge worktree create <slug> --branch <branch-name>
forge adapter list
bun run check
npm pack --dry-run
```

Stage commands such as `/review`, `/premerge`, and `/verify` are agent workflow stages, not currently standalone `forge review`, `forge premerge`, or `forge verify` CLI commands.

## Documentation Map

- [Docs index](docs/INDEX.md) - canonical reading order.
- [Migration guide](docs/guides/MIGRATION.md) - moving from older Forge versions and old workflow framing.
- [Workflow templates](docs/guides/WORKFLOW_TEMPLATES.md) - the default workflow, customization model, and live feature rollout path.
- [Skills and command projections](docs/reference/SKILLS.md) - current stage packaging across commands and skills.
- [Beads/GitHub sync](docs/guides/BEADS_GITHUB_SYNC.md) - issue lifecycle sync and recovery notes.
- [Adapters](docs/reference/ADAPTERS.md) - review adapter contract.
- [Templates](docs/reference/TEMPLATES.md) - adoption profiles and workflow templates.
- [Status and board](docs/reference/STATUS_BOARD.md) - local state surfaces.
- [Protected state surfaces](docs/reference/protected-state-surfaces.md) - protected path model and limits.
- [Release reference](docs/reference/RELEASE.md) - release validation and DeepWiki refresh checklist.

## DeepWiki

DeepWiki reads repository files such as `README.md`, `CHANGELOG.md`, `QUICKSTART.md`, `AGENTS.md`, `docs/**/*.md`, CLI files, and tests. Do not treat generated DeepWiki text as source of truth. After the v0.0.11 release lands on `master`, refresh DeepWiki and compare the generated Overview, Getting Started, and Core Concepts pages against these repository docs.

## Package

Package name: `forge-workflow`

Binary names:

- `forge`
- `forge-workflow`
- `forge-preflight`

## License

MIT
