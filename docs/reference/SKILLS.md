# Skills And Command Projections

Forge uses both skills and command files today. They are related, but they are not the same surface.

## Current v0.0.11 Reality

- Codex stage workflows are packaged as `.codex/skills/<stage>/SKILL.md`.
- Claude Code and Cursor receive command projections. Forge currently supports Claude Code, Codex, and Cursor; Hermes support is planned.
- `scripts/check-agents.js` currently treats Codex as the exception where command capability is satisfied through `.codex/skills/`.
- `test/agent-gaps.test.js` still asserts `.claude/commands/` as the current canonical sync source for command projection checks.

That means `docs/reference/COMMANDS.md` should remain the CLI command reference. It should not be renamed into a skills reference until the source, sync script, tests, and package contents move together.

## Product Direction

The intended direction is skills-first agent packaging:

- Stage behavior becomes portable `SKILL.md` packages.
- Command files become harness-specific projections or compatibility aliases.
- `skills sync` and Forge setup project the same stage behavior into each supported harness.
- Extension manifests can contribute stages, substages, evaluator regions, adapters, hooks, and evidence collectors.

This direction is documented as roadmap material until the implementation and tests make it current behavior.

## Documentation Rule

Use these names consistently:

- Command reference: current `forge` CLI commands and package binaries.
- Workflow templates: default stage paths and customization rules.
- Skills: agent-facing stage packages and future portable extension units.
- Harness projections: generated command, prompt, workflow, or skill files for a specific agent.

Do not claim that commands have fully moved to skills until source, tests, generated files, and package contents prove that migration.

