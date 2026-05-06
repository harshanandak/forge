# W0 Harness Parity Decisions

Feature: w0-harness-parity
Issue: forge-2si5
Date: 2026-05-06

## D1: Parity tests file surfaces, not live proprietary invocation

Decision: the W0 fixture validates equivalent description-match file surfaces in a clean fixture and reports pass/fail per harness. It does not attempt to drive live Claude, Cursor, or Codex agent sessions.

Rationale: forge-2si5 asks for a repeatable clean-fixture test or script. Live harness invocation would add nondeterminism and credentials/tooling dependencies that are not needed to prove the target file contracts.

## D2: Cursor target is `.cursor/rules/*.mdc`

Decision: Cursor parity uses `.cursor/rules/<skill>.mdc` with frontmatter fields `description`, `globs`, and `alwaysApply: false`.

Rationale: `docs/work/2026-05-05-w0-verification-spikes/evidence.md` records Cursor project rules and metadata as the documented target. Root `AGENTS.md` lacks the metadata needed for description-match parity. Current Cursor rules documentation separates description-driven Agent Requested rules from glob-driven Auto Attached rules, so `globs` stays blank for this fixture.

## D3: Codex target is `.agents/skills/<name>/SKILL.md`

Decision: Codex parity uses Codex skills/instructions and explicitly rejects undocumented slash prompt files.

Rationale: the Wave 0 verification spike found no primary-source support for a stable user-authored Codex slash prompt directory. Current OpenAI Codex skills documentation identifies `.agents/skills` as the repository skill location, so this fixture must use `.agents/skills/<name>/SKILL.md` rather than the repo-local `.codex/skills` convention used for this Codex session's own skill discovery.

## D4: Migration dry-run is out of scope

Decision: this PR must not implement migration dry-run logic.

Rationale: the user explicitly excluded migration dry-run work from forge-2si5, and a separate `codex/w0-migrate-dry-run` worktree already exists.

## D5: Baseline full-suite status is not green

Decision: record the full-suite baseline as timed out in planning and prioritize the targeted W0 parity validation in `/dev`.

Rationale: `bun test --timeout 15000` was attempted during planning on 2026-05-06 and did not return within 120 seconds. Treating it as green would be unverified.

## D6: Skills are primary; commands are secondary

Decision: Forge models reusable cross-harness behavior as skills first. The parity fixture records explicit slash invocation for the canonical skill name across Claude, Cursor, and Codex, while command files remain compatibility or shim surfaces rather than the canonical implementation.

Rationale: the supported harnesses can invoke the intended capability as a skill by slash. Optimizing around commands would make a secondary surface the abstraction, which weakens description-match auto invocation and skill lifecycle work.
