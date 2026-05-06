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
4. Cursor target verification checks `.cursor/rules/*.mdc` with documented frontmatter fields: `description`, `globs`, and `alwaysApply`.
5. Codex target verification checks `.codex/skills/<skill>/SKILL.md` or documented instruction surfaces, not undocumented slash prompt files.
6. The script reports pass/fail per harness and exits non-zero when any required harness fails.
7. If only two of three harnesses are feasible, docs name the known issue and tie it to D38 kill criteria.
8. Validation includes a repeatable test plus a direct script run.

## Out Of Scope

- Do not implement migration dry-run logic in this PR.
- Do not add or rely on undocumented Codex slash prompt directories.
- Do not attempt live agent invocation against proprietary CLIs; the W0 fixture validates file-surface parity and documented discoverability inputs.
- Do not redesign the full v3 harness translator.
- Do not modify unrelated Beads bootstrap or issue-command recovery logic as part of this PR.

## Approach Selected

Build a deterministic Node/Bun script at `scripts/spikes/skill-auto-invoke-parity.js` that creates an isolated temporary fixture, writes one equivalent skill/rule target per harness, validates the generated files, and prints a JSON summary. Add `test/w0-harness-parity.test.js` to assert pass/fail behavior and guard the Codex no-slash-prompt constraint.

This keeps the W0 evidence executable, small, and independent of full Forge install flows while still testing the target surfaces identified by the upstream spike.

## Constraints

- Use the existing Bun test runner from `package.json`.
- Keep output machine-readable enough for CI and human-readable enough for Wave 0 evidence.
- Use primary-source evidence already captured in `docs/work/2026-05-05-w0-verification-spikes/evidence.md`.
- Keep the feature scoped to clean-fixture parity; no migration dry-run work.
- Preserve unrelated dirty work in this worktree.

## Edge Cases

- Cursor rules must include `globs` and `description`; `alwaysApply` should be false for description/requested behavior.
- Codex parity must fail if the fixture tries to create `.codex/prompts` or slash-command prompt files.
- A missing target file for any harness must produce a failed harness result, not a partial success.
- If the Codex documented surface changes later, update the fixture and evidence together.

## Ambiguity Policy

During `/dev`, use the 7-dimension decision rubric. If implementation confidence is at least 80 percent, proceed and document the decision in `decisions.md`. Below 80 percent, stop and ask. Any proposed use of undocumented CLI prompt directories is below threshold and must be rejected unless new primary-source evidence is added.

## Technical Research

Source label S1: `docs/work/2026-05-05-w0-verification-spikes/evidence.md` records Cursor project rules as `.cursor/rules/*.mdc` with `description`, `globs`, and `alwaysApply`.

Source label S2: the same evidence records that Cursor `AGENTS.md` is plain markdown without the metadata needed for description-match parity, so the parity fixture should target `.cursor/rules/*.mdc`.

Source label S3: the same evidence records that OpenAI documents built-in Codex CLI slash commands but not a stable user-authored slash prompt directory. Codex parity must target `.codex/skills/<name>/SKILL.md` or documented instructions.

Source label S4: the existing repo already stores Codex skills under `.codex/skills/<name>/SKILL.md`, so the fixture should mirror that local surface.

Source label S5: `forge-2si5` in `.beads/issues.jsonl` defines the W0 NO-GO target and D38 kill criteria link.

## OWASP Notes

This fixture does not process untrusted network input, credentials, authentication state, or production data. The relevant risk is A08 software/data integrity: the script must write only inside a temporary fixture and must not mutate user harness directories. Mitigation: use a temporary directory, explicit path validation, and tests that assert generated paths remain under the fixture root.

## TDD Scenarios

1. Happy path: generating the default fixture returns pass for Claude, Cursor, and Codex and prints all three harness summaries.
2. Failure path: deleting one generated target file produces a failed result for that harness and a non-zero validation result.
3. Edge path: Codex target generation must not create `.codex/prompts` or slash-command prompt files.
