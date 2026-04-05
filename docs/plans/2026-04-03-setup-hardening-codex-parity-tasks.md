# Setup Hardening and Codex Parity - Task List

**Epic**: `forge-m1n8`
**Branch**: `feat/setup-hardening-codex-parity`
**Design doc**: `docs/plans/2026-04-03-setup-hardening-codex-parity-design.md`
**Baseline**: `2846 pass / 31 skip / 0 fail` on `bun test --timeout 15000`

YAGNI check:
- Every task below maps to at least one approved success criterion, Phase 2 research finding, or explicit user requirement.
- No task is included only for polish or documentation-only cleanup.

---

## Wave 1: Foundation (parallel - no shared owned files)

## Task 1: Build the authoritative workflow state layer
Beads: `forge-m1n8.1`
File(s): `lib/workflow/stages.js`, `lib/workflow/state.js`, `test/workflow/state.test.js`
OWNS: lib/workflow/stages.js, lib/workflow/state.js, test/workflow/state.test.js
What to implement: Create the runtime-owned stage model for all 7 stages. Define canonical stage ids, allowed transitions, override payload shape, and structured Beads-backed workflow state read/write helpers so runtime code no longer depends on heuristic stage guesses or free-form comment parsing.
TDD steps:
  1. Write test: `test/workflow/state.test.js` - assert canonical stage ids exist, invalid transitions are rejected, valid transitions serialize to a structured Beads payload, and override records are normalized.
  2. Run test: confirm it fails because the workflow state modules do not exist.
  3. Implement: add `lib/workflow/stages.js` and `lib/workflow/state.js` with transition validation and state payload helpers.
  4. Run test: confirm it passes.
  5. Commit: `feat: add authoritative workflow state layer`
Expected output: Forge has a reusable structured stage-state API for runtime enforcement and status reporting.

## Task 2: Build runtime health checks for hooks, shell, and prerequisites
Beads: `forge-m1n8.3`
File(s): `lib/runtime-health.js`, `lib/lefthook-check.js`, `test/runtime-health.test.js`
OWNS: lib/runtime-health.js, lib/lefthook-check.js, test/runtime-health.test.js
What to implement: Add a single runtime health-check module that verifies required stage-entry prerequisites, including active hook installation, `lefthook` availability, `bd`, `gh`, `jq`, and a usable shell policy on Windows. Keep shell helpers secondary, but make their availability testable and explicit.
TDD steps:
  1. Write test: `test/runtime-health.test.js` - assert missing `lefthook`, missing `bd`, missing `jq`, and missing shell runtime each produce structured hard-stop diagnostics; assert healthy state passes.
  2. Run test: confirm it fails because the runtime health module does not exist and `lefthook-check` does not expose the needed shape.
  3. Implement: add `lib/runtime-health.js` and extend `lib/lefthook-check.js` with explicit installation-state reporting.
  4. Run test: confirm it passes.
  5. Commit: `feat: add runtime prerequisite and hook health checks`
Expected output: Stage-entry code can make a deterministic hard-stop decision on runtime readiness.

## Task 3: Expand plugin capability metadata and support tiers
Beads: `forge-m1n8.4`
File(s): `lib/plugin-manager.js`, `lib/agents/README.md`, `test/plugins/plugin-manager.test.js`
OWNS: lib/plugin-manager.js, lib/agents/README.md, test/plugins/plugin-manager.test.js
What to implement: Extend the plugin schema to include support tiers and enforcement-relevant capability fields. At minimum encode native surface type, commands/rules/skills/MCP/context-mode capability, hook/blocking capability, repair/install requirements, and support status (`first-class`, `supported`, `compatibility`, `deprecated`, `unsupported`).
TDD steps:
  1. Write test: `test/plugins/plugin-manager.test.js` - assert plugin validation accepts the new fields, rejects malformed support tiers, and exposes normalized capability metadata to consumers.
  2. Run test: confirm it fails because the plugin manager does not yet understand the new fields.
  3. Implement: update `lib/plugin-manager.js` and document the schema in `lib/agents/README.md`.
  4. Run test: confirm it passes.
  5. Commit: `feat: add support-tier plugin capability schema`
Expected output: Forge can reason about agent support quality using machine-readable metadata instead of informal assumptions.

## Task 4: Normalize agent ids and discovery aliases
Beads: `forge-m1n8.4`
File(s): `lib/detect-agent.js`, `lib/project-discovery.js`, `test/detect-agent.test.js`, `test/agent-detection.test.js`
OWNS: lib/detect-agent.js, lib/project-discovery.js, test/detect-agent.test.js, test/agent-detection.test.js
What to implement: Introduce one canonical normalization layer so plugin ids, detection aliases, setup slugs, and discovery results match. Remove legacy drift such as `kilo` vs `kilocode`, `roo-code` vs `roo`, and support Codex/Cline/Roo detection in project discovery where appropriate.
TDD steps:
  1. Write test: update `test/detect-agent.test.js` and `test/agent-detection.test.js` to assert canonical ids are returned consistently for KiloCode, Roo, Codex, and other supported agents.
  2. Run test: confirm it fails because current detection returns mixed aliases and omits some agents.
  3. Implement: update `lib/detect-agent.js` and `lib/project-discovery.js` with canonical id normalization.
  4. Run test: confirm it passes.
  5. Commit: `fix: normalize agent detection and discovery ids`
Expected output: All runtime paths refer to the same agent ids.

---

## Wave 2: Runtime integration (sequential - shared workflow files)

## Task 5: Add stage enforcement middleware to Forge command dispatch
Beads: `forge-m1n8.1`
File(s): `bin/forge.js`, `lib/commands/_registry.js`, `lib/workflow/enforce-stage.js`, `test/cli/stage-enforcement.test.js`
OWNS: bin/forge.js, lib/commands/_registry.js, lib/workflow/enforce-stage.js, test/cli/stage-enforcement.test.js
What to implement: Route all stage commands through a shared enforcement layer before handler execution. The middleware must validate stage preconditions, use the structured workflow state, require explicit override payloads for bypasses, and hard-stop by default when a stage is not allowed to proceed.
TDD steps:
  1. Write test: `test/cli/stage-enforcement.test.js` - assert `/plan`, `/dev`, `/validate`, `/ship`, `/review`, `/premerge`, and `/verify` each invoke shared enforcement; assert blocked stage entry exits before handler execution; assert explicit override payload is required.
  2. Run test: confirm it fails because dispatch does not yet enforce stages centrally.
  3. Implement: add `lib/workflow/enforce-stage.js` and wire it into `bin/forge.js` and `lib/commands/_registry.js`.
  4. Run test: confirm it passes.
  5. Commit: `feat: add central stage enforcement middleware`
Expected output: Stage entry is runtime-enforced from one place instead of being encoded only in prompts and shell scripts.

## Task 6: Replace heuristic status detection with authoritative workflow state
Beads: `forge-m1n8.2`
File(s): `lib/commands/status.js`, `scripts/beads-context.sh`, `test/status-command.test.js`, `test/beads-context-transition.test.js`
OWNS: lib/commands/status.js, scripts/beads-context.sh, test/status-command.test.js, test/beads-context-transition.test.js
What to implement: Make `/status` read authoritative workflow state instead of inferring stages from filesystem and PR heuristics. Update Beads context integration only as needed so stage transitions expose the structured state required by runtime status.
TDD steps:
  1. Write test: `test/status-command.test.js` - assert status reports the next stage from recorded workflow state, not from branch/file heuristics; extend `test/beads-context-transition.test.js` if structured stage payload changes are needed.
  2. Run test: confirm it fails because status still guesses stage.
  3. Implement: update `lib/commands/status.js` and any required state-reading path in `scripts/beads-context.sh`.
  4. Run test: confirm it passes.
  5. Commit: `feat: make status read authoritative workflow state`
Expected output: `/status` tells the truth about workflow state even in multi-worktree and multi-session scenarios.

## Task 7: Enforce repair and shell policy at setup and stage entry
Beads: `forge-m1n8.3`
File(s): `lib/commands/setup.js`, `lib/husky-migration.js`, `scripts/pr-coordinator.sh`, `scripts/smart-status.sh`, `test/setup-runtime-flags.test.js`, `test/scripts/smart-status.test.js`
OWNS: lib/commands/setup.js, lib/husky-migration.js, scripts/pr-coordinator.sh, scripts/smart-status.sh, test/setup-runtime-flags.test.js, test/scripts/smart-status.test.js
What to implement: Reuse runtime repair logic at stage entry, not just during setup. Add explicit Windows shell handling, make hook/repair enforcement worktree-aware, and remove `.worktrees/` directory assumptions in critical helpers by standardizing on `git worktree list --porcelain`.
TDD steps:
  1. Write test: extend `test/setup-runtime-flags.test.js` and `test/scripts/smart-status.test.js` to assert safe runtime-asset repair, worktree-aware hook detection, and no local `.worktrees/` directory assumptions.
  2. Run test: confirm it fails because setup and helper scripts still depend on weaker assumptions.
  3. Implement: update `lib/commands/setup.js`, `lib/husky-migration.js`, `scripts/pr-coordinator.sh`, and `scripts/smart-status.sh`.
  4. Run test: confirm it passes.
  5. Commit: `fix: enforce worktree-aware repair and shell policy`
Expected output: Existing partially configured repos are repaired or blocked consistently, and worktree detection is correct across supported environments.

## Task 8: Add agent lifecycle and parity validation checks
Beads: `forge-m1n8.4`
File(s): `scripts/check-agents.js`, `test/scripts/check-agents.test.js`, `lib/agents/README.md`
OWNS: scripts/check-agents.js, test/scripts/check-agents.test.js, lib/agents/README.md
What to implement: Extend `check-agents` so it validates parity-critical metadata drift, including plugin support tiers, setup/sync/discovery alignment, and whether an agent claims capabilities the repo does not actually scaffold. This task is the lifecycle/update guard for future vendor changes.
TDD steps:
  1. Write test: extend `test/scripts/check-agents.test.js` to assert failures on stale support metadata, mismatched detection aliases, and capabilities claimed without real setup/sync support.
  2. Run test: confirm it fails because current validation does not cover those drift classes.
  3. Implement: update `scripts/check-agents.js` and document the policy in `lib/agents/README.md`.
  4. Run test: confirm it passes.
  5. Commit: `feat: validate agent support lifecycle and parity drift`
Expected output: Forge has an automated guardrail for agent update drift and false support claims.

---

## Wave 3: Agent parity implementation (sequential by integration surface)

## Task 9: Fix Codex plugin metadata and runtime adapter parity
Beads: `forge-m1n8.5`
File(s): `lib/agents/codex.plugin.json`, `lib/commands/setup.js`, `scripts/sync-commands.js`, `test/setup-runtime-flags.test.js`, `test/forge-commands.test.js`
OWNS: lib/agents/codex.plugin.json, lib/commands/setup.js, scripts/sync-commands.js, test/setup-runtime-flags.test.js, test/forge-commands.test.js
What to implement: Make Codex support honest and first-class: align plugin metadata with the actual `.codex/skills` surface, ensure setup provisions the right Codex assets, and route Codex stage skills through the new Forge stage-enforcement contract instead of relying on prompt-only behavior.
TDD steps:
  1. Write test: extend `test/setup-runtime-flags.test.js` and `test/forge-commands.test.js` to assert Codex setup creates the expected assets and that Codex stage invocations route through Forge enforcement.
  2. Run test: confirm it fails because Codex metadata and setup are still under-declared.
  3. Implement: update `lib/agents/codex.plugin.json`, `lib/commands/setup.js`, and `scripts/sync-commands.js`.
  4. Run test: confirm it passes.
  5. Commit: `feat: align Codex metadata and runtime adapter parity`
Expected output: Codex CLI and Codex desktop app are supported through the same Forge-managed stage contract.

## Task 10: Rewire Cursor and Kilo to their current native surfaces
Beads: `forge-m1n8.5`
File(s): `lib/agents/cursor.plugin.json`, `lib/agents/kilocode.plugin.json`, `lib/agents-config.js`, `lib/commands/setup.js`, `lib/project-discovery.js`, `test/cursor-config-generation.test.js`, `test/agent-detection.test.js`
OWNS: lib/agents/cursor.plugin.json, lib/agents/kilocode.plugin.json, lib/agents-config.js, lib/commands/setup.js, lib/project-discovery.js, test/cursor-config-generation.test.js, test/agent-detection.test.js
What to implement: Keep Cursor as an editor-native adapter and move Kilo away from stale `.kilo.md` assumptions toward its current rules/instructions/modes/workflows surface. Preserve `AGENTS.md` only as shared Forge context, not as the sole Kilo contract.
TDD steps:
  1. Write test: extend `test/cursor-config-generation.test.js` and `test/agent-detection.test.js` to assert Cursor and Kilo setup/detection match current native surfaces and canonical ids.
  2. Run test: confirm it fails because Kilo discovery still depends on legacy `.kilo.md` and setup does not fully match the newer plugin model.
  3. Implement: update `lib/agents/cursor.plugin.json`, `lib/agents/kilocode.plugin.json`, `lib/agents-config.js`, `lib/commands/setup.js`, and `lib/project-discovery.js`.
  4. Run test: confirm it passes.
  5. Commit: `feat: rewire Cursor and Kilo parity to native surfaces`
Expected output: Cursor and Kilo setup flows are aligned with their actual current integration surfaces.

## Task 11: Upgrade OpenCode and Copilot parity to native config paths
Beads: `forge-m1n8.6`
File(s): `lib/agents/opencode.plugin.json`, `lib/agents/copilot.plugin.json`, `lib/agents-config.js`, `lib/commands/setup.js`, `test/copilot-config-generation.test.js`, `test/agents-md-generation.test.js`
OWNS: lib/agents/opencode.plugin.json, lib/agents/copilot.plugin.json, lib/agents-config.js, lib/commands/setup.js, test/copilot-config-generation.test.js, test/agents-md-generation.test.js
What to implement: Stop underserving OpenCode and Copilot through partial prompt conversion alone. Wire setup to the fuller native config generation paths so these agents can participate credibly in the same runtime enforcement contract.
TDD steps:
  1. Write test: extend `test/copilot-config-generation.test.js` and any relevant OpenCode coverage to assert native configuration artifacts are created and aligned with plugin metadata.
  2. Run test: confirm it fails because setup only partially covers the intended native surfaces.
  3. Implement: update `lib/agents/opencode.plugin.json`, `lib/agents/copilot.plugin.json`, `lib/agents-config.js`, and `lib/commands/setup.js`.
  4. Run test: confirm it passes.
  5. Commit: `feat: align OpenCode and Copilot parity with native config paths`
Expected output: OpenCode and Copilot support is no longer a partial compatibility story.

---

## Wave 4: Conditional support decision (uncertain work goes last)

## Task 12: Prove Roo and Cline parity or deprecate them honestly
Beads: `forge-m1n8.7`
File(s): `lib/agents/roo.plugin.json`, `lib/agents/cline.plugin.json`, `lib/commands/setup.js`, `scripts/check-agents.js`, `test/agent-gaps.test.js`, `docs/plans/2026-04-03-setup-hardening-codex-parity-design.md`
OWNS: lib/agents/roo.plugin.json, lib/agents/cline.plugin.json, lib/commands/setup.js, scripts/check-agents.js, test/agent-gaps.test.js, docs/plans/2026-04-03-setup-hardening-codex-parity-design.md
What to implement: Evaluate Roo and Cline against the new runtime enforcement contract. If a credible native adapter path exists, implement and validate it. If not, explicitly downgrade or deprecate support instead of leaving a misleading converted-markdown path in place. Record the outcome in the design doc if support policy changes.
TDD steps:
  1. Write test: extend `test/agent-gaps.test.js` and `test/scripts/check-agents.test.js` to assert Roo and Cline either meet the declared support tier or are marked unsupported/deprecated consistently.
  2. Run test: confirm it fails because current support claims are not yet tied to parity quality.
  3. Implement: either complete the parity path or downgrade support metadata and setup behavior; update the design doc if the support matrix changes.
  4. Run test: confirm it passes.
  5. Commit: `feat: resolve Roo and Cline support policy under runtime enforcement`
Expected output: Roo and Cline are either honestly supported or honestly downgraded.

---

## Review notes for Phase 3

1. `KiloCode` is planned as a high-priority keep, not a drop candidate.
2. `Roo` stays in scope, but only late in the wave order because support may need to be downgraded if parity is not credible.
3. `Cline` is intentionally the weakest support case and remains last-wave work.
4. `Pi` is intentionally excluded from this PR and should be tracked separately later.
