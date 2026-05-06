# W0 Harness Parity Fixture Design

Feature: w0-harness-parity
Issue: forge-2si5
Date: 2026-05-06
Status: planned
Branch: codex/w0-harness-parity
Worktree: .worktrees/codex/w0-harness-parity

## Purpose

Wave 0 needs an empirical fixture that verifies whether the same skill description-match contract can be represented across the three target harness surfaces: Claude Code, Cursor, and Codex CLI. This is a W0 NO-GO check because forge-2si5 says failure triggers D38 kill criteria (c).

## Success Criteria

1. A clean temporary fixture is generated without mutating the repository root.
2. The fixture emits the same intent text and skill description text for Claude, Cursor, and Codex targets.
3. Claude target verification checks `.claude/skills/<skill>/SKILL.md` and its description metadata.
4. Cursor target verification checks `.cursor/rules/*.mdc` with documented frontmatter fields: `description`, blank `globs`, and `alwaysApply: false`.
5. Codex target verification checks the documented repository Agent Skills path `.agents/skills/<skill>/SKILL.md`, not undocumented slash prompt files.
6. The fixture reports explicit slash invocation for the canonical skill name on all three harnesses.
7. The script reports pass/fail per harness and exits non-zero when any required harness fails.
8. If only two of three harnesses are feasible, docs name the known issue and tie it to D38 kill criteria.
9. Validation includes a repeatable test plus a direct script run.

## Out Of Scope

- Do not implement migration dry-run logic in this PR.
- Do not add or rely on undocumented Codex slash prompt directories.
- Do not attempt live agent invocation against proprietary CLIs; the W0 fixture validates file-surface parity, description-match inputs, and explicit slash invocation affordances.
- Do not redesign the full v3 harness translator.
- Do not modify unrelated Beads bootstrap or issue-command recovery logic as part of this PR.

## Approach Selected

Build a deterministic Node/Bun script at `scripts/spikes/skill-auto-invoke-parity.js` that creates an isolated temporary fixture, writes one equivalent skill/rule target per harness, validates the generated files, reports explicit slash invocation for the canonical skill name, and prints a JSON summary. Add `test/w0-harness-parity.test.js` to assert pass/fail behavior, explicit invocation parity, and the Codex no-slash-prompt constraint.

This keeps the W0 evidence executable, small, and independent of full Forge install flows while still testing the target surfaces identified by the upstream spike.

## Constraints

- Use the existing Bun test runner from `package.json`.
- Keep output machine-readable enough for CI and human-readable enough for Wave 0 evidence.
- Use primary-source evidence already captured in `docs/work/2026-05-05-w0-verification-spikes/evidence.md`.
- Keep the feature scoped to clean-fixture parity; no migration dry-run work.
- Preserve unrelated dirty work in this worktree.

## Edge Cases

- Cursor rules must include `description`, blank `globs`, and `alwaysApply: false` for Agent Requested description behavior. A broad `**/*` glob would test file auto-attachment more than description matching.
- Codex parity must fail if the fixture tries to create prompt/slash-command files instead of `.agents/skills`.
- A missing target file for any harness must produce a failed harness result, not a partial success.
- If the Codex documented surface changes later, update the fixture and evidence together.

## Ambiguity Policy

During `/dev`, use the 7-dimension decision rubric. If implementation confidence is at least 80 percent, proceed and document the decision in `decisions.md`. Below 80 percent, stop and ask. Any proposed use of undocumented CLI prompt directories is below threshold and must be rejected unless new primary-source evidence is added.

## Technical Research

Source label S1: `docs/work/2026-05-05-w0-verification-spikes/evidence.md` records Cursor project rules as `.cursor/rules/*.mdc` with `description`, `globs`, and `alwaysApply`.

Source label S2: the same evidence records that Cursor `AGENTS.md` is plain markdown without the metadata needed for description-match parity, so the parity fixture should target `.cursor/rules/*.mdc`.

Source label S2b: current Cursor rules documentation identifies Agent Requested rules as description-driven and Auto Attached rules as glob-driven, so this fixture leaves `globs` blank instead of using `**/*`.

Source label S3: the Wave 0 verification spike records that OpenAI documented built-in Codex CLI slash commands but not a stable user-authored slash prompt directory.

Source label S4: current OpenAI Codex skills documentation states that a manual skill is a folder with a `SKILL.md` file and that repository skills are read from `.agents/skills` directories from the current working directory up to the repository root. The fixture must therefore use `.agents/skills/<name>/SKILL.md`.

Source label S5: OpenAI Codex AGENTS.md documentation remains relevant for persistent instructions, but AGENTS.md is not a description-match skill surface.

Source label S6: `forge-2si5` in `.beads/issues.jsonl` defines the W0 NO-GO target and D38 kill criteria link.

Source label S7: user-tested harness behavior confirms all three supported targets expose explicit slash invocation for the canonical skill name. Commands remain secondary; Forge should model explicit invocation as a skill affordance, not as the canonical implementation.

## OWASP Notes

This fixture does not process untrusted network input, credentials, authentication state, or production data. The relevant risk is A08 software/data integrity: the script must write only inside a temporary fixture and must not mutate user harness directories. Mitigation: use a temporary directory, explicit path validation, and tests that assert generated paths remain under the fixture root.

## TDD Scenarios

1. Happy path: generating the default fixture returns pass for Claude, Cursor, and Codex and prints all three harness summaries.
2. Failure path: deleting one generated target file produces a failed result for that harness and a non-zero validation result.
3. Edge path: Codex target generation must not create prompt/slash-command files and must use `.agents/skills/<name>/SKILL.md`.
4. Explicit invocation path: every harness reports `/<skill-name>` for the canonical skill, while commands remain secondary compatibility surfaces.
