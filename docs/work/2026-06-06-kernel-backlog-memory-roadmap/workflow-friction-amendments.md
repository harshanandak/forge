# Workflow Friction and Release-Readiness Amendments

## Why this exists

This addendum captures operational problems observed while using Forge itself to plan, review, verify, push, merge, and continue work across PRs and worktrees. These are not side quests: they are blockers to making Forge reliable enough for the next feature release and for new-project adoption.

The next implementation PRs should treat this document and the linked Beads issues as a reference until the Kernel authority, Project Knowledge, hook doctor, and setup/update mechanisms exist.

## Observed problems

### 1. Generated Forge docs/harness files reappear during lifecycle commands

During push, review, verify, merge, and post-merge cleanup, Forge-generated or runtime files can be rewritten again. The user-visible symptom is that agents repeatedly need to stash files such as generated agent instructions, hook configuration, or Beads runtime/backup state before the workflow can be closed cleanly.

Required direction:

- Distinguish generated harness outputs from durable planning artifacts.
- Make lifecycle commands idempotent: unchanged generated content must not rewrite timestamps, line endings, backup snapshots, or generated files.
- If a command must regenerate, it should either stage/record through the owning Forge surface or write to an explicit preview/update path, not leave surprise dirty files.
- `forge status`, `forge validate`, `forge push`, `forge ship`, review helpers, and post-merge cleanup should all report generated drift with safe repair commands.

### 2. New project setup does not enforce the current work-folder planning structure

When Forge is added to a new project, generated instructions/skills/templates may not push agents toward the now-preferred structure:

- `docs/work/<date>-<slug>/plan.md` for work-item intent and approach.
- `tasks.md` for executable task breakdown.
- `decisions.md` for decision log.
- `evidence.md` or validation notes for proof.
- `design.md` only for durable product/architecture design or as a legacy compatibility alias.

Required direction:

- Update setup templates, skills, command prompts, and generated agent guidance so new projects follow this structure by default.
- Add fixtures proving a fresh Forge install creates/mentions the correct folder and document names.
- Keep legacy `design.md` readable, but stop teaching it as the default work-item planning artifact.

### 3. `design.md` to `plan.md` migration is incomplete

Forge has shifted work-item planning from `design.md` to `plan.md`, but commands, skills, tests, docs, and generated instructions may still mention `design.md` as the ordinary planning output.

Required direction:

- Audit every command, skill, fixture, and doc reference.
- Replace default work-item planning references with `plan.md`.
- Keep `design.md` for true architecture/product design docs and backward-compatible reads.
- Add drift tests so the old default wording cannot come back.

### 4. Hooks and lint checks are not reliably installed in worktrees

Worktrees can miss Lefthook/lint setup or have stale hook paths. Agents then believe validation is installed while the actual worktree is missing the enforcement surface.

Required direction:

- `forge hooks doctor --json` must check main worktree, linked worktree, git common-dir, `core.hooksPath`, Lefthook install state, lint command availability, and agent adapter installation.
- `forge hooks install/sync` must repair worktree-local adapters without treating Lefthook as policy authority.
- `forge validate` and `forge push` should call or surface doctor status before claiming local gates are active.

### 5. Forge state can be unconfigured in new worktrees

Older Forge versions often left new worktrees without usable Forge state, making it hard to claim issues, validate process state, or continue the Forge workflow. The current release train must prove whether this still exists and repair it if it does.

Required direction:

- Add a worktree state doctor covering `.forge`, `.beads`/projection state, Kernel DB/bootstrap state, git common-dir mapping, adoption profile, and hook installation.
- Make repair commands explicit and safe.
- Add regression fixtures for old-version worktrees and fresh current-version worktrees.

### 6. Pre-merge should not become a universal standalone stage

A previous change introduced or implied a separate pre-merge stage. The intended direction is different: pre-merge checks should be part of the relevant task process and documentation flow, with task-type-specific gates rather than a universal extra top-level stage.

Required direction:

- Reconcile workflow templates so pre-merge is a gate/checkpoint embedded in existing stages, not a new mandatory stage for every task.
- Let task type/classification decide whether extra pre-merge checks are required.
- Update generated prompts, command docs, and validation tests accordingly.

### 7. Dolt remains a recurring operational pain point

Dolt/Beads compatibility has repeatedly caused setup, sync, push, worktree, and state-management friction. The long-term direction remains: Forge Kernel should use a TypeScript API-friendly authority path, with Beads/Dolt as projection/import-export compatibility rather than the core runtime path.

Required direction:

- Prioritize Kernel local authority and TS API surfaces that remove Dolt from the hot path.
- Preserve Beads import/export/projection fidelity during migration.
- Add release gates that prevent claiming Dolt is retired before parity and rollback paths exist.

### 8. Release sequencing is not explicit enough

The current backlog has many issues but not enough release-level staging. We need a probable sequence for near-term releases: what fixes must land before the next feature release, what can follow after Kernel MVP, and what depends on KnowledgeStore/hook doctor work.

Required direction:

- Add release lanes such as immediate self-hosting stability, new-project setup correctness, Kernel/TS state foundation, Knowledge/architecture capture, and team authority.
- Mark dependencies so implementation PRs do not accidentally start with downstream features.
- Keep release gates explicit: a release should fix core self-hosting friction before adding more workflow layers.

## Issue mapping summary

The amendments created from this addendum should be linked into existing roadmap children rather than a disconnected epic:

| Concern | Best parent | Why |
| --- | --- | --- |
| Generated docs/harness churn | `forge-2agy.9.7` plus hook/state dependencies | Agent/harness workflow reliability |
| New project work-folder structure | `forge-2agy.9.7` and `forge-2agy.9.3` | Skills/templates must feed Project Knowledge |
| `design.md` -> `plan.md` migration | `forge-2agy.9.3` | Knowledge indexing and work artifact naming |
| Worktree hook/lint install | `forge-2agy.9.3` / `.9.3.32` | Hook doctor and architecture capture enforcement |
| Worktree Forge state bootstrap | `forge-2agy.9.5` | Local multi-worktree state safety |
| Pre-merge as embedded gate | `forge-2agy.9.2` | Workflow taxonomy and stage model |
| Dolt hot-path removal | `forge-2agy.9.1` / `.9.6` | Storage authority and projection boundaries |
| Release version lanes | `forge-2agy.9` | Roadmap sequencing |

## Validation expectation

Before these amendments are considered ready for implementation:

1. Evaluator agents should review the issue descriptions from workflow UX, plumbing/state, release sequencing, and Knowledge/architecture perspectives.
2. Reviewers should return PASS / REQUEST_CHANGES and concrete missing issues or dependency corrections.
3. The plan and issue map should be revised until there are no critical blockers.
4. The final result should include real issue IDs and dependency notes in `issue-map.md` and a TSV traceability file.
