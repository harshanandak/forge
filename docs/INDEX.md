# Forge Documentation Index

This is the canonical map for Forge documentation. DeepWiki and other generated views should be checked against these files after they re-index the repository.

## Start Here

- [README](../README.md) - product positioning, ready-now features, limits, and DeepWiki note.
- [Quickstart](../QUICKSTART.md) - first install, `forge init`, `forge setup`, status, worktrees, and validation.
- [Setup guide](guides/SETUP.md) - install and adoption options for supported agents.
- [Support guide](guides/SUPPORT.md) - FAQ, troubleshooting, recovery, known limits, branch protection, worktrees, and Beads/Dolt notes.

## Tutorials

- [Quickstart](../QUICKSTART.md) - fastest path to a working local Forge install.
- [Enhanced onboarding](guides/ENHANCED_ONBOARDING.md) - broader setup and onboarding flow.

## How-To Guides

- [Setup](guides/SETUP.md) - install package, initialize runtime config, install agent instructions.
- [Migration](guides/MIGRATION.md) - move from older Forge versions and old stage-only framing.
- [Beads/GitHub sync](guides/BEADS_GITHUB_SYNC.md) - configure and recover issue sync.
- [Manual review guide](guides/MANUAL_REVIEW_GUIDE.md) - process PR feedback without inventing CLI commands.
- [Greptile setup](guides/GREPTILE_SETUP.md) - optional review integration.
- [Agent install prompt](guides/AGENT_INSTALL_PROMPT.md) - reusable prompt for agent installation.

## Reference

- [Command reference](reference/COMMANDS.md) - verified CLI and stage command boundaries.
- [Release reference](reference/RELEASE.md) - validation, packaging, release handoff, and DeepWiki checklist.
- [Toolchain](reference/TOOLCHAIN.md) - Bun, Node, Git, GitHub CLI, Beads, shell, and MCP conventions.
- [Validation](reference/VALIDATION.md) - `bun run check`, failure meanings, and recovery.
- [Templates](reference/TEMPLATES.md) - adoption profiles and the default workflow template.
- [Adapters](reference/ADAPTERS.md) - issue and review adapter contracts.
- [Status and board](reference/STATUS_BOARD.md) - local runtime state surfaces.
- [Protected state surfaces](reference/protected-state-surfaces.md) - protected-path model, enforcement limits, and repair hints.
- [Patch format](reference/patch-md-format.md) - `.forge/patch.md` conventions.
- [Upgrade safety](reference/upgrade-safety.md) - trust policy and rollback limits.
- [Examples](reference/EXAMPLES.md) - worked examples.
- [Test environment](reference/test-environment.md) - test harness notes.
- [Agent permissions](reference/agent-permissions.md) - agent permission model.
- [Dependency chain](reference/dependency-chain.md) - historical dependency-chain notes.
- [Research template](reference/RESEARCH_TEMPLATE.md) - research artifact template.

## Explanation And Architecture

- [Runtime building-block refinement](work/2026-04-28-skeleton-pivot/runtime-building-blocks-refinement.md) - current architecture direction: runtime primitives, evaluator regions, and templates as scaffolds.
- [Locked decisions](work/2026-04-28-skeleton-pivot/locked-decisions.md) - historical decision ledger.
- [Release plan](work/2026-04-28-skeleton-pivot/release-plan.md) - internal release phasing. Internal labels are not npm package versions.
- [Beads/Supabase and Forge memory design](work/2026-04-28-skeleton-pivot/beads-supabase-and-forge-memory-design.md) - Beads coexistence analysis.

## Historical Or Superseded Material

The `docs/work/**` tree contains planning artifacts, decisions, and historical research. These files are useful context, but public user guidance should prefer the start-here, how-to, and reference files above.

Historical references that should not be treated as current release instructions:

- [Roadmap](reference/ROADMAP.md) - historical roadmap snapshot.
- [Superpowers analysis](reference/superpowers-analysis.md) - historical analysis.
- [Superpowers integration options](reference/superpowers-integration-options.md) - historical options.
- `docs/work/2026-04-28-skeleton-pivot/*v3*` files - `v3` is an internal/historical codename, not a public package version.

## Consumer-Installed Docs

`docs/forge/` contains documentation copied into consumer repositories by `forge setup`. Keep these files aligned with the matching `docs/reference/` files because setup and reset code reference them.

## Work Artifacts

New `/plan` artifacts live under:

```text
docs/work/YYYY-MM-DD-<slug>/
```

Each work folder should contain design, tasks, decisions, and supporting evidence when applicable.
