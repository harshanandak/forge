# Kernel Backlog, Storage, and Project Knowledge Roadmap Tasks

## Task 1: Record storage-mode boundaries

**Objective:** Make the roadmap explicit that SQLite local broker is not multi-machine authority.

**Files:**
- Modify: `docs/work/2026-04-28-skeleton-pivot/forge-kernel-authority-control-plane.md`
- Modify or add: `docs/reference/FORGE_KERNEL_STORAGE_MODEL.md`
- Test: existing docs/reference checks if present

**Steps:**
1. Add a short table: local SQLite authority, team server authority, projections, read models, archives.
2. State that team writes require serialized authority before they are supported.
3. State that local-only close/verify state is durable in SQLite and does not require committing tracker metadata to Git.
4. State that team or cross-machine close/verify state requires server acceptance.
5. State that Beads is import/export/projection, not target authority.
6. Run `bun run check`.

## Task 2: Add issue/backlog taxonomy to Kernel schema plan

**Objective:** Define backlog/sprint/story/task semantics before adding UI or code.

**Files:**
- Modify: `docs/work/2026-04-28-skeleton-pivot/forge-kernel-authority-control-plane.md`
- Modify: `lib/kernel/schema.js` only in a later implementation PR
- Test: future schema tests

**Steps (amended 2026-06-11 per accepted D18):**
1. Define issue types: epic, task, bug, decision. Represent `feature`/`story`/`chore`/`spike` as labels, not types.
2. Define stored statuses: open, in_progress, review, done, cancelled. `ready`/`blocked` are derived read-model facts computed from dependencies, blockers, claims, gates, and quarantine — never stored.
3. Define a single numeric rank as authoritative ordering; P0-P4 is a display-label projection.
4. Define release/milestone and sprint/iteration as planning buckets.
5. Keep claim lease separate from assignee/owner.

## Task 3: Design Project Knowledge Layer MVP

**Objective:** Plan a rebuildable read model over verbatim artifacts and Kernel events.

**Files:**
- Create: `docs/reference/FORGE_PROJECT_KNOWLEDGE_LAYER.md`
- Later create: `lib/kernel/knowledge-index.js`
- Later create: tests under `test/kernel/`

**Steps:**
1. Index verbatim `plan.md`, legacy `design.md`, `tasks.md`, `decisions.md`, `evidence.md`, issue bodies, comments, stage runs.
2. Add artifact metadata: issue, release, sprint, stage, source path, event id, actor, timestamp.
3. Start with FTS5/read-model style retrieval; leave vectors optional.
4. Treat summaries/facts as derived proposals with source refs.

## Task 4: Specify `forge orient` and `forge recap`

**Objective:** Turn the knowledge layer into bounded, agent-friendly context.

**Files:**
- Create: `docs/reference/FORGE_ORIENT_RECAP.md`
- Later modify: `bin/forge.js` and command handlers

**Steps:**
1. `forge orient`: bounded project/release/current-branch briefing.
2. `forge recap <issue>`: work-item scoped summary with plan/tasks/decisions/evidence links.
3. `forge knowledge search <query>`: deep retrieval path.
4. Ensure output has JSON mode for UIs/agents.

## Task 5: Prove local SQLite broker safety

**Objective:** Validate many local agents/worktrees updating Kernel state through a real SQLite transaction boundary.

**Files:**
- Create: future `test/kernel/local-concurrency.test.js`
- Create: future SQLite driver conformance tests
- Modify: broker driver once available

**Steps:**
1. Select and validate the real SQLite runtime driver.
2. Implement atomic event append, entity revision CAS, materialized update, and projection outbox enqueue in one transaction.
3. Spawn multiple processes against the same canonical git common-dir DB.
4. Exercise claim, update, comment, dependency add, stale-revision conflict, and projection outbox paths.
5. Assert idempotency keys collapse duplicate same-payload writes and reject/quarantine collisions.
6. Assert DB-level claim lease invariants allow only one active conflicting claim.
7. Add filesystem/WAL doctor checks before claiming local multi-agent safety.

## Task 6: Keep Beads projection fidelity guarded

**Objective:** Avoid losing Beads/Dolt properties before Kernel replacement is ready.

**Files:**
- Modify: `lib/adapters/beads-kernel-compat.js`
- Modify: `test/adapters/beads-kernel-compat.test.js`

**Steps:**
1. Preserve unsupported Beads fields under extension/projection metadata.
2. Keep import/export dry-run and fidelity reporting mandatory.
3. Keep rollback boundaries documented.
4. Compare ready-work/dependency behavior before retiring Beads as runtime surface.

## Task 7: Fix self-hosting lifecycle friction before expanding UX layers

**Objective:** Make Forge reliable while using Forge: no surprise generated dirty files, no missing worktree hooks, and no unconfigured Forge state in linked worktrees.

**Files:**
- Reference: `docs/work/2026-06-06-kernel-backlog-memory-roadmap/workflow-friction-amendments.md`
- Issues: `forge-2agy.9.7.7`, `forge-2agy.9.3.37`, `forge-2agy.9.5.11`
- Later modify: lifecycle commands, setup/update helpers, hook doctor, state doctor, and tests

**Steps:**
1. Reproduce push/review/verify/merge/post-merge cleanup on a clean checkout and linked worktree.
2. Identify which commands rewrite generated harness/runtime files.
3. Make generation idempotent and content-addressed where possible.
4. Add `forge hooks doctor --json` and worktree state doctor checks before claiming gates are active.
5. Add regression tests so agents do not need to stash generated files to close ordinary workflows.
6. Verify that successful `/verify` does not leave tracked `.beads` or Kernel projection metadata dirty as the expected final state.

## Task 8: Align fresh project setup and artifact naming

**Objective:** Ensure new projects and skills teach the current work-folder structure and the `plan.md` default.

**Files:**
- Issues: `forge-2agy.9.7.8`, `forge-2agy.9.3.36`, `forge-2agy.9.2.10`
- Later modify: setup templates, generated agent instructions, skills, command prompts, docs, and tests

**Steps:**
1. Audit generated instructions and skills for `design.md`, stage, and work-folder wording.
2. Teach `docs/work/<date>-<slug>/plan.md`, `tasks.md`, `decisions.md`, and evidence/validation files as the default contract.
3. Keep `design.md` only for durable architecture/product designs or legacy compatibility reads.
4. Recast pre-merge as a task-type gate/checkpoint rather than a universal top-level stage.
5. Add fresh-project fixtures and drift tests.

## Task 9: Move normal Forge operations off the Dolt hot path

**Objective:** Prioritize a TypeScript API-friendly Kernel authority path while preserving Beads/Dolt as projection/import-export compatibility.

**Files:**
- Issues: `forge-2agy.9.1.8`, plus `forge-2agy.9.1.*`, `forge-2agy.9.5.*`, and `forge-2agy.9.6.*`
- Later modify: Kernel local authority API, Beads projection adapters, migration tests, release gates

**Steps:**
1. Inventory command paths that still require Dolt for normal Forge workflow operations.
2. Define the TS API surface required to replace those paths.
3. Move `forge close` and `/verify` close-state persistence to local Kernel SQLite first, then to server authority for team mode.
4. Preserve Beads/Dolt projection fidelity and rollback boundaries during migration.
5. Add release gates that separate Dolt compatibility from Dolt authority.
6. Add a gate proving close/verify does not require a metadata-only PR or protected-branch push.

## Task 10: Define local-only and team authority close semantics

**Objective:** Make close/verify persistence explicit before more Kernel state issues land.

**Files:**
- Modify: `docs/reference/FORGE_KERNEL_STORAGE_MODEL.md`
- Later modify: local Kernel close API, server authority API, Beads/GitHub projection adapters, `/verify` command docs

**Steps:**
1. Define local-only close: accepted by the local SQLite Kernel authority, visible to local worktrees, not committed to Git by default.
2. Define team close: accepted only by serialized server authority, visible cross-machine after server acknowledgement.
3. Define projection behavior: GitHub/Linear/Beads exports happen after accepted authority writes and may fail independently.
4. Define offline behavior: team-mode close/start/stage-transition writes fail closed when the server cannot accept them.
5. Define reporting: `/verify` must say whether issue closure was local-only, server-accepted, or projection-pending.
6. Add tests preventing a return to "commit tracker metadata to protected master" as the ordinary durability path.

## Task 11: Hermes integration after Knowledge MVP

**Objective:** Add Hermes as a consumer of Forge project state, not a competing memory layer.

**Files:**
- Later create: `lib/agents/hermes.plugin.json`
- Later create: Hermes SKILL.md templates

**Steps:**
1. Feed Hermes bounded `forge orient` context.
2. Let Hermes use native memory/skills for private reasoning.
3. Record project decisions/evidence back to Forge Kernel.
4. Avoid writing into Hermes profile memory from Forge.

## Relevant Design Section Mapping

| Task | Relevant design sections |
| --- | --- |
| Task 1 | `plan.md#storage-decision`, `storage-and-concurrency-risks.md#storage-and-concurrency-risk-register`, `decisions.md#d1--sqlite-wal-is-local-authority-only` |
| Task 2 | `plan.md#issue--backlog-model`, `backlog-frontend-model.md#kernel-backlog-frontend-model`, `issue-map.md#backlog--sprint--story-taxonomy--forge-2agy92` |
| Task 3 | `plan.md#project-knowledge-layer`, `agent-memory-federation.md#agent-memory-federation-plan`, `decisions.md#d5--project-knowledge-layer-is-verbatim-first-and-rebuildable` |
| Task 4 | `plan.md#project-knowledge-layer`, `issue-map.md#orientrecap-bounded-context--forge-2agy94`, `agent-memory-federation.md#forge-as-the-shared-project-memory-layer` |
| Task 5 | `plan.md#storage-decision`, `storage-decision.md#storage-decision`, `revised-safety-gates.md#phase-b--local-broker-proof` |
| Task 6 | `storage-decision.md#boundaries`, `storage-and-concurrency-risks.md#storage-and-concurrency-risk-register`, `decisions.md#d2--beads-remains-migrationprojection-during-kernel-rollout` |
| Task 7 | `workflow-friction-amendments.md#workflow-friction-amendments`, `issue-map.md#probable-release-lanes`, `decisions.md#d11--generated-state-churn-is-release-blocking-self-hosting-friction` |
| Task 8 | `issue-map.md#fresh-project-setup-correctness--forge-2agy78`, `decisions.md#d12--fresh-forge-setup-must-teach-the-work-folder-artifact-contract`, `docs/INDEX.md#work-artifacts` |
| Task 9 | `decisions.md#d14--dolt-must-leave-the-forge-hot-path-before-the-next-reliable-self-hosting-release`, `storage-decision.md#boundaries`, `issue-map.md#kernel--typescript-state-foundation` |
| Task 10 | `docs/PROJECT_DESIGN.md#pd-20260613-authority-state-not-repo-metadata`, `docs/reference/FORGE_KERNEL_STORAGE_MODEL.md#authority-rules`, `workflow-friction-amendments.md#8-closeverify-state-cannot-live-in-protected-branch-tracker-commits` |
| Task 11 | `agent-memory-federation.md#agent-memory-federation-plan`, `plan.md#agent--hermes-federation`, `revised-safety-gates.md#phase-f--hermesprovider-integration` |
