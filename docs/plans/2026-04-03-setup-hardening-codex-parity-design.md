## Feature

- **Slug**: `setup-hardening-codex-parity`
- **Date**: `2026-04-03`
- **Status**: `Phase 1 complete / Phase 2 pending`

## Purpose

Forge currently enforces the workflow through a mixed model: runtime behavior, shell helpers, hooks, Beads state, and agent-facing prompts/skills all participate, but none is the single authority. That mixed model works best for Claude and is noticeably weaker for Codex, Cursor, and other supported agents. It also behaves inconsistently across worktrees, shells, and sessions.

This feature makes Forge the single source of truth for workflow enforcement across all 7 stages, while preserving agent-native UX through thin adapters. The goal is to deliver a credible, high-quality workflow for real users of supported agents, especially in multi-developer, multi-team, multi-worktree environments.

## Success Criteria

1. Forge enforces all 7 workflow stages (`/plan`, `/dev`, `/validate`, `/ship`, `/review`, `/premerge`, `/verify`) through a single runtime authority rather than instruction-only behavior.
2. Stage entry hard-stops by default when required prerequisites or workflow conditions are not satisfied.
3. Bypasses require an explicit machine-readable user override and every override is logged.
4. Codex CLI and Codex desktop app can both participate credibly in the enforced workflow model.
5. Claude CLI and other true CLI-first agents retain an excellent workflow experience.
6. Cursor and Kilo support remains credible in their native editor-oriented usage, not just through CLI fallback.
7. Hooks and helper scripts no longer act as the source of truth for core stage enforcement.
8. Missing or stale workflow assets are handled through safe auto-repair where clearly safe, and explicit repair commands otherwise.
9. Worktree-oriented multi-session workflows remain first-class, including Windows, macOS, and Linux.
10. If an agent cannot credibly support the enforced workflow without disproportionate complexity, support can be removed rather than kept in a misleading partial state.

## Out of Scope

1. Replacing Beads as the workflow state/audit system.
2. Redesigning the entire GitHub/Beads lifecycle model beyond what is necessary for stronger enforcement.
3. General setup polish that does not materially improve enforcement credibility or agent parity.
4. Large docs-only rewrites that are not required to reflect the enforced runtime behavior.
5. Making non-interactive / CI execution the primary design center; this work must remain compatible, but it is not the main driver.

## Approach Selected

### Selected approach

Adopt a **Forge-centered enforcement core**:

1. Forge runtime / CLI becomes the single source of truth for stage enforcement.
2. Agent-facing surfaces become thin adapters:
   - Claude/OpenCode/CLI-first agents invoke Forge-managed workflow commands.
   - Cursor/Kilo use native editor-friendly adapters over the same enforcement contract.
   - Codex CLI and Codex desktop app use Codex-native adapters/skills that route into the same Forge contract.
3. Shell helpers, hooks, and prompt files remain important, but only as adapters, repair tools, or guardrails.
4. Context Mode is treated as a first-class context-isolated execution primitive where useful, but not as the stage-enforcement authority.
5. Agent support is judged by whether the agent can credibly implement this contract with acceptable maintenance cost.

### Why this approach

This preserves the best part of the current system, which is strong workflow intent encoded in Forge-managed commands/prompts, while fixing the core architectural problem: workflow truth is currently spread across too many layers. Centralizing enforcement in Forge gives the strongest correctness guarantees and the best long-term consistency across:

- supported agents
- desktop vs CLI experiences
- Windows/macOS/Linux
- worktrees and parallel sessions
- multi-developer and multi-team coordination

### Rejected alternatives

#### 1. Keep shell scripts / hooks as the primary enforcement layer

Rejected because the shell path is currently the most fragile part of the stack, especially across Windows, Git Bash, WSL-style execution, and worktree layouts. It should be improved, but not remain authoritative for stage gates.

#### 2. Preserve a mixed model where prompts/skills and helper scripts remain co-equal enforcement authorities

Rejected because this is the current failure mode. It explains why Claude works best while Codex and Cursor drift or fail to enforce the intended question flow and gate behavior.

#### 3. Implement full native enforcement separately per agent

Rejected because it would maximize drift risk and maintenance burden. Agent-native UX is desirable, but agent-native authority is not.

## Constraints

1. **Correctness first**: support coverage is secondary to enforcement credibility.
2. **Hard-stop by default**: no silent fallthroughs, no implicit conversational bypasses.
3. **Explicit override only**: bypass must use a machine-readable mechanism and must be logged.
4. **Cross-agent truth**: supported agents must route into the same enforcement contract even if their UX differs.
5. **Cross-platform**: Windows, macOS, and Linux are mandatory support targets.
6. **Worktree-first**: multi-worktree and multi-session usage is a primary scenario, not an edge case.
7. **Maintainability matters**: agents that require disproportionate special-casing are candidates for removal.
8. **Forge orchestration**: agents should invoke Forge-managed workflow/tooling paths rather than improvising raw helper/tool commands when Forge has a supported path.
9. **Compatibility**: existing non-interactive / CI usage must not be broken by the redesign.

## Edge Cases

1. **Partially configured downstream repos**
   - Missing helpers, stale generated commands/skills, missing hooks, incomplete Codex/Cursor assets.
   - Decision: use a hybrid migration model. Stage entry may auto-repair clearly safe cases; larger/riskier cases must hard-stop with exact repair commands.

2. **Worktree-specific hook loss**
   - Hooks or `lefthook` may be missing in worktrees even when the main repo is configured.
   - Decision: treat this as an enforcement concern, not just setup polish.

3. **Codex desktop vs Codex CLI**
   - Desktop app behavior may not perfectly match CLI behavior.
   - Decision: support both, but do not allow desktop-specific UX to weaken the shared enforcement model.

4. **Editor-native agents vs CLI-first agents**
   - Cursor/Kilo users often work inside the editor, not through a standalone CLI.
   - Decision: preserve native invocation surfaces, but route them into the same Forge contract.

5. **Agents with insufficient capability surface**
   - Some agents may lack credible ways to support hooks, structured prompts, MCP-driven tooling, or stage gating.
   - Decision: research capability fit. If parity requires too much complexity or remains weak, remove support rather than over-claim.

6. **Shell/path portability failures**
   - Git Bash, Windows path formats, and WSL-style shells may disagree about worktree paths and command resolution.
   - Decision: shell remains a helper layer only; core gates should move into a more portable runtime path.

7. **Context pressure in long sessions**
   - Tool output and research tasks can bloat agent memory and degrade later stages.
   - Decision: use Context Mode or similar context-isolated execution where useful, but do not delegate core enforcement authority to it.

8. **Parallel teams and overlapping work**
   - Different sessions or agents may touch the same issue/workflow state.
   - Decision: stage enforcement must remain centralized and machine-readable, with explicit logged overrides only.

## Ambiguity Policy

Use the existing `/dev` 7-dimension decision rubric as the ambiguity policy:

- If confidence is **>= 80%**, proceed conservatively and document the choice.
- If confidence is **< 80%**, stop and ask the user.

For this feature specifically, any ambiguity that would alter:

- the enforcement source of truth
- the override model
- the agent support/removal decision
- the safe-vs-unsafe repair boundary

must be treated as high-impact and escalated unless the design doc or subsequent research resolves it clearly.

