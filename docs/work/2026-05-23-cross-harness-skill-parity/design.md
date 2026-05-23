# Cross-Harness Skill Parity Design

Feature: cross-harness-skill-parity
Issue: forge-2si5
Date: 2026-05-23
Status: planned
Branch: codex/cross-harness-skill-parity
Worktree: .worktrees/codex/cross-harness-skill-parity

## Purpose

Prove the smallest shared skill auto-invoke contract Forge can depend on across Claude Code, Cursor, and Codex surfaces. The user-facing outcome is machine-readable evidence plus a stable docs page the broader docs overhaul can link to.

## Success Criteria

1. A clean fixture writes the same canonical skill name, description, and body to `.claude/skills/<name>/SKILL.md`, `.cursor/rules/<name>.mdc`, and `.codex/skills/<name>/SKILL.md`.
2. The parity checker returns JSON with pass/fail state, source labels, explicit invocation affordance, and any known issues.
3. Cursor uses project-rule frontmatter with `description`, `globs`, and `alwaysApply`.
4. Codex uses the Forge-supported `.codex/skills` packaging surface already consumed by `lib/codex-skills.js`.
5. A focused test covers happy path, non-empty fixture refusal, positive/negative description matching, Cursor metadata, Codex target location, and CLI JSON output.
6. A user docs section explains the compatibility pattern and the proof boundary.
7. Machine-readable evidence is committed at `docs/work/2026-05-23-cross-harness-skill-parity/evidence.json`.

## Out Of Scope

- No broad docs overhaul.
- No migration dry-run or full harness translator.
- No live proprietary-agent execution automation.

## Research Summary

The compatibility pattern used by the ecosystem is not one magic universal file for every feature. It is a canonical instruction payload rendered into each harness's native activation metadata:

- Agent Skills define the common shape: a folder with `SKILL.md`, `name`, `description`, and on-demand activation by description match.
- Claude Code supports project skills at `.claude/skills/<skill>/SKILL.md`; the description is used for automatic selection, and `/skill-name` remains an explicit affordance.
- Cursor project rules live under `.cursor/rules` as `.mdc` files. `Agent Requested` rules are description-driven, while `globs` are for file attachment.
- Codex packaged skills in this repo are sourced from `.codex/skills` and installed to `$CODEX_HOME/skills` by Forge. Codex's skill metadata uses `name` and `description` to decide when a skill gets used.
- AWS's Agent Toolkit documents the same adapter approach for project rules: copy the same guidance into the agent-specific file location, using Cursor `.mdc` where Cursor needs metadata.

## Approach

Adapt the existing W0 fixture instead of adding a separate harness. The script remains deterministic and local, but its output becomes the machine-readable evidence artifact. It proves metadata-surface parity, not a live model decision inside closed-source agents.

If future work needs live proof, it should add a separate eval that launches the three tools and stores transcripts. This PR documents that as a proof boundary rather than pretending the local fixture proves proprietary model behavior.

## Validation

Run:

1. `bun test test/w0-harness-parity.test.js`
2. `node scripts/spikes/skill-auto-invoke-parity.js --json`
3. `bun run check`