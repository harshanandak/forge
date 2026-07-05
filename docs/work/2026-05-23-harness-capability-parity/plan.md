# Harness Capability Parity Design

Feature: harness-capability-parity
Issue: forge-wj36
Date: 2026-05-23
Status: implemented
Branch: codex/harness-capability-parity
Worktree: .worktrees/codex/harness-capability-parity

## Purpose

Define the parity foundation after the W0 skill metadata fixture. Forge needs one canonical capability model that can render to Claude, Cursor, and Codex without duplicating every feature blindly into every harness directory.

## Success Criteria

1. A machine-readable matrix covers Claude, Cursor, and Codex across instructions, skills, rules, MCP, hooks, commands, agents/subagents, stages/gates, Beads wiring, typed memory, patch overrides, marketplace trust, and extension packs.
2. Cursor skills and Cursor rules are modeled as separate surfaces: skills for on-demand workflows, rules for always-on or scoped policy.
3. Claude commands are recorded as compatibility shims over stage skills, not canonical workflow authority.
4. Default stages are represented as skills-first super skills with addressable subskills.
5. A renderer contract defines evidence required before any broad renderer is added.
6. User docs explain the mechanism and link to a machine-readable evidence command.

## Out Of Scope

- Do not implement broad harness renderers in this PR.
- Do not migrate checked-in Claude commands to skills yet.
- Do not claim live proprietary-agent invocation proof.
- Do not overhaul the full docs set.

## Research Summary

Claude Code documents `SKILL.md` files with `description` metadata for automatic loading and treats commands as compatible slash affordances. Codex documents the same core skill pattern, plus plugins and marketplaces for distribution. Cursor rules are `.mdc` policy/context files with `description`, `globs`, and `alwaysApply`; Forge records Cursor skills as the intended on-demand workflow surface and Cursor rules as the policy surface.

The pattern is a canonical payload plus native harness renderers, not one universal folder copied everywhere.

Sources used:

- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/agent-sdk/skills.md
- https://docs.cursor.com/en/context
- https://docs.cursor.com/context/model-context-protocol
- https://developers.openai.com/codex/skills
- https://developers.openai.com/codex/mcp
- https://developers.openai.com/codex/hooks
- https://developers.openai.com/codex/plugins/build
- https://agents.md/

## Approach Selected

Add a small contract module at `lib/harness-capability-matrix.js` and a JSON evidence CLI at `scripts/spikes/harness-capability-matrix.js`.

This keeps the PR bounded: it creates the matrix, stage graph, and renderer contract without generating new harness files. Future renderer PRs must consume this contract and add their own target-path/evidence tests.

## Edge Cases

- Unsupported harness surfaces must be explicit known issues, not silent omissions.
- Cursor hooks remain unsupported until verified.
- Cursor Agent Skills are not proven by the W0 rule fixture; the matrix distinguishes intended target from proven fixture target.
- Codex commands fall back to skills rather than undocumented prompt/slash files.

## Ambiguity Policy

Use the `/dev` 7-dimension rubric. Proceed without user input only for local contract naming or wording that does not affect public APIs, persistent data, security, or broad renderer behavior.

## OWASP Notes

This PR adds static metadata and a read-only JSON evidence CLI. It does not execute untrusted code, process credentials, or open network connections at runtime. Relevant risk is A08 software/data integrity: mitigated by tests requiring known unsupported surfaces and renderer evidence before broad generation.

## TDD Scenarios

1. Happy path: matrix covers all target harnesses and required capability IDs.
2. Edge path: Cursor skills and rules remain separate surfaces.
3. Known-issue path: unsupported/unproven surfaces are recorded explicitly.
4. Stage graph path: each default stage renders as a super skill with subskills and Claude command shim.
5. Evidence path: CLI prints JSON containing matrix, stage graph, renderer contract, and sources.
