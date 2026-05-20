# Evaluator Synthesis: Protected State, Beads Control Plane, And Post-0.0.18 Release Train

Date: 2026-05-18
Status: Planning update

## Summary

The current post-`0.0.18` plan should not continue as "more board features." The better sequence is:

1. protect state files from unsafe agent edits,
2. force issue and config mutations through Forge APIs,
3. make Beads the default local issue engine behind an adapter,
4. project hooks/memory into Codex, Claude, Cursor, and later agents,
5. then ship local UI/TUI and scaled team orchestration.

This keeps Forge local-first and agent-agnostic while giving public releases a visible, incremental path.

## External Grounding

- Codex memories are generated local recall state, not the mandatory rules surface. OpenAI says required team guidance should stay in `AGENTS.md` or checked-in docs, and memory files should not be hand-edited as the primary control surface: <https://developers.openai.com/codex/memories>.
- Codex hooks support turn/session/tool events including `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop`; `UserPromptSubmit` can add extra developer context, but transcript format is not a stable hook interface: <https://developers.openai.com/codex/hooks>.
- Claude separates memory from deterministic automation: `CLAUDE.md` and auto-memory carry context, but instructions that must run at a specific lifecycle point should be hooks: <https://code.claude.com/docs/en/memory>.
- Cursor's Continual Learning plugin is a concrete stop-hook plus subagent pattern. It mines transcript deltas, keeps an incremental index, and updates `AGENTS.md` with durable user preferences/workspace facts: <https://cursor.com/marketplace/cursor/continual-learning> and <https://github.com/cursor/plugins/tree/main/continual-learning>.
- Beads now documents Dolt as the source of truth, with JSONL/export as portability rather than the write surface. Multi-writer setups should use Dolt server mode: <https://gastownhall.github.io/beads/architecture>.
- Beads already has multi-agent concepts: routes, pinned work, handoff, and cross-repo dependencies: <https://gastownhall.github.io/beads/multi-agent>.

## Evaluator Findings

### 1. Current Plan Understates Agent Edit Risk

Forge already has the seed of protected paths in adoption profiles and runtime graph validation, but enforcement is incomplete. The plan must treat protected paths as a runtime product surface, not only a config list.

Required correction:

- add protected categories for `.beads/**`, `.forge/config.yaml`, generated agent configs, `AGENTS.md`/`CLAUDE.md` projections, hook configs, workflows, lockfiles, extension manifests, append-only logs, and secrets;
- enforce through harness hooks where available, pre-commit/CI fallback everywhere, and Forge API-only write paths for critical state;
- audit allowed, blocked, and bypassed attempts.

### 2. Beads Should Stay The Default Issue Engine, But Not Leak Into Every Agent

The user-facing rule should be: agents use Forge, Forge uses Beads. Agents should not edit `.beads` files, and Forge should not flatten Beads into "just JSON" unless the project explicitly opts into a reduced-fidelity fallback adapter.

Required correction:

- keep Beads/Dolt as the default adapter;
- build a Forge Issue Graph contract above Beads;
- treat JSON/JSONL as export/read-model/snapshot only;
- use Forge CLI/MCP/API operations for issue mutation;
- generalize field authority from GitHub-specific ownership to adapter-owned, Forge-owned, and cache-owned fields.

### 3. Memory Must Be Projected, Not Copied

Codex, Claude, Cursor, and future agents all have different memory mechanics. Forge should not copy one agent's memory system into core. It should maintain canonical typed memory and project a small, controlled subset into each harness.

Required correction:

- Forge memory is canonical only when stored with category, provenance, source, and audit;
- current implementation gaps must be acknowledged: typed memory needs a backend router or a deliberately narrowed Beads-backed model, explicit `forget`/`compact` semantics, and redaction before write/proposal generation;
- `AGENTS.md`, `CLAUDE.md`, Cursor rules, Codex memory/context, and MCP resources are projection surfaces;
- continuous learning should produce reviewable proposals for shared files;
- agent-native auto memories remain local generated recall.

### 4. UI/TUI Should Be Local And Transactional

The local UI or TUI should not be a cloud control plane. It should be a local control surface over Forge APIs:

- config plan/apply/rollback;
- issue update/reprioritize/link/sync through the IssueAdapter;
- extension enable/disable/install/remove;
- hook and memory projection status;
- protected-state audit.

### 5. Release Train Needs Public Launch Gates

The active roadmap had a solid `0.0.11` to `0.0.18` path but stopped before the new control-plane ideas. The updated train should add `0.0.19` to `0.0.25`, each with a single user value, an evaluator region, and a release gate.

### 6. Documentation Automation Should Be Adapter-Driven

The current code now has an early `forge docs verify` surface, but it should not become a permanent Forge-only clone of established documentation tools. Recent docs-validation adapter research found existing solutions that should be adapted through Forge adapters: Lychee for broad link checking, Linkspector/reviewdog for PR comments, remark-validate-links for local Markdown anchors, and eslint-plugin-jsdoc for JavaScript/TypeScript docstring requirements.

The required correction is to treat docs validation as a discovery-driven, toggleable substage. Forge should first detect each project's docs roots and systems, then recommend adapters, generate config through plan/apply, and expose modes such as `report`, `new-only`, and `strict`. Existing broken links or sparse docstrings should be baselined rather than blocking first adoption. The local UI/TUI should show detected docs roots, selected adapters, baseline size, coverage, GitHub Action projection, local hook projection, and rollback state.

## Updated Post-0.0.18 Release Sequence

| Release | User Value | Gate |
|---|---|---|
| `0.0.19` | Protected state surfaces | Direct edits to protected Beads/config/memory/generated files are blocked or flagged with repair hints. |
| `0.0.20` | Issue graph and Beads control plane | Issue priority/status/dependencies can be changed through Forge without direct `.beads` edits. |
| `0.0.21` | Local control plane UI/TUI | A user can preview, apply, and roll back a stage toggle locally. |
| `0.0.22` | Hook projection layer | One protected-path rule and one memory-context rule project into Codex, Claude, and Cursor where supported. |
| `0.0.23` | Memory projection and continuous learning | A session can produce a reviewed memory proposal with evidence/provenance and update the selected projection surface. |
| `0.0.24` | Extension-contributed runtime components | A local extension can add a verification substage and UI panel, then be removed cleanly. |
| `0.0.25` | Scaled team runtime and orchestrator bridge | Forge can filter a large issue graph, claim work for multiple agents, detect stale work, and sync through Beads plus one remote projection. |

## Public Release Process

Each release should follow this process:

1. Create or claim a Beads issue/epic for the release slice.
2. Work on an isolated release branch or worktree.
3. Write the acceptance matrix before implementation.
4. Implement only the release slice.
5. Run targeted tests, release-specific evaluator regions, `bun run check`, and `npm pack --dry-run`.
6. Publish release notes with user value, migration notes, feature flags, known limitations, rollback path, and adapter compatibility.
7. Publish through GitHub Release to npm.
8. Verify the installed package in a clean repo.
9. Close or update the Beads/GitHub release issue with validation evidence.

## Open Risks

- Hook coverage differs by harness. Cursor may need file-watcher or post-turn fallback where pre-edit blocking is unavailable.
- Beads/Dolt server mode improves multi-writer behavior, but Forge still needs health checks, lock/process diagnostics, and drift recovery UX.
- Memory projections can become noisy or stale unless every update has provenance, confidence, source, and a review/rollback path.
- Memory projection depends on implementation hardening: redaction, `forget`/`compact`, typed backend behavior, and per-agent hook capability metadata must be real before shared memory files are mutated.
- Local UI can become dangerous if it writes files directly; it must be API-first from the first release.
- Extension UI panels widen the trust boundary. They should stay local, declared in manifests, permissioned, and removable.
