## Feature

- **Slug**: `setup-hardening-codex-parity`
- **Date**: `2026-04-03`
- **Status**: `Phase 2 complete / Phase 3 pending`

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

## Technical Research

### Current architecture findings

Phase 2 confirms that Forge still runs as a mixed-model workflow rather than a single enforced runtime:

1. Runtime code is thin and mostly handles setup, dispatch, and heuristics.
2. Canonical workflow truth still lives in `commands/*.md`, synced agent command files, `.codex/skills/*/SKILL.md`, and shell helpers.
3. Beads context is stored mainly as issue comments and advisory validation rather than structured machine-readable stage state.
4. Hook enforcement is optional in practice because missing `lefthook` currently degrades to warnings instead of hard-fail enforcement.

Key repo evidence:

- [`bin/forge.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/bin/forge.js) dispatches commands but does not own stage-state enforcement.
- [`lib/commands/setup.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/commands/setup.js) provisions assets and attempts hook installation, but stage gates do not reuse that logic consistently.
- [`commands/plan.md`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/commands/plan.md), [`commands/dev.md`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/commands/dev.md), and [`commands/validate.md`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/commands/validate.md) still encode most hard-gate behavior.
- [`scripts/beads-context.sh`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/scripts/beads-context.sh) records stage transitions as comments and validates context advisorially.
- [`lib/commands/status.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/commands/status.js) infers stage heuristically from branch/files/PRs instead of authoritative stage metadata.

### Agent capability matrix

Research across the repo and available primary sources supports a tiered model rather than "all supported agents are equal."

#### Strong first-class keep

1. **Claude**
   - Best native surface in the repo today: commands, rules, skills, scripts, `CLAUDE.md`, and hook support are all modeled explicitly in [`lib/agents/claude.plugin.json`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/agents/claude.plugin.json).
   - Anthropic's official docs confirm strong lifecycle surfaces including hooks, MCP, and subagents: [Claude Code](https://docs.anthropic.com/de/release-notes/claude-code), [Subagents](https://docs.anthropic.com/de/docs/claude-code/sub-agents).
   - Conclusion: Claude remains the reference implementation for the new enforcement contract.

#### Fix-first strategic keep

2. **Codex**
   - Repo support is materially under-declared: [`lib/agents/codex.plugin.json`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/agents/codex.plugin.json) says `skills:false` and `hooks:false`, but the repo ships a real `.codex/skills` stage surface and sync adapter support.
   - Codex support should be preserved because this PR explicitly targets Codex parity, but parity is not credible until plugin metadata, detection, and setup are aligned.
   - Official external confirmation is weaker than Claude's lifecycle surface; the design should therefore route Codex through Forge runtime enforcement instead of assuming native hook blocking.

3. **Cursor**
   - Repo metadata models Cursor as commands + rules + skills in [`lib/agents/cursor.plugin.json`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/agents/cursor.plugin.json).
   - The repo also contains richer Cursor-specific generation paths in [`lib/agents-config.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/agents-config.js), but setup is not wired to them consistently.
   - Cursor should remain supported, but the implementation should treat it as an editor-native adapter over the central Forge contract.

4. **OpenCode**
   - Repo support is credible enough to keep if setup is upgraded to generate the fuller OpenCode native config surface.
   - Official docs confirm MCP-driven tool configuration and agent config support: [OpenCode Agents](https://opencode.ai/docs/de/agents/), [OpenCode MCP Servers](https://opencode.ai/docs/mcp-servers).

5. **GitHub Copilot**
   - Repo support is currently split between prompt conversion and partially wired native config generation.
   - It is worth keeping only if the native instructions/prompts surface is enforced through the same runtime contract rather than prompt-only drift.

#### Prove parity or drop

6. **KiloCode**
   - Current repo support is inconsistent across plugin metadata, detection, config generation, and project discovery.
   - External official material confirms orchestration and MCP support, but the current repo integration looks under-specified relative to native usage: [Kilo Code 4.19.1: Orchestrator Mode is here!](https://blog.kilocode.ai/p/kilo-code-4191-orchestrator-mode).
   - Keep only if native editor-oriented parity can be made coherent without excessive special-case maintenance.

7. **Cline**
   - Repo support largely reduces to converted workflow markdown and light config.
   - Official docs confirm auto-approve, MCP tools, and mode transitions, but the current Forge integration does not yet map that into a robust stage contract: [Cline Auto Approve & YOLO Mode](https://docs.cline.bot/features/yolo-mode), [Cline Memory Bank](https://docs.cline.bot/features/memory-bank).
   - Candidate for removal if a stronger native contract is not practical.

8. **Roo**
   - Repo support is similar to Cline: converted commands plus naming inconsistencies and no stronger enforcement contract yet.
   - Official docs confirm MCP usage, modes, and both IDE/cloud surfaces: [Roo Code Docs](https://docs.roocode.com/).
   - Candidate for removal unless its native modes and approval model can map cleanly into Forge enforcement.

### Context Mode findings

Context Mode is a strong fit as a context-isolated execution primitive, but not as the enforcement authority.

The official compatibility table at [Context Mode v1.0.0](https://context-mode.mksg.lu/) shows:

1. MCP server support across Claude Code, VS Code Copilot, OpenCode, and Codex CLI.
2. Stronger hook/blocking support in Claude and some other clients.
3. No equivalent PreToolUse blocking or full session continuity for Codex CLI.

Implication:

1. Context Mode is valuable for sandboxed execution, large-output search, and context preservation.
2. It should be integrated as a first-class helper capability inside Forge.
3. It should not be used as the sole stage-enforcement mechanism because the blocking surface is not available uniformly across agents.

### Worktree, shell, and hook findings

The strongest enforcement reliability risks are currently operational rather than conceptual:

1. **Hooks are not reliable enough in worktrees**
   - [`package.json`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/package.json) treats `lefthook` as an optional peer and the `prepare` script tolerates missing hooks.
   - [`lib/commands/setup.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/commands/setup.js) skips hook setup when the binary is unavailable.
   - Worktree commits in this planning session already hit the same gap.

2. **Current hook-state detection is worktree-fragile**
   - The repo's live Git config still uses `core.hooksPath=.husky`.
   - Husky migration logic assumes `.git/config` lives under `projectRoot/.git/config`, which is wrong for worktrees where `.git` is a pointer file.

3. **Windows shell resolution is ambiguous**
   - Multiple workflow scripts assume `bash scripts/...`, but in this environment the default `bash` path was not reliable while Git Bash was.
   - Setup currently checks `git`, `gh`, and `node`, but not `bash`, `jq`, or `bd`, even though those are hard runtime requirements for several stage helpers.

4. **Worktree discovery is inconsistent**
   - Some helpers correctly use `git worktree list --porcelain`.
   - Others still scan a local `.worktrees/` directory, which misses externally located worktrees and Codex-managed worktrees.

### Additional improvements discovered during research

Phase 2 surfaced concrete design and implementation upgrades beyond the initial problem statement:

1. **Introduce a structured workflow state layer**
   - Beads should remain the audit/state system, but stage truth should be written and read through a structured runtime adapter rather than comment parsing and heuristics.

2. **Extend plugin capability metadata**
   - The current plugin schema is too weak for enforcement decisions.
   - It needs explicit support tiers and capability fields such as:
     - CLI-first vs editor-native vs desktop-app
     - commands/rules/skills/MCP/hooks/context-isolation support
     - ability to block stage entry
     - repair/install requirements
     - support status: first-class, compatibility, deprecated, or unsupported

3. **Unify naming and discovery**
   - Current naming drift across plugin ids, detection aliases, project discovery, and setup-facing slugs creates correctness risk.
   - This needs a single normalization layer before enforcement can be trusted.

4. **Make repair a first-class runtime path**
   - Runtime assets are currently scaffolded mainly through setup.
   - Stage entry should reuse the same repair/verification logic for existing partially configured repos.

5. **Explicit Windows shell policy**
   - Forge should either require Git Bash explicitly on Windows or resolve the known Git Bash executable for helper-backed flows.

### Edge cases and failure modes

Research added more concrete edge cases beyond the Phase 1 list:

1. **Detached worktrees and nonstandard worktree locations**
   - Scripts that assume `.worktrees/` under repo root will miss valid Git worktrees created elsewhere.

2. **Stale metadata with valid files**
   - A repo can have commands/skills on disk but stale or missing support metadata, causing support decisions to look correct while enforcement is actually broken.

3. **Prompt adapter drift**
   - If markdown command files or skills continue to own logic, support quality will diverge per agent even when setup appears successful.

4. **False status reporting**
   - Heuristic `/status` output can contradict actual Beads stage state and mislead users into running the wrong stage next.

5. **Silent partial setup**
   - Setup may currently succeed while missing real execution prerequisites such as `bd`, `jq`, or a usable shell.

6. **Unsafe auto-repair scope**
   - Auto-repair is correct for generated assets and locally recomputable metadata.
   - Auto-repair is not automatically safe for Git hook configuration, repo mutation, or agent support reclassification.

### OWASP-oriented analysis

This feature is workflow infrastructure rather than a traditional web surface, but OWASP categories still clarify the risk model:

1. **A01: Broken Access Control**
   - Conversational or implicit bypasses would act like unenforced authorization.
   - Mitigation: explicit machine-readable overrides only, with structured logging.

2. **A03: Injection**
   - Shell-heavy helpers increase the risk of argument/command injection and quoting bugs.
   - Mitigation: move critical stage logic into Node/JS runtime code and keep shell helpers secondary.

3. **A05: Security Misconfiguration**
   - Missing hooks, missing prerequisites, and inconsistent shell resolution are effectively workflow-security misconfiguration.
   - Mitigation: runtime stage-entry checks with hard-stop defaults and explicit repair instructions.

4. **A08: Software and Data Integrity Failures**
   - Stale generated command files, stale support metadata, and partial setup create integrity failures between claimed and actual behavior.
   - Mitigation: canonical-source verification plus stage-entry drift detection and repair.

5. **A09: Security Logging and Monitoring Failures**
   - Missing structured stage state and override logs reduce accountability in multi-team workflows.
   - Mitigation: structured Beads-backed workflow state plus override/event logging at runtime.

### TDD scenarios for implementation

At minimum, implementation should start with these RED-GREEN-REFACTOR scenarios:

1. **Stage hard-stop on missing hook/runtime prerequisites**
   - Given a worktree without active Forge-managed hooks or without required toolchain dependencies,
   - when a stage command is invoked,
   - then Forge must hard-stop before stage execution and provide either safe auto-repair or an exact repair command.

2. **Codex adapter uses Forge runtime enforcement**
   - Given a Codex CLI or Codex desktop workflow invocation,
   - when a stage skill is triggered,
   - then the same Forge runtime contract must validate stage prerequisites, record stage state, and enforce override rules rather than relying on prompt-only behavior.

3. **Agent capability policy is enforced at setup and stage entry**
   - Given an agent whose metadata or native surface cannot satisfy the enforcement contract,
   - when setup or stage entry is attempted,
   - then Forge must either route through a supported compatibility path or explicitly mark that agent unsupported instead of silently installing a partial workflow.

4. **Status reads authoritative stage state**
   - Given a Beads issue with recorded stage transitions,
   - when `/status` is run,
   - then it must report the authoritative next stage from workflow state rather than guessing from filesystem heuristics.

5. **Safe repair for stale generated assets**
   - Given a repo with missing or stale generated command/skill artifacts but otherwise safe local state,
   - when a stage starts,
   - then Forge may regenerate those assets automatically and continue only if verification passes.

### Approach confirmation

Phase 2 confirms the selected approach rather than weakening it:

1. A single Forge runtime enforcement layer is necessary.
2. Agent-native UX adapters are still the correct delivery surface.
3. Context Mode should be integrated, but only as an execution primitive.
4. Hooks and shell helpers should be improved, but demoted from core stage authority.
5. Agent support must move to an explicit support-tier model.

### Blast radius

This work has a wide but manageable blast radius. Likely touch points include:

1. Runtime stage entry and dispatch:
   - [`bin/forge.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/bin/forge.js)
   - [`lib/commands/_registry.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/commands/_registry.js)
   - `lib/commands/*.js` for each stage

2. Workflow state and Beads integration:
   - [`scripts/beads-context.sh`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/scripts/beads-context.sh)
   - likely new JS workflow-state helpers under `lib/`

3. Setup, repair, and hook enforcement:
   - [`lib/commands/setup.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/commands/setup.js)
   - [`lib/lefthook-check.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/lefthook-check.js)
   - [`lib/husky-migration.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/husky-migration.js)

4. Agent metadata, detection, and discovery:
   - [`lib/agents/*.plugin.json`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/agents)
   - [`lib/plugin-manager.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/plugin-manager.js)
   - [`lib/detect-agent.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/detect-agent.js)
   - [`lib/project-discovery.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/project-discovery.js)
   - [`lib/agents-config.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/agents-config.js)

5. Canonical command/skill generation and downstream adapters:
   - [`scripts/sync-commands.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/scripts/sync-commands.js)
   - `commands/`
   - agent-specific generated directories under `.claude`, `.cursor`, `.cline`, `.roo`, `.codex`, `.kilocode`, `.opencode`, `.github`

6. Status/reporting and validation helpers:
   - [`lib/commands/status.js`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/lib/commands/status.js)
   - [`scripts/validate.sh`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/scripts/validate.sh)
   - [`scripts/pr-coordinator.sh`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/scripts/pr-coordinator.sh)
   - [`scripts/smart-status.sh`](C:/Users/harsha_befach/Downloads/forge/.worktrees/setup-hardening-codex-parity/scripts/smart-status.sh)
