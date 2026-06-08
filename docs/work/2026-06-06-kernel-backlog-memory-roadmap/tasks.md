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
3. State that Beads is import/export/projection, not target authority.
4. Run `bun run check`.

## Task 2: Add issue/backlog taxonomy to Kernel schema plan

**Objective:** Define backlog/sprint/story/task semantics before adding UI or code.

**Files:**
- Modify: `docs/work/2026-04-28-skeleton-pivot/forge-kernel-authority-control-plane.md`
- Modify: `lib/kernel/schema.js` only in a later implementation PR
- Test: future schema tests

**Steps:**
1. Define issue types: epic, feature, story, task, bug, chore, decision, spike.
2. Define statuses: backlog, ready, in_progress, blocked, review, done, cancelled.
3. Define release/milestone and sprint/iteration as planning buckets.
4. Keep claim lease separate from assignee/owner.

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

## Task 7: Hermes integration after Knowledge MVP

**Objective:** Add Hermes as a consumer of Forge project state, not a competing memory layer.

**Files:**
- Later create: `lib/agents/hermes.plugin.json`
- Later create: Hermes SKILL.md templates

**Steps:**
1. Feed Hermes bounded `forge orient` context.
2. Let Hermes use native memory/skills for private reasoning.
3. Record project decisions/evidence back to Forge Kernel.
4. Avoid writing into Hermes profile memory from Forge.
