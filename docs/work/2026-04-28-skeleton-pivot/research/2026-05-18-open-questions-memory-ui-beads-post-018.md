# Open Questions: Memory, Local UI, Beads Scale, Extensions, And Post-0.0.18

Date: 2026-05-18

## Summary

This note answers the open questions from the v3 runtime control-plane plan with newer grounding:

- Codex memories are generated local recall state, not a primary control surface.
- Codex hooks are real and should be treated as one harness projection of Forge lifecycle events.
- Forge UI should be local-only at first: local web app and/or TUI.
- UI should edit `.forge/config.yaml` through Forge transactions and write `patch.md` intent records for explainability.
- Beads should stay the default issue adapter, but UI must hide raw Beads complexity and expose scalable filtering, mutation, and adapter health.
- New understanding should land after `0.0.18` as follow-on upgrades/conversions, not be forced into the already-planned 0.0.12-0.0.18 run.

Sources:
- Codex Memories: https://developers.openai.com/codex/memories
- Codex Hooks: https://developers.openai.com/codex/hooks
- Local Codex config: `C:\Users\harsha_befach\.codex\config.toml`
- Local Codex hooks: `C:\Users\harsha_befach\.codex\hooks.json`

## 1. How Codex Uses Memory

Codex official docs say memories are:

- off by default
- enabled through Codex settings or `[features] memories = true`
- used to carry useful context across threads
- intended for preferences, recurring workflows, tech stacks, conventions, and known pitfalls
- not the required-team-guidance source
- stored under `~/.codex/memories`
- generated state that users can inspect, but should not hand-edit as the primary control surface

Local verification:

- `C:\Users\harsha_befach\.codex\config.toml` has `[features] memories = true`.
- It also has `[memories] no_memories_if_mcp_or_web_search = true`, which aligns with the idea that memory generation should skip sessions with external context.
- `C:\Users\harsha_befach\.codex\memories` contains `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, rollout summaries, and evidence files.

Implication for Forge:

Forge should not write directly into Codex memory as the canonical project state. It should treat Codex memory as an agent-local generated recall layer.

Correct relationship:

```text
Forge canonical project state
  -> docs / AGENTS.md / .forge/config.yaml / patch.md / typed memory / Beads
  -> generated harness projections
      -> Codex AGENTS.md context
      -> Codex hooks can inspect Forge state
      -> Codex memories may remember user-local recurring patterns
```

Wrong relationship:

```text
Codex MEMORY.md as Forge source of truth
```

Why:

- Codex docs explicitly say required team guidance belongs in `AGENTS.md` or checked-in docs.
- Codex memories can be skipped, delayed, disabled per thread, and generated in the background.
- Memories may be local to one developer and one Codex home directory.

## 2. Codex Hooks And "Hook Projection"

Codex official hooks include lifecycle events such as:

- `SessionStart`
- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `UserPromptSubmit`
- `Stop`

The docs show hooks configured in JSON or TOML, with matchers and command handlers. Current Codex notes also matter:

- only `type: "command"` handlers run today
- `prompt` and `agent` handlers are parsed but skipped
- async command hooks are parsed but skipped
- commands run with the session cwd
- repo-local hooks should resolve from git root
- managed hooks can be enforced through `requirements.toml`
- plugin-bundled hooks are opt-in

Local verification:

- `C:\Users\harsha_befach\.codex\hooks.json` defines:
  - `PreToolUse` -> `context-mode hook codex pretooluse`
  - `PostToolUse` -> `context-mode hook codex posttooluse`
  - `SessionStart` -> `context-mode hook codex sessionstart`
- Forge's current repo-local Codex adapter metadata still declares hooks unsupported in `lib/agents/codex.plugin.json`; that is stale relative to current Codex docs and this machine's enabled hook config.

What "Codex hook projection" means:

Forge should define stable Forge events:

- `forge.session.start`
- `forge.prompt.submit`
- `forge.tool.before`
- `forge.tool.after.success`
- `forge.tool.after.failure`
- `forge.permission.request`
- `forge.stage.start`
- `forge.stage.success`
- `forge.stage.failure`
- `forge.evidence.missing`
- `forge.audit.recorded`

Then Forge should project the subset each harness supports:

```text
Forge event              Codex projection
------------------------------------------------
forge.session.start      SessionStart command hook
forge.prompt.submit      UserPromptSubmit command hook
forge.tool.before        PreToolUse command hook
forge.permission.request PermissionRequest command hook
forge.tool.after.*       PostToolUse command hook
forge.session.stop       Stop command hook
forge.stage.*            implemented by Forge CLI/runtime, not native Codex
```

This keeps Forge portable. Claude, Cursor, Codex, CI, and future agents can all receive the same conceptual events, but each gets generated files in its own native format.

Post-0.0.18 conversion item:

- update Forge Codex harness capability metadata to mark supported hook surfaces accurately
- add harness validation tests for Codex `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop`
- generate Codex hooks only from Forge hook projection config, never by hand-editing generated hook files

## 3. Local UI/TUI Decision

The UI should be local-only for now:

- no Forge cloud
- no hosted control plane
- no remote scheduler dependency

Recommended first shape:

- TUI for terminal-first users.
- Local web app for richer multi-project editing.
- Both backed by the same CLI/JSON APIs.
- Shared implementation core first: `lib/config-workspace`.

Minimum backend commands:

- `forge projects list --json`
- `forge options list --project <path> --json`
- `forge options why <id> --project <path> --json`
- `forge options diff --project <path> --json`
- `forge config transaction start`
- `forge config set <component-id> <field> <value>`
- `forge config apply --dry-run`
- `forge config apply`
- `forge config rollback <transaction-id>`

The UI must not hand-edit raw YAML. It should call Forge transactions that:

1. Read current `.forge/config.yaml`.
2. Validate schema.
3. Create a transaction id.
4. Write intended changes.
5. Update `patch.md` intent/provenance where needed.
6. Preview generated harness changes.
7. Apply atomically.
8. Save rollback snapshot.
9. Emit audit/ledger event.

Transaction details:

- Use per-project locks, not one global lock for every repo.
- Create lockfiles with exclusive create semantics.
- Write temp files in the same directory as the target file.
- Validate before rename.
- Store transaction manifests under `.forge/transactions/<id>/manifest.json`.
- Include before hashes, before copies, planned operations, validation results, applied operations, and rollback command.
- For multi-project operations, dry-run every project first, then apply per-project transactions.

## 4. What UI Should Edit

The UI should edit actual `.forge/config.yaml` through safe transactions, not only `patch.md`.

Roles:

- `.forge/config.yaml`: current project configuration.
- `patch.md`: intent/provenance for why local changes exist and how upgrades should preserve them.
- `forge.lock`: extension versions/trust/checksums.
- generated harness files: output only, never hand-edited through UI.

Users should be able to:

- enable/disable stages
- enable/disable substages
- add a stage from an extension
- add a sub-verification stage
- select a stage implementation
- configure required evidence
- configure evaluator regions
- configure hooks on success/failure/block
- enable extension-contributed UI panels
- inspect what generated agent files will change

## 5. Extensions Adding Stages/Substages

External extensions should contribute components, not rewrite workflows.

Extension manifest should declare:

- stages
- substages
- hooks
- evaluators
- evidence collectors
- adapters
- templates
- UI panels
- commands
- skills
- permissions
- trust/integrity metadata

Current gap:

- the existing extension design covers `skill | stage | gate | adapter | command | hook`
- it does not yet make `uiPanels` or `evidenceCollectors` first-class contribution types
- post-0.0.18 work should extend the manifest from simple entries to typed `contributes`

Example shape:

```yaml
contributes:
  stages:
    - id: stage.dev.fast_fix
      title: Fast Fix Dev
      implements: forge.stage
      defaultEnabled: false
  substages:
    - id: substage.dev.security_scan
      parent: stage.dev
      defaultEnabled: false
  hooks:
    - id: hook.security.after_failure
      event: forge.stage.failure
      permissions:
        filesystem: read
        network: none
  evaluators:
    - id: evaluator.security.required
      targets:
        - artifact.patch
```

UI behavior:

- install extension
- inspect contributed components
- show trust/source/checksum
- allow toggles per project/profile
- block toggles that violate locked rails
- preview config and generated harness changes
- rollback extension update

Runtime resolution:

- every extension-contributed component must resolve into the runtime graph with source layer, trust, permissions, and collision metadata
- `forge options why/diff/lint/dry-run` must understand extension components before UI toggles are exposed

## 6. Beads At Thousands Of Issues

The core concern is real: if a project has thousands of Beads issues, raw files and naive UI lists will be painful.

Current local grounding:

- the current checkout has about 260 Beads issues and `.beads/issues.jsonl` is already a few hundred KB
- a full `bd list --all --limit 0` pass took roughly 0.7s in the current repo
- `forge status --json` took roughly 0.9s in the current repo
- current status snapshot code still reads `.beads/issues.jsonl` synchronously and builds in-memory buckets
- older team dashboard code uses an N+1 pattern: list issues, then call `bd show` per issue

This is acceptable at hundreds of issues. It is a risk at thousands.

Forge should not solve this by abandoning Beads immediately. It should:

- keep Beads as default `IssueAdapter`
- avoid raw `.beads` edits
- expose issue operations through adapter commands/API
- build indexed views for UI
- show adapter health and sync status

UI issue jobs:

- search issues
- filter by status, priority, type, owner, label, dependency, stale age, milestone/release
- edit priority/status/owner/labels
- bulk update selected issues
- show dependency graph around one issue
- show ready work
- show blocked work
- show stale work
- show adapter sync failures
- show field ownership: GitHub-owned shared fields versus Forge-local workflow context

Required adapter methods:

```text
list({ filter, cursor, limit, sort })
search({ query, filter, cursor, limit })
get(id)
update(id, patch, provenance)
bulkUpdate(ids, patch, provenance)
ready({ filter, limit })
dependencies(id)
health()
sync()
```

Performance requirements:

- Cursor-based pagination.
- Indexed metadata cache for UI reads.
- No full-file parse for every UI interaction.
- No N+1 `bd show` loop for list views.
- List rows should use summarized issue data; detail drawers can lazy-load one issue.
- Mutation still goes through Beads/adapter.
- Cache is disposable and rebuildable from adapter state.
- Scale tests with synthetic 5k and 20k issue fixtures before local UI issue manager work.
- Latency budgets for list/filter/search/status paths.
- Drift fixtures for stale sync and dirty Beads state.

UX principle:

The user should never need to understand `.beads/issues.jsonl` to update issue priority. They should see a table/board/detail view, make a change, preview the adapter mutation, and apply.

## 7. Post-0.0.18 Sequencing

Because the existing plan already pushes work through `0.0.18`, the new understanding should land after it as upgrades/conversions.

Keep 0.0.18 narrow:

- basic `forge board`/dashboard JSON
- IssueAdapter SPI over Beads only
- run ledger MVP
- review packet visibility
- ready/stale/evidence-missing views

Post-0.0.18 releases:

### 0.0.19: Local Control Plane Foundation

- `lib/config-workspace` read model
- config transaction writer
- local TUI or web app shell only after the shared core exists
- multi-project discovery
- read-only project config views
- `forge options` JSON backend hardening

### 0.0.20: Safe Config Editing

- `forge config plan/apply/rollback`
- transaction-based `.forge/config.yaml` edits
- patch intent records
- dry-run diff
- rollback snapshot
- generated harness preview

### 0.0.21: Hook Projection Layer

- normalized `forge.*` hook lifecycle
- Codex hook projection
- Claude hook projection
- Cursor fallback/projection
- hook trust and timeout policy
- Codex adapter capability update: hooks are supported now, but command-only and subject to current Codex limitations

### 0.0.22: Memory Projection Layer

- typed Forge memory projection manifest
- AGENTS/CLAUDE/Cursor/Codex projection rules
- provenance/freshness renderer
- stale-memory warnings

### 0.0.23: Extension Component Toggles

- extension-contributed stages/substages/evaluators/hooks
- first-class `evidenceCollectors`
- first-class `uiPanels`
- UI toggles
- trust/permission review
- rollback extension updates

### 0.0.24: Beads Scale UI

- indexed issue cache
- paginated search/filter
- bulk priority/status updates through `IssueAdapter`
- adapter health panel
- dependency graph detail view
- synthetic 5k/20k issue fixtures
- no N+1 list/detail pattern
- visible GitHub/Beads field ownership and sync drift

### 0.0.25: External Orchestrator Bridge

- lease-bound worker contract
- run ledger correlation
- handoff packets
- Hermes/T3-style external runtime adapter proof

## 8. Honest Grounding

What is clear now:

- Memory.md is not the right canonical control surface.
- Codex memory is useful but generated, local, delayed, and optional.
- Hooks are real enough to target, but each harness differs.
- UI must be local and CLI-backed first.
- `.forge/config.yaml` should be editable through transactions.
- `patch.md` is still needed for upgrade intent and provenance.
- Beads must be hidden behind an adapter and indexed UI views at scale.
- Post-0.0.18 is the right place for the new control-plane upgrades.
- Forge's Codex harness metadata should be updated because Codex hooks now exist.
- Local UI/TUI should share a `config-workspace` backend instead of implementing two separate editors.

What remains unknown:

- Whether Codex will expose richer non-command hook handlers soon.
- How much Cursor hook behavior is stable enough for generated projection.
- Whether Beads performance is good enough for thousands of issues without an indexed cache.
- Whether the first local UI should be TUI-first or web-first.
- Whether `AGENTS.md` should remain the primary cross-agent projection, or if Forge should add a dedicated `.forge/instructions/` projection directory.
- Whether extension-provided UI panels should run inside the local web app, the TUI, or only as declarative panel schemas at first.
