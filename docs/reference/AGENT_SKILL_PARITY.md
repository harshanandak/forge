# Agent Skill Parity

Forge treats cross-agent skill compatibility as one canonical capability rendered into each harness's native activation surface.

This page documents the W0 metadata fixture only. It is not the full Forge extension parity model.

## Supported Surfaces

| Harness | Forge fixture path | Activation metadata | Proof status |
| --- | --- | --- | --- |
| Claude Code | `.claude/skills/<name>/SKILL.md` | `description` in `SKILL.md` frontmatter | Proven by metadata fixture |
| Cursor | `.cursor/rules/<name>.mdc` | `description`, blank `globs`, `alwaysApply: false` | Proven by metadata fixture |
| Codex CLI | `.codex/skills/<name>/SKILL.md` | `name` and `description` in `SKILL.md` frontmatter | Proven by metadata fixture and Forge packaging helper |

The shared rule is: keep the skill name, description, and task body canonical, then generate the smallest native wrapper each harness needs.

Cursor rules are included here because `forge-2si5` explicitly asked for `.cursor/rules/*.mdc` evidence. They are not the final Cursor skill target. The broader parity model must treat Cursor Agent Skills as the primary on-demand workflow surface and Cursor rules as the always-on or scoped-policy surface.

## Required Follow-Up: Skills-First Stage Graph

Tracked as `forge-wj36`.

Forge stage parity should become skills-first across Claude, Cursor, and Codex:

| Forge stage | Canonical surface | Claude render | Cursor render | Codex render |
| --- | --- | --- | --- | --- |
| `status` | super skill with subskills | `.claude/skills/status/SKILL.md` plus command shim | `.cursor/skills/status/SKILL.md` | `.codex/skills/status/SKILL.md` |
| `plan` | super skill with phases | `.claude/skills/plan/SKILL.md` plus command shim | `.cursor/skills/plan/SKILL.md` | `.codex/skills/plan/SKILL.md` |
| `dev` | super skill with TDD subskills | `.claude/skills/dev/SKILL.md` plus command shim | `.cursor/skills/dev/SKILL.md` | `.codex/skills/dev/SKILL.md` |
| `validate` | super skill with check subskills | `.claude/skills/validate/SKILL.md` plus command shim | `.cursor/skills/validate/SKILL.md` | `.codex/skills/validate/SKILL.md` |
| `ship` | super skill with PR subskills | `.claude/skills/ship/SKILL.md` plus command shim | `.cursor/skills/ship/SKILL.md` | `.codex/skills/ship/SKILL.md` |
| `review` | super skill with feedback subskills | `.claude/skills/review/SKILL.md` plus command shim | `.cursor/skills/review/SKILL.md` | `.codex/skills/review/SKILL.md` |
| `premerge` | super skill with readiness subskills | `.claude/skills/premerge/SKILL.md` plus command shim | `.cursor/skills/premerge/SKILL.md` | `.codex/skills/premerge/SKILL.md` |
| `verify` | super skill with post-merge subskills | `.claude/skills/verify/SKILL.md` plus command shim | `.cursor/skills/verify/SKILL.md` | `.codex/skills/verify/SKILL.md` |

Claude commands should become compatibility shims, not the workflow authority. The canonical workflow should live in stage skills and subskills.

The super-skill structure should follow the same pattern as rich local skills such as `impeccable`: one top-level skill handles routing and context, while individual subskills or references handle specific phases. For Forge, that means examples like:

```text
plan/
  SKILL.md
  phases/
    intent_capture/SKILL.md
    research/SKILL.md
    critics/SKILL.md
    synthesis/SKILL.md
    final_lock/SKILL.md
```

## Full Extension Parity Scope

The full Forge extension parity model must cover more than skills:

| Capability | Canonical Forge source | Claude | Cursor | Codex | Required evidence |
| --- | --- | --- | --- | --- | --- |
| Project instructions | structured `AGENTS.md` sections | `CLAUDE.md` shim or generated file | `.cursor/rules/*.mdc` for scoped policy | `AGENTS.md` | semantic section comparison |
| Skills/playbooks | agentskills.io-compatible `SKILL.md` | `.claude/skills` | `.cursor/skills` | `.codex/skills` | generated file and trigger metadata |
| Rules/policies | Forge rule manifest | `CLAUDE.md` or `.claude/rules` if supported | `.cursor/rules/*.mdc` | `AGENTS.md` section | rule target and unsupported-surface notes |
| MCP tools/resources | Forge MCP manifest | Claude MCP config | Cursor MCP config | Codex MCP config | config render and server probe |
| Hooks | Forge hook manifest | Claude hook adapter if supported | unsupported unless verified | Codex hook adapter if supported | supported/unsupported matrix |
| Commands | Forge command shim manifest | `.claude/commands` thin shims | native command surface if supported | CLI docs or skill fallback | shim points to canonical skill |
| Agents/subagents | Forge agent role spec | Claude subagents | Cursor agent/subagent config if supported | Codex skill/agent fallback | role mapping or known issue |
| Marketplace/extensions | `extension.yaml` plus lock metadata | plugin/skills/commands/hooks | skills/rules/MCP config | skills/MCP/hooks | lockfile, SHA, trust, generated targets |

The next implementation should start with a machine-readable harness capability matrix and renderer contract before adding more generated files.

## Evidence Command

Run the parity fixture from the repository root:

```bash
node scripts/spikes/skill-auto-invoke-parity.js --json
```

The JSON output includes:

- `harnesses[].passed`
- `harnesses[].target`
- `harnesses[].sourceLabel`
- `sources[]`
- `proofBoundary`
- `knownIssues[]`

## Proof Boundary

This fixture proves deterministic metadata-surface parity. It does not launch closed-source agent sessions or claim that a live model selected a skill in a proprietary runtime.

If a future release needs live invocation proof, add a separate transcript-producing eval for Claude Code, Cursor, and Codex and keep this fixture as the fast CI gate.

## Known Issues

No harness-specific metadata issue is known for this fixture. Live proprietary-agent auto-invocation is intentionally outside this deterministic test and is reported in `proofBoundary`.

Known gaps intentionally left for follow-up:

- Cursor Agent Skills are not proven in this W0 fixture; Cursor rules were the requested target for `forge-2si5`.
- Claude still has command-first stage distribution in the current Forge setup; this must move to skills-first with commands as shims.
- MCPs, hooks, stage/gate renderers, Beads wiring, typed memory, patch overrides, marketplace trust, and extension packs are not covered by this fixture.
