# S0 automatic memory recall tasks

Issue: `36461e50-da2e-43e4-bb4a-ae58aac08591`

All waves are sequential. Each task is a complete RED → GREEN vertical slice. Do not begin `/dev` until the plan is approved.

## Wave 1 — trustworthy retrieval core

### Task 1: Normalize and filter existing Kernel memory before rank

OWNS: `lib/project-memory.js`, `lib/kernel/sqlite-driver.js`, `lib/memory-recall.js`, `test/project-memory.test.js`, `test/kernel/sqlite-driver-memory.test.js`, `test/memory-recall.test.js`

What to implement:

- Return the normalized hit contract from existing `kernel_memories` fields without a migration.
- Resolve implicit null scope only to the current per-project store.
- Derive confirmed/suggested trust from `source_agent` plus existing explicit tags.
- Exclude foreign scope, stale suggested records, and ids named by active `supersedes` metadata before ranking/injection.
- Keep BM25 primary; use trust/source/updated time and `memory_id` only as deterministic secondary ordering.

TDD steps:

1. Write failing tests where a foreign-scope, superseded, stale-suggested, and strong-but-ineligible row currently appears.
2. Run the three owned suites and confirm RED assertions identify the leaked memory ids.
3. Implement the smallest filter/normalizer in the existing driver/facade/selection path.
4. Run the owned suites and confirm eligible normalized results pass while every leak stays absent.
5. Commit: `feat(memory): enforce scoped trusted recall hits`

Expected output: ranked hits contain `memory_id/type/content/scope/trust_status/provenance-or-source-ref/updated_at`; ineligible rows are absent before packing.

### Task 2: Federate only safely scoped existing sources

OWNS: `lib/memory/router.js`, `test/memory/router.test.js`

What to implement:

- Preserve the current project-local JSONL one-time import.
- Add a bounded import of `.remember/now.md` and `.remember/recent.md` through the existing router and `kernel_memories`; do not read raw logs.
- Require a current-project/worktree-parent slug in each source section. Skip `unknown`, blank, or foreign projects.
- Use deterministic `kernel_memories.key` values and existing source/tags/supersedes fields. Mark imported `.remember` material suggested.

TDD steps:

1. Write a temp-home fixture containing same-project, foreign-project, and `unknown` summary sections; show that no current importer makes the same-project record recallable.
2. Run `test/memory/router.test.js`; confirm the same-project expectation fails.
3. Extend the existing import path with bounded summary parsing and deterministic upserts.
4. Re-run the suite; confirm only the same-project record is indexed, repeated import is idempotent, and raw logs are untouched.
5. Commit: `feat(memory): ingest scoped remember summaries`

Expected output: eligible source summaries are FTS5-recallable with source refs; foreign/unscoped content never reaches `kernel_memories`.

## Wave 2 — bounded reader surfaces

### Task 3: Budget and label CLI, prime, and session memory

OWNS: `lib/commands/recall.js`, `lib/orientation.js`, `lib/memory-digest.js`, `test/commands/recall.test.js`, `test/orientation-memory.test.js`, `test/memory-digest.test.js`

What to implement:

- Reuse `applyBudget` for default 1,200-token `forge recall`, 400-token SessionStart memory, and the existing bounded prime section.
- Render normalized source/trust/update metadata.
- Put suggested results in a separate verification-required block; never mix them into confirmed truth.
- Skip an oversized hit and continue packing smaller eligible hits.

TDD steps:

1. Add failing tests with many records, one oversized record, mixed trust, and exact token assertions.
2. Run the owned suites and confirm current limit-only recall exceeds the new budget/label contract.
3. Reuse the existing estimator/budget helper and normalized records; add no second budget implementation.
4. Re-run the suites; confirm every surface remains inside its budget and trust/provenance labels survive truncation.
5. Commit: `feat(memory): budget and label recall surfaces`

Expected output: CLI/prime/digest output is bounded, provenance-fenced, and visibly distinguishes confirmed from suggested memory.

## Wave 3 — live lifecycle reliability and evidence

### Task 4: Repair activation and bound the existing lifecycle commands

OWNS: `lib/hook-renderer.js`, `lib/commands/hooks.js`, `lib/upgrade-safety.js`, `test/hook-renderer.test.js`, `test/hooks-session-start.test.js`, `test/hooks-memory-recall.test.js`, `test/hooks-capture.test.js`, `test/setup-hooks-config.test.js`, `test/commands/upgrade.test.js`

What to implement:

- Keep the existing four Claude lifecycle events and commands.
- Make upgrade self-heal detect and safely merge missing Forge-owned lifecycle groups, preserving user hooks and backing up malformed config.
- Run independent SessionStart reads concurrently under an internal deadline; preserve the dispatch bootstrap if memory/issue reads time out.
- Apply a bounded prompt-recall deadline and return the real unsupported/fallback reason for non-Claude harnesses.
- Preserve current capture dedupe and make captures suggested.

TDD steps:

1. Add a fixture matching the reproduced old `.claude/settings.json` and slow fetchers; confirm missing events and over-deadline behavior fail.
2. Run the owned suites and capture RED evidence.
3. Extend the current merge/self-heal and handler paths; add no new event or command.
4. Re-run the suites plus subprocess timing fixtures; confirm one copy per event, user hooks preserved, prompt hook ≤5 s, SessionStart ≤10 s, and fail-open behavior.
5. Commit: `fix(memory): activate and bound lifecycle recall`

Expected output: upgraded and fresh Claude installs have one working dynamic path; slow sources cannot consume the harness timeout.

### Task 5: Persist privacy-bounded recall evidence and lock holdouts

OWNS: `lib/memory-recall-events.js`, `lib/commands/hooks.js`, `test/memory-recall-events.test.js`, `test/e2e/memory-recall-holdout.test.js`, `test/fixtures/memory-recall-holdouts.json`

What to implement:

- Reuse the direct, non-projecting Kernel event append pattern for `memory.recall.observed`.
- Record bounded counts, selected ids, source/trust mix, tokens, elapsed time, harness, outcome, and redacted query fingerprint.
- Record `selected/empty/filtered/unsupported/timeout/error` without storing raw prompts or memory bodies.
- Add positive, confusing-neighbor, foreign-scope, superseded, stale-suggested, duplicate, oversized, disabled-rail, and kernel-failure holdouts.

TDD steps:

1. Write failing event and end-to-end holdout tests against the real Kernel/FTS5/hook seams.
2. Confirm RED: current shadow JSONL has no durable Kernel outcome event and the full isolation matrix is absent.
3. Implement the direct event helper and call it best-effort from the existing handler.
4. Run holdouts twice on Windows and once in the Linux CI lane; confirm deterministic selection/omission, no raw content in events, in-process FTS p95 ≤250 ms on 1,000 records, and hook budgets/deadlines.
5. Commit: `test(memory): prove automatic recall and telemetry`

Expected output: the same implicit holdout prompt selects the confirmed project memory; negative cases stay quiet; every path leaves bounded evidence.

## Validation handoff after approval

First `/dev` focus: Task 1, because every importer and hook must consume one scope/trust-safe normalized hit contract.

Validation priorities:

1. Owned focused suites after every task.
2. Full memory/hook/setup/upgrade suite after Wave 3.
3. `bun test`, lint, package/install fixture, Windows/Linux timing holdouts.
4. Re-read telemetry and verify no prompt/body content, foreign scope, stale suggestion, or superseded id was emitted.

Do not implement PostgreSQL/team ACL, lifecycle/CAS, memory event/outbox projection, Graphiti, deletion replay, Product Suite exchange, static projection, or dashboards in these tasks.
