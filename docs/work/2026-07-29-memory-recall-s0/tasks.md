# S0 automatic memory recall tasks

Issue: `36461e50-da2e-43e4-bb4a-ae58aac08591`

Tasks 1–5 are sequential RED → GREEN slices. Task 6 is the final acceptance gate and does not invent an expected RED state. Ownership transfers in task order; repeated files are touched sequentially, never concurrently. Do not begin `/dev` until the plan is approved.

## Wave 1 — trustworthy project-local retrieval

### Task 1: Enforce normalized SQL eligibility before rank

OWNS: `lib/project-memory.js`, `lib/kernel/sqlite-driver.js`, `lib/memory-recall.js`, `lib/commands/hooks.js` (prompt-recall path), `test/project-memory.test.js`, `test/kernel/sqlite-driver-memory.test.js`, `test/memory-recall.test.js`, `test/hooks-memory-recall.test.js`, `test/e2e/memory-recall-holdout.test.js`, `test/fixtures/memory-recall-holdouts.json`

What to implement:

- Return the normalized hit contract from existing `kernel_memories` fields without a migration.
- Derive a deterministic project identifier from the normalized canonical Git common-directory real path; do not invent a project UUID.
- Resolve null scope only to the current per-project store.
- Lock trust precedence: explicit `trust:confirmed`; auto-capture suggested; legacy import suggested; typed machine suggested; otherwise exact human `forge remember` string confirmed; unknown suggested.
- Lock type precedence: recognized `type:` tag, then recognized structured `value.category`, then `machine-record` for other structured values.
- Load bounded project/session seen keys in the prompt hook before search and pass them into the ranked-search API.
- Apply same-project scope, trust, suggested freshness, passed seen-key exclusions, and eligible-superseder predicates in SQL before BM25 order and the candidate limit. Post-search seen-key filtering is not sufficient.
- Suppress a record only through an eligible same-project superseder. A suggested superseder cannot suppress a confirmed record.
- Keep BM25 primary; use source/trust/updated time and `memory_id` only as deterministic secondary ordering.

TDD steps:

1. Add RED fixtures with at least 26 stronger foreign rows against the current 25-row cap.
2. Add a separate RED prompt-hook regression with at least 26 stronger already-seen rows and one unseen eligible row; prove the unseen row is currently crowded out.
3. Add RED denial-of-memory fixtures for a foreign/ineligible superseder and a suggested superseder targeting confirmed memory.
4. Add RED trust/type precedence fixtures, including explicit confirmation and `value.category`.
5. Run the focused driver, selection, hook, and end-to-end suites and capture leaked/crowded-out ids.
6. Implement the smallest normalizer and SQL eligibility predicate, then load and pass seen-key exclusions from the prompt hook before search.
7. Re-run owned suites; prove scope, trust, freshness, seen-key exclusion, and supersession occur before BM25 order/limit.
8. Commit: `feat(memory): enforce scoped recall eligibility`

Expected output: normalized ranked hits contain `memory_id/type/content/scope/trust_status/provenance-or-source-ref/updated_at`; ineligible rows cannot crowd out or erase eligible memory.

### Task 2: Preserve only project-local source metadata

OWNS: `lib/memory/router.js`, `test/memory/router.test.js`

What to implement:

- Keep project-local `kernel_memories` as S0's only automatic-recall authority.
- Preserve the current one-time project-local `.forge/memory/notes.jsonl` import.
- Retain deterministic ids/content hashes, imported provenance, suggested trust, and type metadata needed by the normalized recall path.
- Do not read, parse, import, index, or inject user-global `.remember`. Its headings lack canonical project identity; its producer change is deferred and not owned here.

TDD steps:

1. Add a baseline-green characterization proving apparently relevant `.remember` files and `unknown` headings are not read or consumed by the current router.
2. Add RED tests only for any deterministic scope/trust/type metadata that the retired project-local JSONL importer currently loses.
3. Run `test/memory/router.test.js`; retain the green non-reading characterization and capture only genuine metadata failures as RED.
4. Make the smallest project-local importer adjustment, with no `.remember` reader or producer change.
5. Re-run the suite; prove project-local import remains idempotent and the baseline-green `.remember` characterization stays green.
6. Commit: `fix(memory): preserve project-local recall metadata`

Expected output: eligible project-local imported notes are FTS5-recallable with deterministic provenance; `.remember` never reaches `kernel_memories`.

## Wave 2 — bounded reader surfaces

### Task 3: Budget and label CLI, prime, and session memory

OWNS: `lib/commands/recall.js`, `lib/orientation.js`, `lib/memory-digest.js`, `test/commands/recall.test.js`, `test/orientation-memory.test.js`, `test/memory-digest.test.js`

What to implement:

- Reuse `applyBudget` for default 1,200-token `forge recall`, 400-token SessionStart memory, and the existing bounded prime section.
- Render normalized source/trust/update metadata.
- Put suggested results in a separate verification-required block; never mix them into confirmed truth.
- Skip an oversized hit and continue packing smaller eligible hits.

TDD steps:

1. Add RED tests with many records, one oversized record, mixed trust, and exact token assertions.
2. Run the owned suites and prove current limit-only recall exceeds the budget/label contract.
3. Reuse the existing estimator/budget helper and normalized records; add no second budget implementation.
4. Re-run the suites; prove every surface remains inside budget and labels survive truncation.
5. Commit: `feat(memory): budget and label recall surfaces`

Expected output: CLI/prime/digest output is bounded, provenance-fenced, and visibly distinguishes confirmed from suggested memory.

## Wave 3 — live lifecycle reliability

### Task 4: Repair activation and bound existing lifecycle commands

OWNS: `lib/hook-renderer.js`, `lib/commands/hooks.js`, `lib/upgrade-safety.js`, `test/hook-renderer.test.js`, `test/hooks-session-start.test.js`, `test/hooks-memory-recall.test.js`, `test/hooks-capture.test.js`, `test/setup-hooks-config.test.js`, `test/commands/upgrade.test.js`

What to implement:

- Keep the existing four Claude lifecycle events and commands.
- Make upgrade self-heal detect and safely merge missing Forge-owned lifecycle groups, preserving user hooks and backing up malformed config.
- Run independent SessionStart project-local reads concurrently under an internal deadline; preserve dispatch bootstrap if memory/issue reads time out.
- Apply a bounded prompt-recall deadline and return real unsupported/fallback reasons for non-Claude harnesses.
- Preserve capture dedupe and keep captures suggested.

TDD steps:

1. Add a fixture matching the reproduced old `.claude/settings.json` and slow fetchers.
2. Run owned suites and capture RED for missing events and over-deadline behavior.
3. Extend current merge/self-heal and handler paths; add no new event or command.
4. Re-run suites plus subprocess timing fixtures; prove one copy per event, user hooks preserved, prompt hook ≤5 seconds, SessionStart ≤10 seconds, and fail-open behavior.
5. Commit: `fix(memory): activate and bound lifecycle recall`

Expected output: upgraded and fresh Claude installs have one working dynamic path; slow sources cannot consume the harness timeout.

## Wave 4 — evidence

### Task 5: Persist privacy-bounded recall telemetry

OWNS: `lib/memory-recall-events.js`, `lib/commands/hooks.js`, `test/memory-recall-events.test.js`

What to implement:

- Reuse the direct, non-projecting Kernel event append pattern for `memory.recall.observed`.
- Use the deterministic worktree-normalized project identifier, not a nonexistent UUID.
- Record bounded counts, selected ids, aggregate source/trust mix, tokens, elapsed time, harness, and outcome.
- Record `selected/empty/filtered/unsupported/timeout/error` without prompt text, normalized prompt terms, memory bodies, or snippets.
- Omit query correlation by default. If evidence requires it, use only a keyed, locally salted HMAC-style fingerprint and never persist the key/salt.

TDD steps:

1. Add RED event tests against the real Kernel event seam for all outcomes.
2. Add serialized-payload absence assertions for prompt text, meaningful terms, memory bodies/snippets, and fingerprint key/salt.
3. Confirm RED because no durable bounded Kernel outcome event exists.
4. Implement the direct best-effort event helper and call it from the existing handler.
5. Re-run the suite; prove telemetry failure never blocks injection or a prompt.
6. Commit: `feat(memory): record privacy-bounded recall evidence`

Expected output: every retrieval path leaves bounded operational evidence without storing query or memory content.

### Task 6: Run the isolation, holdout, and performance acceptance gate

OWNS: validation commands and acceptance evidence only. Product and test-file changes remain with Tasks 1–5.

What to validate:

- Run the project-local positive, confusing-neighbor, 26+ stronger foreign-row, 26+ stronger already-seen-row, superseded, stale-suggested, ineligible-superseder, suggested-over-confirmed, duplicate, oversized, disabled-rail, and Kernel-failure cases authored by Tasks 1–5.
- Prove the automatic path from project-local `forge remember` storage to Claude `additionalContext`; do not seed or consume `.remember`.
- Verify deterministic worktree-normalized identity, type/trust precedence, privacy, latency, and token budgets as one release acceptance matrix.
- Make no product or fixture changes in this gate. A failure returns to the earlier task that owns the behavior.

Acceptance steps:

1. Run the assembled holdouts against the real Kernel/FTS5/hook seams; do not claim an expected RED state.
2. If any case fails, stop the gate and return it to Task 1, 2, 3, 4, or 5 according to file/behavior ownership.
3. After all focused cases pass, run the holdouts twice on Windows and once in Linux CI.
4. Record deterministic selection/omission, in-process FTS p95 ≤250 ms on 1,000 records, and hook budgets/deadlines as acceptance evidence.
5. Add no gate-only commit unless evidence documentation is explicitly requested.

Expected output: the implicit holdout prompt selects confirmed project-local Kernel memory; stronger foreign rows cannot crowd it out and ineligible superseders cannot erase it.

## Validation handoff after approval

First `/dev` focus: Task 1, because every importer and hook must consume one scope/trust-safe normalized hit contract.

Validation priorities:

1. Owned focused suites after every task.
2. Full memory/hook/setup/upgrade suite after Wave 4.
3. `bun test`, lint, package/install fixture, and Windows/Linux timing holdouts.
4. Re-read serialized telemetry and prove it contains no prompt text/terms, memory bodies/snippets, or fingerprint key/salt.
5. Prove no foreign scope, stale suggestion, or ineligible supersession appears in automatic context.

Do not implement PostgreSQL/team ACL, lifecycle/CAS, memory event/outbox projection, Graphiti, deletion replay, Product Suite exchange, static projection, dashboards, or `.remember` producer/federation work in these tasks.
