# Cross-Harness Skill Parity Decisions

## Decision 1

**Date**: 2026-05-23
**Task**: Plan
**Gap**: The previous W0 spike used `.agents/skills`, but the current task explicitly requires `.codex/skills` and the repo already has `.codex/skills` packaging helpers.
**Score**: 2/14
**Route**: PROCEED
**Choice made**: Use `.codex/skills/<name>/SKILL.md` in the fixture, with docs noting that Forge installs those packaged skills to `$CODEX_HOME/skills` for Codex discovery.
**Status**: RESOLVED