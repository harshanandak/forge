# Cross-Harness Skill Parity Tasks

Feature: cross-harness-skill-parity
Issue: forge-2si5

## Task 1: Lock Codex target to `.codex/skills`

TDD:
1. Update `test/w0-harness-parity.test.js` to expect `.codex/skills/<name>/SKILL.md`.
2. Run the focused test and confirm failure against the current `.agents/skills` target.
3. Update `scripts/spikes/skill-auto-invoke-parity.js`.

## Task 2: Add machine-readable evidence labels

TDD:
1. Add focused test assertions for source/evidence labels in every harness result.
2. Run focused test and confirm failure.
3. Add labels and proof-boundary metadata to the script output.

## Task 3: Add user docs section

TDD:
1. Add a test assertion that the docs index links to the new parity page.
2. Run the focused docs test and confirm failure.
3. Add `docs/reference/AGENT_SKILL_PARITY.md` and the minimal `docs/INDEX.md` link.

## Validation Plan

1. `bun test test/w0-harness-parity.test.js test/docs-consistency.test.js`
2. `node scripts/spikes/skill-auto-invoke-parity.js --json`
3. `bun run check`