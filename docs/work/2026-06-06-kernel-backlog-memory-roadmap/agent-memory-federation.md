# Agent Memory Federation Model

## Core idea

Forge memory should not replace Hermes, Codex, Claude, Cursor, or another agent's private memory. Instead, Forge should become the **project memory federation layer**:

```text
Forge Project Memory
= indexed project artifacts
+ Kernel issue/decision/evidence events
+ agent-exported public memory snapshots
+ agent session recaps
+ provider-specific memory references
```

The important correction is that this is **not direct ownership**:

```text
Forge memory ≠ raw private Hermes/Codex/Claude memory stores
Forge memory = shared, consented, provenance-backed project knowledge derived from many sources
```

## Memory classes

### 1. Authoritative project state

Owned by Forge Kernel.

Examples:

- issues
- tasks
- claims
- workflow stage state
- decisions
- evidence
- validation results
- sprint/release state

This is the only memory layer allowed to change project truth.

### 2. Verbatim project knowledge

Owned by Forge as a rebuildable read model.

Sources:

- `docs/work/**/plan.md`
- `docs/work/**/tasks.md`
- `docs/work/**/decisions.md`
- legacy `design.md`
- issue bodies/comments
- validation logs
- evidence files
- PR descriptions/reviews
- release notes

This is indexed verbatim first. Summaries are derived.

### 3. Agent public memory exports

Provided by agents through an adapter contract.

Examples:

- Hermes session recap exported to Forge
- Codex task summary exported to Forge
- Claude plan/decision summary exported to Forge
- Cursor/Copilot notes exported to Forge
- other agents' stage evidence or conclusions

Forge stores these as source artifacts with provenance, not as unquestioned truth.

### 4. Agent private memory

Owned by the agent, not Forge.

Examples:

- Hermes user memories/skills
- Claude private context
- Codex local session context
- Cursor/copilot private prompts or hidden history
- provider-specific model memory

Forge should not read or mutate this unless the user explicitly configures an export/import adapter.

## Adapter contract

Each agent gets a memory adapter that can expose one or more capabilities:

```json
{
  "agent": "hermes|codex|claude|cursor|custom",
  "capabilities": {
    "export_recap": true,
    "export_decisions": true,
    "export_evidence": true,
    "read_memory_files": true,
    "export_private_memory": false,
    "import_orient_context": true
  }
}
```

## Direct read-only memory connectors

Forge should support direct read-only connectors for agent memory files because agent-exported recaps may miss nuance. This is not the same as Forge owning or mutating those memories.

A direct connector may read configured paths such as:

- Hermes profile memories, session DB excerpts, and skills metadata when explicitly allowed.
- Codex/Codex CLI project memory or session artifacts when available.
- Claude/Claude Code project memories, commands, summaries, or transcript references when available.
- Cursor/Copilot/custom agent notes, project rules, summaries, or context files.
- Historical Forge plans and legacy project docs.

Rules:

1. Connectors are read-only by default.
2. Every connector is allowlisted by agent, path, profile, and source type.
3. Private memory files are indexed as `visibility=private_ref` or `visibility=restricted` unless explicitly promoted to project/team visibility.
4. Raw content is source material, not authority.
5. Conflicting memories become conflict candidates with citations.
6. A Kernel decision event is required to turn a chosen interpretation into project truth.
7. Forge records content hash, mtime, source path, line/byte span where possible, and redaction status.
8. Connectors must have a doctor command that says which memory stores are readable, blocked, missing, or stale.

This means Forge can directly read the nuanced material, but does not silently collapse private memories into project truth.

## Ingested memory record shape

```json
{
  "id": "memsrc_...",
  "source_kind": "agent_export|project_doc|kernel_event|external_projection",
  "agent": "hermes",
  "visibility": "project|team|private_ref|redacted",
  "authority": "none|proposal|kernel_event",
  "issue_id": "forge-...",
  "stage": "plan|dev|validate|review",
  "content_hash": "sha256:...",
  "source_ref": {
    "path": "docs/work/.../plan.md",
    "line_start": 1,
    "line_end": 40,
    "event_id": null,
    "session_id": "..."
  },
  "redaction_status": "clean|redacted|blocked|unknown",
  "created_at": "..."
}
```

## Retrieval model

Forge should retrieve memory in layers:

1. Kernel authority: current issue/task/claim/decision state.
2. Verbatim project sources: plans, decisions, tasks, evidence.
3. Agent-exported recaps: Hermes/Codex/Claude/etc. summaries with provenance.
4. Derived summaries/facts: only as proposals with source links.
5. Deep search: FTS5/vector search over all allowed sources.

## How this becomes `forge orient`

`forge orient` should produce a bounded context bundle:

```json
{
  "authority": { "issue": {}, "claims": [], "decisions": [] },
  "project_sources": [{ "title": "plan.md", "ref": "..." }],
  "agent_recaps": [
    { "agent": "hermes", "summary": "...", "source_ref": "..." },
    { "agent": "codex", "summary": "...", "source_ref": "..." }
  ],
  "warnings": ["Some Claude private memory is not exported"],
  "deeper_commands": ["forge knowledge search ..."]
}
```

## Safety rules

1. Private agent memory is not indexed by default, but can be read through explicit read-only connectors.
2. Direct memory reads require user/project allowlists and source visibility classification.
3. Agent exports and direct memory reads are evidence/proposals, not authority.
4. All imported/read memory needs source provenance.
5. All logs/prompts/tool outputs need redaction rules.
6. Retrieved content is quoted as evidence, not followed as instruction.
7. Kernel events are the only way to change project truth.
8. Users can configure which agents export what and which memory files Forge may read.

## Practical implementation path

### Phase 1: Index old plans and Kernel events

Build the base Forge memory from existing project artifacts and Beads/Kernel state.

### Phase 2: Add agent recap export adapters

Start with safe exports only:

- session recap
- decisions made
- evidence produced
- open questions
- files changed
- validation result

### Phase 3: Add provider-specific adapters

Add adapters for Hermes, Codex, Claude, Cursor/Copilot, and custom agents.

### Phase 4: Add retrieval and orient/recap

Expose project + agent memory through `forge orient`, `forge recap`, and `forge knowledge search`.

### Phase 5: Optional private-memory bridges

Only with explicit user configuration, allow selected private memory references or redacted exports.

## Bottom line

Forge can become the shared project memory by federating agent memories, but it should do so through adapters, provenance, redaction, and consent. The formula should be:

```text
Forge shared memory
= project authority
+ old plans/docs indexed verbatim
+ agent public recaps/evidence
+ provenance-backed summaries
```

Not:

```text
Forge memory = direct takeover of every agent's private memory
```
