# Forge Documentation Index

This is the canonical map for Forge documentation. DeepWiki and other generated views should be checked against these files after they re-index the repository.

## Start Here

- [README](../README.md) - product positioning, ready-now features, limits, and DeepWiki note.
- [Quickstart](../QUICKSTART.md) - first install, `forge init`, `forge setup`, status, worktrees, and validation.
- [Setup guide](guides/SETUP.md) - install and adoption options for supported agents.
- [Workflow templates](guides/WORKFLOW_TEMPLATES.md) - the default workflow as a core template, customization model, and live rollout rules.
- [Support guide](guides/SUPPORT.md) - FAQ, troubleshooting, recovery, known limits, branch protection, worktrees, and Beads/Dolt notes.

## Tutorials

- [Quickstart](../QUICKSTART.md) - fastest path to a working local Forge install.
- [Enhanced onboarding](guides/ENHANCED_ONBOARDING.md) - broader setup and onboarding flow.

## How-To Guides

- [Setup](guides/SETUP.md) - install package, initialize runtime config, install agent instructions.
- [Migration](guides/MIGRATION.md) - move from older Forge versions and old stage-only framing.
- [Workflow templates](guides/WORKFLOW_TEMPLATES.md) - understand the default template and how customization should be documented.
- [Beads/GitHub sync](guides/BEADS_GITHUB_SYNC.md) - configure and recover issue sync.
- [Manual review guide](guides/MANUAL_REVIEW_GUIDE.md) - process PR feedback without inventing CLI commands.
- [Greptile setup](guides/GREPTILE_SETUP.md) - optional review integration.
- [Agent install prompt](guides/AGENT_INSTALL_PROMPT.md) - reusable prompt for agent installation.

## Reference

- [Command reference](reference/COMMANDS.md) - verified `forge` CLI commands and package binaries.
- [Skills and command projections](reference/SKILLS.md) - current stage packaging across skills, commands, prompts, and harness projections.
- [Release reference](reference/RELEASE.md) - validation, packaging, release handoff, and DeepWiki checklist.
- [Forge Kernel storage model](reference/FORGE_KERNEL_STORAGE_MODEL.md) - authority/cache/projection/archive storage rules for local and team modes.
- [Forge Kernel schema and migrations](reference/forge-kernel-schema.md) - 0.0.20 schema registry, migration, and storage-class contracts.
- [Beads to Kernel migration UX](reference/beads-to-kernel-migration-ux.md) - import/export compatibility, rollback boundaries, and conflict quarantine handoff.
- [Decision drift guards](reference/DECISION_DRIFT_GUARDS.md) - evaluator checklist and required doc updates for Kernel-era architecture changes.
- [Kernel conflict evaluators](reference/kernel-conflict-evaluators.md) - conflict quarantine, idempotency, duplicate write dedupe, dependency-cycle, and projection ordering contract.
- [Toolchain](reference/TOOLCHAIN.md) - Bun, Node, Git, GitHub CLI, Beads, shell, and MCP conventions.
- [Validation](reference/VALIDATION.md) - `bun run check`, failure meanings, and recovery.
- [Templates](reference/TEMPLATES.md) - adoption profiles and the default workflow template.
- [Adapters](reference/ADAPTERS.md) - issue and review adapter contracts.
- [Status and board](reference/STATUS_BOARD.md) - local runtime state surfaces.
- [Agent skill parity](reference/AGENT_SKILL_PARITY.md) - cross-harness skill metadata parity surfaces, evidence command, and proof boundary.
- [Protected state surfaces](reference/protected-state-surfaces.md) - protected-path model, enforcement limits, and repair hints.
- [Protected path manifest](reference/PROTECTED_PATH_MANIFEST.md) - protected path manifest schema, harness enforcement mapping, and evidence command.
- [Patch format](reference/patch-md-format.md) - `.forge/patch.md` conventions.
- [Upgrade safety](reference/upgrade-safety.md) - trust policy and rollback limits.
- [Insights and recap](reference/INSIGHTS_RECAP.md) - `forge insights` and `forge recap` evidence sources, output, and limitations.
- [Examples](reference/EXAMPLES.md) - worked examples.
- [Test environment](reference/test-environment.md) - test harness notes.
- [Agent permissions](reference/agent-permissions.md) - agent permission model.
- [Dependency chain](reference/dependency-chain.md) - historical dependency-chain notes.
- [Research template](reference/RESEARCH_TEMPLATE.md) - research artifact template.

## Advanced And Historical Context

The links below are for maintainers and architecture readers. They are not part of the normal getting-started path and may contain historical design labels.

- [Runtime building-block refinement](work/2026-04-28-skeleton-pivot/runtime-building-blocks-refinement.md) - advanced architecture direction: runtime primitives, evaluator regions, and templates as scaffolds.
- [Locked decisions](work/2026-04-28-skeleton-pivot/locked-decisions.md) - historical decision ledger.
- [Release plan](work/2026-04-28-skeleton-pivot/release-plan.md) - internal release phasing. Internal labels are not npm package versions.
- [Forge Kernel authority control plane](work/2026-04-28-skeleton-pivot/forge-kernel-authority-control-plane.md) - current authority reset plan: Forge-native issue kernel, local broker, Cloudflare team authority, and Beads as import/export adapter.
- [Beads/Supabase and Forge memory design](work/2026-04-28-skeleton-pivot/beads-supabase-and-forge-memory-design.md) - Beads coexistence analysis.

## Historical Or Superseded Material

The [docs/work archive](work/README.md) contains planning artifacts, decisions, and historical research. These files are useful context, but public user guidance should prefer the start-here, how-to, and reference files above.

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
