## Description
Plan Hermes integration as a consumer/provider of Forge project state, not a competing memory system.

## Scope
- Hermes receives bounded `forge orient` / `forge recap` context.
- Hermes native memory and skills remain private/agent-native.
- Forge records project evidence, decisions, and workflow state through Kernel APIs.
- Avoid writing directly into Hermes profile memory from Forge.

## Acceptance Criteria
- Hermes harness plan depends on Knowledge Layer outputs.
- Docs clarify Forge vs Hermes memory boundaries.
- Future `hermes.plugin.json` and SKILL.md templates point to Forge commands as project-state authority.
