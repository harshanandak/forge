# Agent Skill Parity

Forge treats cross-agent skill compatibility as one canonical capability rendered into each harness's native activation surface.

This page documents the W0 metadata fixture only. It is not the full Forge extension parity model.

For Week 3 planning, see [Week 3 Runtime Capability Packs](../work/2026-04-28-skeleton-pivot/week-3-runtime-capability-packs.md). That plan defines replaceable workflow packs, on-demand skill loading through MCP, runtime-enforced required skill policies, and per-project workflow composition.

## Supported Surfaces

Forge supports Claude Code, Codex, Cursor, and Hermes. Hermes is a **CLI-consumed**
harness: it reads Forge project state through `forge orient` / `forge recap` and
ships the `hermes-forge` skill (`.hermes/skills`), rather than consuming generated
rule/MCP/hook files. The W0 metadata fixture below proves the file-surface metadata
for Claude Code, Cursor, and Codex; Hermes is modeled in the capability matrix
(`lib/harness-capability-matrix.js`) as CLI-consumed.

| Harness | Forge fixture path | Activation metadata | Proof status |
| --- | --- | --- | --- |
| Claude Code | `.claude/skills/<name>/SKILL.md` | `description` in `SKILL.md` frontmatter | Proven by metadata fixture |
| Cursor | `.cursor/rules/<name>.mdc` | `description`, blank `globs`, `alwaysApply: false` | Proven by metadata fixture |
| Codex CLI | `.codex/skills/<name>/SKILL.md` | `name` and `description` in `SKILL.md` frontmatter | Proven by metadata fixture and Forge packaging helper |
| Hermes | `.hermes/skills/<name>/SKILL.md` | `name` and `description` in `SKILL.md` frontmatter | CLI-consumed (forge orient/recap); not part of the W0 file-metadata fixture |

The shared rule is: keep the skill name, description, and task body canonical, then generate the smallest native wrapper each harness needs.

For Codex, this W0 fixture validates Forge's repository packaging surface (`.codex/skills`) plus the metadata needed for installed Codex skills. Codex's documented repo-scope discovery path is `.agents/skills` (scanned cwd → repo root); Forge now generates that mirror at setup and commits it, so a teammate who clones the repo WITHOUT running `forge setup` still gets Forge skills/stages auto-discovered.

Cursor rules are included here because `forge-2si5` explicitly asked for `.cursor/rules/*.mdc` evidence. They are not the final Cursor skill target. The broader parity model must treat Cursor Agent Skills as the primary on-demand workflow surface and Cursor rules as the always-on or scoped-policy surface.

## Required Follow-Up: Skills-First Stage Graph

Tracked as `forge-wj36`.

This follow-up now has a machine-readable contract in `lib/harness-capability-matrix.js`.
Generate the current evidence artifact with:

```bash
node scripts/spikes/harness-capability-matrix.js
```

The output is JSON with three top-level contracts:

- `harnesses[]`: Claude, Cursor, Codex, and Hermes capability support across instructions, skills, rules, MCP, hooks, commands, agents/subagents, stages, Beads, typed memory, patch overrides, marketplace trust, and extension packs.
- `stageGraph`: canonical Forge workflow stages as skills-first super skills with addressable subskills, plus utility skills such as `status` outside workflow transitions.
- `rendererContract`: the evidence a renderer must provide before Forge emits broad harness files.

Forge stage parity is skills-first across all harnesses. Claude stage skills have
**no command shim** — the legacy `.claude/commands/` surface was removed (A0d), so
the stage skill is the authority. Cursor stage skill files are **generated** by
Forge, though live auto-invocation is not yet proven. Hermes is CLI-consumed and
reads the stage graph through `forge orient` / `forge recap` (no per-stage file).

| Forge stage | Canonical surface | Claude render | Cursor render | Codex render |
| --- | --- | --- | --- | --- |
| `plan` | super skill with phases | `.claude/skills/plan/SKILL.md` | `.cursor/skills/plan/SKILL.md` (generated) | `.codex/skills/plan/SKILL.md` |
| `dev` | super skill with TDD subskills | `.claude/skills/dev/SKILL.md` | `.cursor/skills/dev/SKILL.md` (generated) | `.codex/skills/dev/SKILL.md` |
| `validate` | super skill with check subskills | `.claude/skills/validate/SKILL.md` | `.cursor/skills/validate/SKILL.md` (generated) | `.codex/skills/validate/SKILL.md` |
| `ship` | super skill with PR subskills | `.claude/skills/ship/SKILL.md` | `.cursor/skills/ship/SKILL.md` (generated) | `.codex/skills/ship/SKILL.md` |
| `review` | super skill with feedback subskills | `.claude/skills/review/SKILL.md` | `.cursor/skills/review/SKILL.md` (generated) | `.codex/skills/review/SKILL.md` |
| `verify` | super skill with post-merge subskills | `.claude/skills/verify/SKILL.md` | `.cursor/skills/verify/SKILL.md` (generated) | `.codex/skills/verify/SKILL.md` |

Pre-merge is not a skill or a workflow stage — it is a documentation-and-handoff gate embedded in the `ship` and `review` skills, so it has no parity row.

`status` remains a utility skill, not a workflow stage. The stage graph exposes it in `utilitySkills[]` so renderers can still generate status affordances without adding invalid workflow transitions.

The legacy `.claude/commands/` surface was removed (A0d): the canonical workflow lives in stage skills and subskills, and the stage skill — not a command shim — is the workflow authority.

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
| Project instructions | structured `AGENTS.md` sections | `CLAUDE.md` shim or generated file | `AGENTS.md` (native) + `.cursor/rules/*.mdc` for scoped policy | `AGENTS.md` | semantic section comparison |
| Skills/playbooks | agentskills.io-compatible `SKILL.md` | `.claude/skills` | `.cursor/skills` | `.codex/skills` packaging source (global `$CODEX_HOME` install) + committed `.agents/skills` repo-local discovery | generated file and trigger metadata |
| Rules/policies | Forge rule manifest (`rules/<name>.md`) | `AGENTS.md` instruction projection (no always-on `.claude/rules/*` policy bloat) | `.cursor/rules/*.mdc` (rendered from `rules/`) | `AGENTS.md` section | rule target and unsupported-surface notes |
| MCP tools/resources | Forge MCP manifest | Claude MCP config | `.cursor/mcp.json` | Codex MCP config | config render and server probe |
| Hooks | Forge hook manifest | Claude hook adapter if supported | unsupported unless verified | Codex hook adapter if supported | supported/unsupported matrix |
| Commands | Forge stage-skill manifest | `.claude/skills/<stage>` (legacy `.claude/commands` removed in A0d) | stage skills if supported | CLI docs or skill backstop | stage skill is the authority |
| Agents/subagents | Forge agent role spec | Claude subagents | Cursor agent/subagent config if supported | Codex skill/agent backstop | role mapping or known issue |
| Marketplace/extensions | `extension.yaml` plus lock metadata | plugin/skills/commands/hooks | skills/rules/`.cursor/mcp.json` config | skills/MCP/hooks | lockfile, SHA, trust, generated targets |

The machine-readable matrix intentionally separates similar-looking surfaces:

- Skills are on-demand workflows: `.claude/skills/<skill>/SKILL.md`, `.cursor/skills/<skill>/SKILL.md`, and for Codex both the `.codex/skills/<skill>/SKILL.md` packaging source (global `$CODEX_HOME/skills` install) and the committed `.agents/skills/<skill>/SKILL.md` repo-local discovery mirror (Codex scans it cwd → repo root). Forge now generates `.agents/skills` at setup and commits it.
- Rules are policy/context projections rendered from one canonical `rules/<name>.md` source: only Cursor has a first-class native rule surface (`.cursor/rules/<rule>.mdc`); Claude, Codex, and Hermes receive the same policy through their `AGENTS.md` instruction projection (adding always-on `.claude/rules/*` policy files would triple-deliver the same context as token bloat).
- Commands are removed, not shims: the legacy `.claude/commands/` and `.cursor/commands/` surfaces were removed in A0d. The canonical workflow lives in stage skills (`.claude/skills/<stage>`, `.codex/skills/<stage>`); Codex/Hermes fall back to the stage skill, not a command file.
- MCP is config plumbing: each harness gets native MCP config only when the matrix records a target path and probe evidence.
- Hooks are lifecycle adapters: Claude and Codex have native hook targets; Cursor remains a known issue until a hook surface is proven.
- Distribution is not a skill directory dump: Codex can use plugins and marketplaces; Forge extension packs must carry lock/trust metadata before installation.

No broad renderer should be added until its capability has a matrix entry, target path contract, activation metadata contract, machine-readable evidence, and a known-issue record for any unproven harness.

## External Compatibility Pattern

The current ecosystem pattern is a canonical payload with native harness renderers:

- Claude Code documents skills as `SKILL.md` files whose `description` controls automatic loading, and notes that commands and skills can both expose slash affordances.
- Cursor documents `.cursor/rules/*.mdc` as persistent scoped context with `description`, `globs`, and `alwaysApply`; Cursor skills are treated by Forge as the on-demand workflow target, while rules remain the policy target.
- Codex documents skills as reusable workflow packages under `.agents/skills` for repository scope (checked in for the team, scanned cwd → repo root), uses description-based implicit invocation, and uses plugins/marketplaces to distribute reusable skills, MCP servers, hooks, and apps. Forge emits `.codex/skills` packages for the global `$CODEX_HOME` install and now also generates + commits the repo-local `.agents/skills` mirror at setup.
- AGENTS.md remains the shared instruction projection for agents that read repository instructions directly.

Forge adopts that pattern by keeping one canonical Forge capability and rendering the smallest verified native wrapper per harness. It does not duplicate every feature blindly into every directory.

Week 3 expands that into a runtime capability registry. The registry must cover skills, commands, hooks, MCPs, ACPs, books/docs, agents, memory policies, protected paths, marketplace metadata, and workflow stages. Harness files should be generated projections from the active project workflow, not the authority.

Invocation policy is part of parity. Required skills must be loaded by Forge runtime at stage or gate boundaries; expensive, dangerous, or long-running skills must remain gated, hidden, or execution-only until the user or runtime explicitly requests them.

Parity is not accepted until an evaluator cross-checks the resolved workflow graph against generated harness projections and either passes, blocks, or records a known issue with evidence. The evaluator must also propose minimal repair diffs when a customer-installed workflow pack changes the active stage implementation.

## Evidence Command

Run the W0 parity fixture from the repository root:

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

Run the broader capability matrix evidence from the repository root:

```bash
node scripts/spikes/harness-capability-matrix.js
```

The JSON output includes:

- `harnesses[].capabilities`
- `stageGraph.stages[].subskills`
- `stageGraph.stages[].renderTargets`
- `rendererContract.rendererFamilies`
- `sources[]`

## Proof Boundary

This fixture proves deterministic metadata-surface parity. It does not launch closed-source agent sessions or claim that a live model selected a skill in a proprietary runtime. For Codex specifically, it validates the Forge packaging source and metadata (and the committed `.agents/skills` repo-local discovery mirror), not live auto-invocation inside the Codex runtime.

If a future release needs live invocation proof, add a separate transcript-producing eval for Claude Code, Cursor, and Codex and keep this fixture as the fast CI gate.

## Known Issues

No harness-specific metadata issue is known for this fixture. Live proprietary-agent auto-invocation is intentionally outside this deterministic test and is reported in `proofBoundary`.

Known gaps intentionally left for follow-up. Tier-2 work is tracked under kernel epic `90f2f631` (Cross-agent parity Tier 2):

- Cursor Agent Skill files ARE generated by Forge at setup (`.cursor/skills`), so the matrix marks Cursor skills/stages `native`; live auto-invocation is simply not asserted by the W0 metadata fixture. `.cursor/rules` remains the policy target.
- Claude stage distribution is skills-first: the legacy `.claude/commands/` surface was removed (A0d) and the stage skill (`.claude/skills/<stage>`) is the authority — the stage graph no longer emits a command shim.
- **Hooks (`988ae187`)**: NO harness-native hook file is rendered for ANY harness — all lifecycle enforcement is delivered via Lefthook git hooks. The matrix marks Claude/Codex hooks `contract-only` and Cursor hooks `not-delivered` (Cursor 1.7+ exposes `.cursor/hooks.json`, not yet rendered). Native hook renderers are the deliverable.
- **Agents/subagents (`802aa4d8`)**: the whole domain is unimplemented — no renderer, manifest, wiring, or tests for any harness. The matrix marks every harness `not-delivered`/`unsupported`. A subagent renderer is the deliverable.
- **Typed memory (`dce9da46`)**: typed memory is WRITE-ONLY (`insights.js`); no generator projects a memory section into any instruction/rule file. All four typedMemory rows are marked `not-delivered`. A memory-projection renderer is the deliverable.
- **Codex paths (`55dfeccf`)**: `.codex/skills` is the committed packaging staging mirror; skills install to the global `$CODEX_HOME/skills`. Codex's repo-local discovery path `.agents/skills` is NOW generated at setup and committed for teammate-clone discovery (this closes the skills/stages half of `55dfeccf`). Codex MCP remains global-config-only (`$CODEX_HOME/config.toml`), so `(mcp, codex)` is still `not-delivered` at project setup.
- **Safety domains (`1e68255c`)**: Claude permissions, `.cursorignore`, and Codex sandbox/approvals are not yet modeled in the matrix.
- MCP is now auto-wired project-local for both Claude (`.mcp.json`) and Cursor (`.cursor/mcp.json`) via the tested `lib/mcp-config-renderer.js`. Beads/patch-override state, marketplace trust, and extension packs remain as the matrix records them.
